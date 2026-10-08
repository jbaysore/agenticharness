import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inspectCodex, runCodex } from "../providers/codex.mjs";
import { inspectClaude, runClaude } from "../providers/claude.mjs";
import { inspectCursor, runCursor } from "../providers/cursor.mjs";
import { agentInstructions, handoffContext, historyCall } from "./history.mjs";

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
    const ctx = {
      project,
      chat,
      text,
      model: run.model,
      effort,
      session,
      handoff,
      instructions: agentInstructions(project, chat),
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
        const result = historyCall(
          this.store,
          chat.id,
          name,
          typeof args === "string" ? JSON.parse(args) : (args ?? {}),
        );
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
      const result = await {
        codex: runCodex,
        claude: runClaude,
        cursor: runCursor,
      }[run.provider](ctx);
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
