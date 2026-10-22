// In Auto-review, Cursor's ACP permission requests and every agent's browser
// actions are reviewed in separate subscription sessions.
// The user authorized sharing task instructions, rules, refusals, the agent's
// recent actions this turn and the action under review.
import { randomUUID } from "node:crypto";
import { agentInstructions } from "./history.mjs";
import { readRepositoryFile } from "./repository.mjs";
import { readRules } from "./rules.mjs";
import {
  cursorReviewer,
  parseReview,
  readOnlyGitCommand,
} from "./review-policy.mjs";
import { applyWork } from "./steps.mjs";

const agentNames = { cursor: "Cursor", codex: "Codex", claude: "Claude Code" };
const clip = (text, length) =>
  text.length > length ? text.slice(0, length - 1) + "…" : text;

export class ActionReviewer {
  constructor({ controller, run, project, chat, text, signal }) {
    Object.assign(this, { controller, run, project, chat, text, signal });
    this.queue = Promise.resolve();
    this.unavailable = new Map();
  }
  review(request) {
    // Parallel requests still get individual decisions, in request order.
    const result = this.queue.then(() => this.decide(request));
    this.queue = result.catch(() => {});
    return result;
  }
  // The agent's earlier actions this turn, so a step is judged by what it is
  // part of. Only actions, never the agent's prose, which could argue its case.
  recentSteps(request) {
    if (this.run.provider !== "cursor") return this.workSteps();
    const calls = new Map();
    for (const row of this.controller.store.db
      .prepare(
        "SELECT payload FROM events WHERE run_id=? AND type='work' AND json_extract(payload,'$.kind') IN ('tool_call','tool_call_update') ORDER BY id",
      )
      .all(this.run.id)) {
      const item = JSON.parse(row.payload).item ?? {},
        id = item.toolCallId;
      if (!id || id === request.details?.toolCallId) continue;
      const step = calls.get(id) ?? {};
      calls.delete(id);
      if (item.title && item.title !== "MCP: tool") step.title = item.title;
      if (item.kind) step.kind = item.kind;
      if (item.status) step.status = item.status;
      if (item.rawInput && Object.keys(item.rawInput).length)
        step.input = item.rawInput;
      calls.set(id, step);
    }
    return [...calls.values()]
      .filter((step) => step.title)
      .slice(-15)
      .map(({ title, kind, status, input }) => ({
        title: clip(title, 200),
        kind,
        status,
        ...(input && { input: clip(JSON.stringify(input), 300) }),
      }));
  }
  // Codex and Claude work, as the chat's step list shows it. Browser actions
  // come from Harness's own record, which names what each one acted on.
  workSteps() {
    let steps = [];
    for (const row of this.controller.store.db
      .prepare(
        "SELECT id, payload FROM events WHERE run_id=? AND type='work' ORDER BY id",
      )
      .all(this.run.id)) {
      const p = JSON.parse(row.payload);
      steps =
        p.kind === "browser-tool"
          ? [
              ...steps,
              {
                id: "browser:" + row.id,
                verb: "browse",
                target: p.item?.title,
                status: "ok",
              },
            ]
          : applyWork(steps, p);
    }
    return steps
      .filter(
        (s) =>
          s.target &&
          !s.id.startsWith("review:") &&
          !/^(mcp__harness__)?browser_/.test(s.target),
      )
      .slice(-15)
      .map(({ verb, target, status }) => ({
        verb,
        target: clip(String(target), 200),
        status,
      }));
  }
  userRefusals() {
    return this.controller.store.db
      .prepare(
        "SELECT request,response,created_at FROM approvals WHERE conversation_id=? AND status='resolved' ORDER BY rowid DESC LIMIT 12",
      )
      .all(this.chat.id)
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
  }
  async context(request) {
    const { controller, project, chat } = this;
    if (!request.details)
      throw new Error("The agent did not provide the exact action for review.");
    let projectRules = "";
    try {
      projectRules = (await readRepositoryFile(project.path, "AGENTS.md"))
        .content;
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error("Project instructions could not be read for review.");
    }
    const userRefusals = this.userRefusals();
    const task = JSON.stringify({
      agent: agentNames[this.run.provider] ?? this.run.provider,
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
      recentSteps: this.recentSteps(request),
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
      agent = agentNames[run.provider] ?? run.provider,
      id = randomUUID(),
      note = (status, title, reason, extra = {}) =>
        controller.event(chat.id, run.id, "work", {
          kind: "permission-review",
          provider: run.provider,
          status,
          item: { id, title, description: reason },
          ...extra,
        });
    if (signal.aborted)
      return { decision: "deny", reason: "The turn was stopped." };
    // A refusal from the user could cover even a read, so it goes to review.
    if (readOnlyGitCommand(request) && !this.userRefusals().length) {
      const reason = "Read-only Git command; allowed without a model review.";
      note("allow", `Auto-review allowed ${agent} action`, reason, {
        decision: "allow",
      });
      return { decision: "allow", reason };
    }
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
            `Auto-reviewing ${agent} action`,
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
            `Auto-review ${label} ${agent} action`,
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
