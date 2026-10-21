// Cursor's ACP permission requests are reviewed in separate subscription sessions.
// The user authorized sharing task instructions, rules, refusals and the action.
import { randomUUID } from "node:crypto";
import { agentInstructions } from "./history.mjs";
import { readRepositoryFile } from "./repository.mjs";
import { readRules } from "./rules.mjs";
import { cursorReviewer, parseReview } from "./review-policy.mjs";

export class CursorReviewer {
  constructor({ controller, run, project, chat, text, signal }) {
    Object.assign(this, { controller, run, project, chat, text, signal });
    this.queue = Promise.resolve();
    this.unavailable = new Map();
  }
  review(request) {
    // Parallel ACP requests still get individual decisions, in request order.
    const result = this.queue.then(() => this.decide(request));
    this.queue = result.catch(() => {});
    return result;
  }
  async context(request) {
    const { controller, project, chat } = this;
    if (!request.details)
      throw new Error("Cursor did not provide the exact action for review.");
    let projectRules = "";
    try {
      projectRules = (await readRepositoryFile(project.path, "AGENTS.md"))
        .content;
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error("Project instructions could not be read for review.");
    }
    const userRefusals = controller.store.db
      .prepare(
        "SELECT request,response,created_at FROM approvals WHERE conversation_id=? AND status='resolved' ORDER BY rowid DESC LIMIT 12",
      )
      .all(chat.id)
      .map((row) => ({
        request: JSON.parse(row.request),
        response: JSON.parse(row.response),
        createdAt: row.created_at,
      }))
      .filter(
        (row) =>
          row.request.kind !== "question" && row.response.allow === false,
      )
      .map(({ request, createdAt }) => ({ request, createdAt }));
    const task = JSON.stringify({
      hostPolicies: agentInstructions(project, chat),
      standingInstructions: readRules(controller.store).instructions,
      turnInstructions: this.instructions ?? "",
      projectRules,
      userMessages: controller.store
        .messages(chat.id)
        .filter((m) => m.role === "user")
        .slice(-8)
        .map((m) => ({ content: m.content, createdAt: m.created_at })),
      currentRequest: this.text,
      userRefusals,
      proposedAction: request,
    });
    // An approval must never be based on an action or instructions cut in half.
    if (task.length > 64000)
      throw new Error(
        "The complete action and context are too large for automatic review.",
      );
    return task;
  }
  async attempt(reviewer, task) {
    const { controller, signal } = this,
      limit = new AbortController(),
      stop = () => limit.abort();
    let timer, onStopped;
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (signal.aborted) throw new Error("The turn was stopped.");
      const stopped = new Promise((_, reject) => {
        onStopped = () =>
          reject(
            new Error(
              signal.aborted
                ? "The turn was stopped."
                : "The reviewer timed out.",
            ),
          );
        limit.signal.addEventListener("abort", onStopped, { once: true });
      });
      timer = setTimeout(stop, controller.reviewerTimeoutMs);
      return await Promise.race([
        controller.workers[reviewer.provider]({
          cwd: this.project.path,
          model: reviewer.model,
          effort: reviewer.effort,
          mode: "review",
          task,
          signal: limit.signal,
        }),
        stopped,
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (onStopped) limit.signal.removeEventListener("abort", onStopped);
      limit.abort();
    }
  }
  async decide(request) {
    const { controller, run, chat, signal } = this,
      id = randomUUID(),
      note = (status, title, reason, extra = {}) =>
        controller.event(chat.id, run.id, "work", {
          kind: "permission-review",
          provider: "cursor",
          status,
          item: { id, title, description: reason },
          ...extra,
        });
    if (signal.aborted)
      return { decision: "deny", reason: "The turn was stopped." };
    try {
      const settings = readRules(controller.store).review,
        candidates = ["codex", ...(settings.claudeFallback ? ["claude"] : [])],
        task = await this.context(request),
        reasons = [];
      for (const provider of candidates) {
        if (signal.aborted) throw new Error("The turn was stopped.");
        try {
          if (this.unavailable.has(provider))
            throw new Error(this.unavailable.get(provider));
          const reviewer = cursorReviewer(
            controller.providers,
            settings[provider],
            provider,
          );
          note(
            "running",
            "Auto-reviewing Cursor action",
            `${reviewer.name}: ${request.title}`,
            { reviewer },
          );
          const result = await this.attempt(reviewer, task);
          if (signal.aborted) throw new Error("The turn was stopped.");
          const decision = parseReview(result.text),
            label = {
              allow: "allowed",
              deny: "declined",
              ask: "needs your input for",
            }[decision.decision];
          note(
            decision.decision,
            `Auto-review ${label} Cursor action`,
            decision.reason,
            {
              reviewer,
              decision: decision.decision,
              usage: result.usage,
            },
          );
          // A valid deny or ask is final. Fallback is only for failed reviews.
          return decision;
        } catch (error) {
          if (signal.aborted) throw error;
          if (error.unavailable) this.unavailable.set(provider, error.message);
          const name = provider === "codex" ? "Codex" : "Claude Code";
          reasons.push(`${name}: ${error.message}`);
          note("fallback", `${name} could not review`, error.message);
        }
      }
      throw new Error(reasons.join(" "));
    } catch (error) {
      if (signal.aborted) {
        note(
          "cancelled",
          "Auto-review stopped",
          "The turn or permission mode changed.",
        );
        return { decision: "deny", reason: "The turn was stopped." };
      }
      note("ask", "Auto-review needs your input", error.message);
      return { decision: "ask", reason: error.message };
    }
  }
}
