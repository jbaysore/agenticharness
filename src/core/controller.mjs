import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inspectCodex, runCodex } from "../providers/codex.mjs";
import { inspectClaude, runClaude } from "../providers/claude.mjs";
import { inspectCursor, runCursor } from "../providers/cursor.mjs";
import {
  agentInstructions,
  handoffContext,
  historyCall,
  historyTools,
  workspaceNotice,
  workspacePeers,
} from "./history.mjs";
import { repositoryState } from "./repository.mjs";
import {
  delegateTool,
  delegationStats,
  planWorkers,
  readRules,
  recordDelegation,
  rulesInstructions,
  workerName,
} from "./rules.mjs";
import { runClaudeWorker, runCodexWorker } from "../providers/workers.mjs";

const MAX_DELEGATIONS = 12,
  MAX_PARALLEL_DELEGATIONS = 3;

export class Controller extends EventEmitter {
  constructor(store, { probePath, bridgeUrl }) {
    super();
    this.store = store;
    this.probePath = probePath;
    this.bridgeUrl = bridgeUrl;
    this.providers = [];
    this.active = new Map();
    this.approvalWaiters = new Map();
    this.bridgeTokens = new Map();
    this.runners = { codex: runCodex, claude: runClaude, cursor: runCursor };
    this.workers = { claude: runClaudeWorker, codex: runCodexWorker };
    this.workerTimeoutMs = 5 * 60 * 1000;
    store.recover();
  }
  event(chatId, runId, type, payload) {
    const e = this.store.appendEvent(chatId, runId, type, payload);
    this.emit("event", e);
    return e;
  }
  async refreshProviders() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const functions = [
        () => inspectCodex(this.probePath),
        () => inspectClaude(this.probePath),
        () =>
          inspectCursor(this.probePath, this.store.setting("cursor-billing")),
      ];
      const ids = ["codex", "claude", "cursor"],
        names = ["Codex", "Claude Code", "Cursor"];
      const settled = await Promise.allSettled(functions.map((fn) => fn()));
      this.providers = settled.map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : {
              id: ids[i],
              name: names[i],
              connected: false,
              models: [],
              blockReason: r.reason.message,
              usage: { authoritative: false, windows: [] },
            },
      );
      this.event(null, null, "providers", { providers: this.providers });
      return this.providers;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  send(chatId, { actionId, text, provider, model, effort }) {
    const chat = this.store.conversation(chatId);
    if (!chat) throw new Error("Conversation not found");
    if (typeof text !== "string" || !text.trim() || text.length > 250000)
      throw new Error("Enter a message under 250,000 characters");
    if (typeof actionId !== "string" || !/^[-\w]{16,100}$/.test(actionId))
      throw new Error("A stable action ID is required");
    if (!["codex", "claude", "cursor"].includes(provider))
      throw new Error("Unknown agent");
    const prior = this.store.runForAction(actionId);
    if (prior) {
      if (prior.conversation_id !== chatId)
        throw new Error("Action ID belongs to another conversation");
      return { ...prior, duplicate: true };
    }
    if (this.active.has(chatId))
      throw new Error("This chat already has active work");
    const selected = this.providers.find((p) => p.id === provider);
    if (!selected) throw new Error("Refresh provider connections first");
    if (selected.blockReason) throw new Error(selected.blockReason);
    const selectedModel = selected.models.find((m) => m.id === model);
    if (!selectedModel || selectedModel.disabled)
      throw new Error("Select an available model");
    if (effort && !selectedModel.efforts.includes(effort))
      throw new Error("The selected model does not expose that effort setting");
    const run = this.store.createRun({
      conversationId: chatId,
      actionId,
      provider,
      model,
      text: text.trim(),
    });
    const abort = new AbortController();
    this.active.set(chatId, { run, abort });
    if (chat.archived_at) this.store.setArchived(chatId, false);
    this.store.updateConversation(chatId, {
      provider,
      model,
      effort: effort || null,
    });
    this.event(chatId, run.id, "run", { status: "starting", provider, model });
    const task = this.execute(run, text.trim(), effort, abort).catch(
      (error) => {
        this.event(chatId, run.id, "error", { message: error.message });
      },
    );
    this.active.get(chatId).task = task;
    return run;
  }
  async execute(run, text, effort, abort) {
    const chat = this.store.conversation(run.conversation_id),
      project = this.store.project(chat.project_id),
      messageMap = new Map();
    let actualModel =
      this.providers
        .find((p) => p.id === run.provider)
        ?.models.find((m) => m.id === run.model)?.resolvedModel ?? run.model;
    const token = randomBytes(32).toString("base64url");
    this.bridgeTokens.set(token, chat.id);
    let status = "failed",
      error;
    const emit = (type, payload) => {
      if (type === "nativeModel" && typeof payload.model === "string")
        actualModel = payload.model;
      if (type === "text") {
        let id = messageMap.get(payload.nativeId);
        if (!id) {
          id = this.store.addMessage({
            conversationId: chat.id,
            runId: run.id,
            role: "assistant",
            provider: run.provider,
            model: actualModel,
          });
          messageMap.set(payload.nativeId, id);
        }
        if (payload.text !== undefined)
          this.store.replaceMessage(id, payload.text);
        else this.store.appendMessage(id, payload.delta ?? "");
        this.event(chat.id, run.id, "text", {
          ...payload,
          messageId: id,
          provider: run.provider,
          model: actualModel,
        });
        return;
      }
      if (type === "nativeTurn")
        this.store.setRun(run.id, "running", payload.id);
      if (type === "usage") payload = { ...payload, provider: run.provider };
      this.event(chat.id, run.id, type, payload);
    };
    const messages = this.store.messages(chat.id);
    const lastAgent = messages
      .filter((m) => m.role === "assistant")
      .at(-1)?.provider;
    const session = chat.sessions[run.provider];
    const handoff =
      (lastAgent && lastAgent !== run.provider) ||
      (!session && messages.length > 1)
        ? handoffContext(this.store, chat, run.provider)
        : "";
    if (handoff)
      this.event(chat.id, run.id, "handoff", {
        from: lastAgent ?? "archive",
        to: run.provider,
        scope: chat.scope,
        source: `harness://conversation/${chat.id}`,
      });
    // Chats sharing this folder are told about each other on every turn.
    const peers = workspacePeers(this.store, chat.id),
      notice = workspaceNotice(
        peers,
        peers.length
          ? await repositoryState(project.path).then(
              (state) => state.changes,
              () => null,
            )
          : null,
      );
    if (notice)
      this.event(chat.id, run.id, "work", {
        kind: "workspace-notice",
        item: {
          title: "Shared workspace notice",
          description: `${peers.length} other ${peers.length === 1 ? "chat" : "chats"} working here: ${peers.map((p) => p.title).join(", ")}`,
          text: notice,
        },
        sources: peers.map((p) => p.source),
      });
    // The user's standing rules. A worker that cannot run right now is left
    // out, and the turn says so rather than promising a tool that would fail.
    const rules = readRules(this.store),
      plan = planWorkers(rules, this.providers, run),
      delegation = { workers: plan.workers, running: 0, calls: 0, reasons: [] };
    if (plan.skipped.length) {
      delegation.reasons = plan.skipped.map(
        (s) => `${workerName(s.worker, this.providers)}: ${s.reason}`,
      );
      this.event(chat.id, run.id, "work", {
        kind: "delegation-fallback",
        item: {
          title: plan.workers.length
            ? `Searches go to ${workerName(plan.workers[0], this.providers)}`
            : "No worker is available; this chat will search for itself",
          description: delegation.reasons.join(" "),
        },
      });
    }
    const ctx = {
      project,
      chat,
      text,
      model: run.model,
      effort,
      session,
      handoff: [notice, handoff].filter(Boolean).join("\n\n"),
      instructions:
        agentInstructions(project, chat) +
        rulesInstructions(
          rules,
          plan.workers[0],
          this.providers,
          delegationStats(this.store),
        ),
      tools: plan.workers.length
        ? [...historyTools, delegateTool]
        : historyTools,
      signal: abort.signal,
      emit,
      billingConfirmation: this.store.setting("cursor-billing"),
      saveSession: (session) => {
        const current = this.store.conversation(chat.id);
        if (current.sessions[run.provider]?.id !== session.id)
          this.store.updateConversation(chat.id, {
            sessions: { ...current.sessions, [run.provider]: session },
          });
      },
      history: async (name, args) => {
        const input =
          typeof args === "string" ? JSON.parse(args) : (args ?? {});
        if (name === delegateTool.name)
          return this.delegate(run, project, delegation, input, abort.signal);
        const result = historyCall(this.store, chat.id, name, input);
        emit("work", {
          kind: "history-tool",
          name,
          scope: chat.scope,
          sources: Array.isArray(result)
            ? result.map((r) => r.source).filter(Boolean)
            : [result.source].filter(Boolean),
        });
        return result;
      },
      approve: (request) => this.waitApproval(run, request, abort.signal),
      mcpServers: [
        {
          name: "harness-history",
          command: process.execPath,
          args: [fileURLToPath(new URL("../history-mcp.mjs", import.meta.url))],
          env: [
            { name: "HARNESS_BRIDGE_URL", value: this.bridgeUrl },
            { name: "HARNESS_BRIDGE_TOKEN", value: token },
          ],
        },
      ],
    };
    try {
      this.store.setRun(run.id, "running");
      this.event(chat.id, run.id, "run", {
        status: "running",
        provider: run.provider,
        model: run.model,
      });
      const result = await this.runners[run.provider](ctx);
      status = abort.signal.aborted
        ? "cancelled"
        : ["completed", "cancelled", "interrupted"].includes(result.status)
          ? result.status
          : "failed";
      error =
        typeof result.error === "string" ? result.error : result.error?.message;
    } catch (caught) {
      status = abort.signal.aborted ? "cancelled" : "failed";
      error = caught.message;
    } finally {
      this.store.setRun(run.id, status, null, error ?? null);
      this.store.expireApprovals(run.id);
      this.bridgeTokens.delete(token);
      for (const [id, waiter] of this.approvalWaiters)
        if (waiter.runId === run.id) {
          waiter.resolve({ allow: false });
          this.approvalWaiters.delete(id);
        }
      this.active.delete(chat.id);
      this.event(chat.id, run.id, "run", {
        status,
        error,
        provider: run.provider,
        model: run.model,
      });
    }
  }
  // Runs one delegated task on the first worker that can take it. A chat is
  // never failed by its worker: when none can run, the answer says to carry on alone.
  async delegate(run, project, delegation, args, signal) {
    const chatId = run.conversation_id,
      note = (kind, item, extra = {}) =>
        this.event(chatId, run.id, "work", { kind, item, ...extra }),
      alone = (error, instruction) => ({
        error,
        reasons: delegation.reasons,
        instruction,
      });
    const task = [args.task, args.report && "Report: " + args.report]
      .filter((part) => typeof part === "string" && part.trim())
      .join("\n\n")
      .slice(0, 8000);
    if (!task) return alone("No task was given.", "Describe the whole task.");
    if (!delegation.workers.length)
      return alone(
        "No worker is available.",
        "Do this task yourself and do not call delegate_task again this turn.",
      );
    if (delegation.calls >= MAX_DELEGATIONS)
      return alone(
        `This turn has used its ${MAX_DELEGATIONS} delegations.`,
        "Do the remaining work yourself.",
      );
    if (delegation.running >= MAX_PARALLEL_DELEGATIONS)
      return alone(
        `${MAX_PARALLEL_DELEGATIONS} delegations are already running.`,
        "Wait for one to finish, or do this task yourself.",
      );
    delegation.calls++;
    delegation.running++;
    try {
      const candidates = [...delegation.workers];
      for (const [index, worker] of candidates.entries()) {
        const name = workerName(worker, this.providers),
          limit = new AbortController(),
          stop = () => limit.abort(),
          timer = setTimeout(stop, this.workerTimeoutMs);
        signal.addEventListener("abort", stop, { once: true });
        note("delegated-task", {
          title: `Delegated to ${name}`,
          description: task.slice(0, 300),
        });
        try {
          if (signal.aborted) throw new Error("The turn was stopped");
          const result = await this.workers[worker.provider]({
            cwd: project.path,
            model: worker.model,
            effort: worker.effort,
            task,
            signal: limit.signal,
          });
          recordDelegation(this.store, worker, result.tokens);
          note(
            "delegated-task",
            {
              title: `${name} answered`,
              description: `${(result.tokens || 0).toLocaleString("en-US")} tokens`,
              text: result.text,
            },
            { tokens: result.tokens },
          );
          return { answer: result.text, worker: name, tokens: result.tokens };
        } catch (error) {
          if (signal.aborted) throw error;
          const reason = limit.signal.aborted
            ? `no answer within ${Math.round(this.workerTimeoutMs / 60000)} minutes`
            : error.message;
          delegation.reasons.push(`${name}: ${reason}`);
          // A provider that is out of usage stays out for the rest of the turn.
          if (error.unavailable) {
            delegation.workers = delegation.workers.filter((w) => w !== worker);
            this.refreshProviders().catch(() => {});
          }
          const next = candidates[index + 1];
          note("delegation-fallback", {
            title: `${name} could not run`,
            description:
              reason +
              (next
                ? ` Trying ${workerName(next, this.providers)}.`
                : " The chat will do this itself."),
          });
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", stop);
        }
      }
      return alone(
        "No worker could finish this task.",
        delegation.workers.length
          ? "Do this task yourself."
          : "Do this task yourself and do not call delegate_task again this turn.",
      );
    } finally {
      delegation.running--;
    }
  }
  waitApproval(run, request, signal) {
    if (signal.aborted) return Promise.resolve({ allow: false });
    const approval = this.store.addApproval(
      run.conversation_id,
      run.id,
      run.provider,
      request,
    );
    this.store.setRun(run.id, "waiting");
    const response = new Promise((resolve) => {
      const onAbort = () => {
        this.approvalWaiters.delete(approval.id);
        this.store.expireApprovals(run.id);
        resolve({ allow: false });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.approvalWaiters.set(approval.id, {
        runId: run.id,
        resolve: (answer) => {
          signal.removeEventListener("abort", onAbort);
          this.store.setRun(run.id, "running");
          resolve(answer);
        },
      });
    });
    this.event(run.conversation_id, run.id, "approval", approval);
    return response;
  }
  answer(id, answer) {
    const approval = this.store.approval(id);
    if (!approval) throw new Error("Approval not found");
    if (approval.status === "resolved") return approval;
    const waiter = this.approvalWaiters.get(id);
    if (!waiter || approval.status !== "pending")
      throw new Error(
        "This approval expired. Continue the conversation to request it again.",
      );
    const result = {
      allow: answer.allow === true,
      answers:
        answer.answers && typeof answer.answers === "object"
          ? answer.answers
          : {},
    };
    if (this.store.resolveApproval(id, result)) {
      this.approvalWaiters.delete(id);
      waiter.resolve(result);
      this.event(
        approval.conversation_id,
        approval.run_id,
        "approval-resolved",
        { id, response: result },
      );
    }
    return this.store.approval(id);
  }
  cancel(chatId) {
    const active = this.active.get(chatId);
    if (active) {
      active.abort.abort();
      this.event(chatId, active.run.id, "work", {
        kind: "cancellation",
        text: "Stop requested. Waiting for the agent to acknowledge.",
      });
    }
    return { requested: !!active };
  }
  async close() {
    const active = [...this.active.values()];
    for (const { abort } of active) abort.abort();
    await Promise.allSettled([...active.map((a) => a.task), this.refreshing]);
  }
}
