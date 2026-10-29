// In Auto-review, every permission request — Cursor's, Claude Code's, Codex's,
// and every agent's browser actions — is reviewed in a separate subscription
// session. The reviewer asks the user only for a managerial choice.
// The user authorized sharing task instructions, rules, refusals, the agent's
// recent actions this turn and the action under review.
import { randomUUID } from "node:crypto";
import { agentInstructions, textHash } from "./history.mjs";
import { readRepositoryFile } from "./repository.mjs";
import { readRules } from "./rules.mjs";
import { ASK_INSTRUCTIONS } from "./modes.mjs";
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
    this.sessions = new Map();
    this.policyCache = null;
  }
  async close() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map((session) => session.close().catch(() => {})),
    );
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
  async policies() {
    if (this.policyCache) return this.policyCache;
    const { project, chat } = this;
    let projectRules = "";
    try {
      projectRules = (await readRepositoryFile(project.path, "AGENTS.md"))
        .content;
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error("Project instructions could not be read for review.");
    }
    const policies = {
      host: agentInstructions(project, chat),
      standing: readRules(this.controller.store).instructions,
      project: projectRules,
      mode: chat.mode === "ask" ? ASK_INSTRUCTIONS : chat.mode,
    };
    this.policyCache = {
      policies,
      policyHash: textHash(JSON.stringify(policies)),
    };
    return this.policyCache;
  }
  clipUserMessages() {
    return this.controller.store
      .messages(this.chat.id)
      .filter((m) => m.role === "user")
      .slice(-4)
      .map((m) => {
        const content = String(m.content ?? "");
        return {
          content: content.slice(0, 2000),
          createdAt: m.created_at,
          ...(content.length > 2000 && { truncated: true }),
        };
      });
  }
  async packet(request) {
    if (!request.details)
      throw new Error("The agent did not provide the exact action for review.");
    const { policies, policyHash } = await this.policies();
    const requestText = String(this.text ?? "");
    const action = {
      agent: agentNames[this.run.provider] ?? this.run.provider,
      userMessages: this.clipUserMessages(),
      currentRequest:
        requestText.length > 2000 ? requestText.slice(0, 2000) : requestText,
      ...(requestText.length > 2000 && { currentRequestTruncated: true }),
      userRefusals: this.userRefusals(),
      recentSteps: this.recentSteps(request),
      proposedAction: request,
    };
    const initial = JSON.stringify({ ...action, policies });
    const followUp = JSON.stringify({ ...action, policyHash });
    // An approval must never be based on an action or instructions cut in half.
    if (initial.length > 64000 || followUp.length > 64000)
      throw new Error(
        "The complete action and context are too large for automatic review.",
      );
    return { initial, followUp };
  }
  async oneShot(reviewer, task) {
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
  async attempt(reviewer, packet) {
    const opener = this.controller.openReviewer;
    if (typeof opener !== "function")
      return this.oneShot(reviewer, packet.initial);
    const opened = this.sessions.has(reviewer.provider);
    let session = this.sessions.get(reviewer.provider);
    if (!session) {
      session = await opener({
        provider: reviewer.provider,
        cwd: this.project.path,
        model: reviewer.model,
        effort: reviewer.effort,
        signal: this.signal,
      });
      this.sessions.set(reviewer.provider, session);
    }
    const limit = new AbortController(),
      stop = () => limit.abort();
    this.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, this.controller.reviewerTimeoutMs);
    try {
      if (this.signal.aborted) throw new Error("The turn was stopped.");
      return await session.ask(
        opened ? packet.followUp : packet.initial,
        limit.signal,
      );
    } catch (error) {
      await session.close().catch(() => {});
      this.sessions.delete(reviewer.provider);
      throw error;
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", stop);
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
        packet = await this.packet(request),
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
          const result = await this.attempt(reviewer, packet);
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
      const reason = `Declined because automatic review could not complete (${error.message}). Continue other authorized work; do not ask the user to approve this technical action.`;
      note("deny", "Auto-review declined: review could not complete", reason, {
        decision: "deny",
        reviewFailed: true,
      });
      return { decision: "deny", reason };
    }
  }
}
