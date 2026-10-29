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

const failure = (category, message) =>
  Object.assign(new Error(message), { category });
function failureCategory(error) {
  if (error.category) return error.category;
  const message = error.message ?? "";
  if (/exhausted|usage limit|usage boundary/i.test(message)) return "quota";
  if (/sign in|authentication|unauthorized|\b401\b|\b403\b/i.test(message))
    return "authentication";
  if (error.unavailable) return "unavailable";
  if (/invalid decision|without a decision/i.test(message))
    return "invalid_output";
  if (/timed out/i.test(message)) return "timeout";
  if (
    /session ended|connection.*closed|agent exited|socket|ECONNRESET|EPIPE|ETIMEDOUT|fetch failed/i.test(
      message,
    ) ||
    ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED"].includes(error.code)
  )
    return "transport";
  return "provider_error";
}

// Race even an adapter that ignores cancellation. A late result cannot decide
// an action, and onAbort closes any session still starting or answering.
async function bounded(operation, signal, timeoutMs, onAbort = () => {}) {
  const limit = new AbortController();
  let timer, rejectStopped;
  const stop = () => {
    rejectStopped(
      signal.aborted
        ? failure("cancelled", "The turn was stopped.")
        : failure("timeout", "The reviewer timed out."),
    );
    limit.abort();
    onAbort();
  };
  const stopped = new Promise((_, reject) => {
    rejectStopped = reject;
  });
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) throw failure("cancelled", "The turn was stopped.");
    if (timeoutMs <= 0)
      throw failure(
        "deadline",
        "The automatic review time budget was exhausted.",
      );
    timer = setTimeout(stop, timeoutMs);
    return await Promise.race([
      Promise.resolve().then(() => operation(limit.signal)),
      stopped,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

export class ActionReviewer {
  constructor({ controller, run, project, chat, text, signal }) {
    Object.assign(this, { controller, run, project, chat, text, signal });
    this.queue = Promise.resolve();
    this.unavailable = new Map();
    this.sessions = new Map();
  }
  async close() {
    for (const provider of [...this.sessions.keys()]) this.discard(provider);
  }
  discard(provider) {
    const entry = this.sessions.get(provider);
    if (!entry) return;
    this.sessions.delete(provider);
    this.signal.removeEventListener("abort", entry.stop);
    entry.lifetime.abort();
    // Cleanup must not turn a failed review into an unbounded wait.
    try {
      Promise.resolve(entry.session?.close()).catch(() => {});
    } catch {}
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
    const { project, chat } = this;
    let projectRules = "";
    try {
      projectRules = (await readRepositoryFile(project.path, "AGENTS.md"))
        .content;
    } catch (error) {
      if (error.code !== "ENOENT")
        throw failure(
          "context",
          "Project instructions could not be read for review.",
        );
    }
    const policies = {
      host: agentInstructions(project, chat),
      standing: readRules(this.controller.store).instructions,
      project: projectRules,
      mode: chat.mode === "ask" ? ASK_INSTRUCTIONS : chat.mode,
    };
    return {
      policies,
      policyHash: textHash(JSON.stringify(policies)),
    };
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
      throw failure(
        "context",
        "The agent did not provide the exact action for review.",
      );
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
      throw failure(
        "context",
        "The complete action and context are too large for automatic review.",
      );
    return { initial, followUp, policyHash };
  }
  async attempt(reviewer, packet, timeoutMs) {
    const { controller, signal } = this;
    try {
      return await bounded(
        async (attemptSignal) => {
          if (signal.aborted || attemptSignal.aborted)
            throw failure("cancelled", "The turn was stopped.");
          if (typeof controller.openReviewer !== "function")
            return controller.workers[reviewer.provider]({
              cwd: this.project.path,
              model: reviewer.model,
              effort: reviewer.effort,
              mode: "review",
              task: packet.initial,
              signal: attemptSignal,
            });
          const key = JSON.stringify([
            reviewer.model,
            reviewer.effort,
            packet.policyHash,
          ]);
          let entry = this.sessions.get(reviewer.provider);
          if (entry && entry.key !== key) {
            this.discard(reviewer.provider);
            entry = null;
          }
          const opened = !!entry;
          if (!entry) {
            const lifetime = new AbortController(),
              stop = () => lifetime.abort();
            entry = { key, lifetime, stop, session: null };
            this.sessions.set(reviewer.provider, entry);
            signal.addEventListener("abort", stop, { once: true });
            const session = await controller.openReviewer({
              provider: reviewer.provider,
              cwd: this.project.path,
              model: reviewer.model,
              effort: reviewer.effort,
              signal: lifetime.signal,
            });
            if (lifetime.signal.aborted || attemptSignal.aborted) {
              try {
                Promise.resolve(session.close()).catch(() => {});
              } catch {}
              throw failure("cancelled", "The review session was cancelled.");
            }
            entry.session = session;
          }
          return entry.session.ask(
            opened ? packet.followUp : packet.initial,
            attemptSignal,
          );
        },
        signal,
        timeoutMs,
        () => this.discard(reviewer.provider),
      );
    } catch (error) {
      this.discard(reviewer.provider);
      throw error;
    }
  }
  async decide(request) {
    const { controller, run, chat, signal } = this,
      agent = agentNames[run.provider] ?? run.provider,
      id = randomUUID(),
      startedAt = Date.now(),
      deadline = startedAt + controller.reviewerTotalTimeoutMs,
      note = (status, title, reason, extra = {}) =>
        controller.event(chat.id, run.id, "work", {
          kind: "permission-review",
          provider: run.provider,
          status,
          item: { id, title, description: reason },
          elapsedMs: Date.now() - startedAt,
          ...extra,
        });
    if (signal.aborted)
      return { decision: "deny", reason: "The turn was stopped." };
    try {
      // A refusal from the user could cover even a read, so it goes to review.
      if (readOnlyGitCommand(request) && !this.userRefusals().length) {
        const reason = "Read-only Git command; allowed without a model review.";
        note("allow", `Auto-review allowed ${agent} action`, reason, {
          decision: "allow",
        });
        return { decision: "allow", reason };
      }
      const settings = readRules(controller.store).review,
        candidates = ["codex", ...(settings.claudeFallback ? ["claude"] : [])],
        packet = await bounded(
          () => this.packet(request),
          signal,
          deadline - Date.now(),
        ),
        reasons = [],
        retryable = [];
      let attempts = 0,
        retried = false,
        lastFailure;
      // One pass through configured providers, then one fresh-session retry
      // total. A valid decision is final, including a managerial ask.
      for (let index = 0; index < candidates.length; index++) {
        const provider = candidates[index];
        if (signal.aborted) throw new Error("The turn was stopped.");
        if (Date.now() >= deadline)
          throw failure(
            "deadline",
            "The automatic review time budget was exhausted.",
          );
        let reviewer;
        const catalog = controller.providers.find((p) => p.id === provider);
        const availabilityKey = JSON.stringify([
          settings[provider],
          catalog?.connected,
          catalog?.blockReason,
          catalog?.models,
        ]);
        const attemptStartedAt = Date.now();
        try {
          const cached = this.unavailable.get(provider);
          if (cached?.key === availabilityKey) throw cached.error;
          try {
            reviewer = cursorReviewer(
              controller.providers,
              settings[provider],
              provider,
            );
          } catch (error) {
            error.category =
              failureCategory(error) === "quota" ? "quota" : "unavailable";
            error.unavailable = true;
            throw error;
          }
          attempts++;
          note(
            "running",
            `Auto-reviewing ${agent} action`,
            `${reviewer.name}: ${request.title}`,
            { reviewer, attempt: attempts },
          );
          const result = await this.attempt(
            reviewer,
            packet,
            Math.min(controller.reviewerTimeoutMs, deadline - Date.now()),
          );
          if (signal.aborted) throw new Error("The turn was stopped.");
          if (Date.now() >= deadline)
            throw failure(
              "deadline",
              "The automatic review time budget was exhausted.",
            );
          const decision = parseReview(result?.text),
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
              attempt: attempts,
              durationMs: Date.now() - attemptStartedAt,
              recovered: reasons.length > 0,
            },
          );
          // A valid deny or ask is final. Fallback is only for failed reviews.
          return decision;
        } catch (error) {
          if (signal.aborted) throw error;
          this.discard(provider);
          const category = failureCategory(error);
          lastFailure = error;
          if (
            error.unavailable ||
            ["quota", "authentication"].includes(category)
          )
            this.unavailable.set(provider, { error, key: availabilityKey });
          if (
            !error.unavailable &&
            ["transport", "timeout", "invalid_output"].includes(category)
          )
            retryable.push(provider);
          const name = provider === "codex" ? "Codex" : "Claude Code";
          reasons.push(`${name}: ${error.message}`);
          note("fallback", `${name} could not review`, error.message, {
            reviewer,
            reviewerProvider: provider,
            failureCategory: category,
            attempt: attempts,
            durationMs: Date.now() - attemptStartedAt,
          });
        }
        if (index === candidates.length - 1 && !retried && retryable.length) {
          retried = true;
          candidates.push(retryable[0]);
        }
      }
      throw failure(failureCategory(lastFailure), reasons.join(" "));
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
        failureCategory: failureCategory(error),
      });
      return { decision: "deny", reason };
    }
  }
}
