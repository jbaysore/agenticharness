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
  planDelegation,
  readRules,
  rulesInstructions,
  workerName,
} from "./rules.mjs";
import { skillInstructions, skillsForTurn } from "./skills.mjs";
import { isDelegationTool } from "./delegation.mjs";
import { Delegator } from "./delegator.mjs";
import { COMMAND_SHELL, runCommand } from "./commands.mjs";
import { browserTitle } from "./browser.mjs";
import { runClaudeWorker, runCodexWorker } from "../providers/workers.mjs";
import { CursorReviewer } from "./reviewer.mjs";

// Who answers permission requests: a native or separate reviewer (auto),
// the user (manual), or nobody, because everything is allowed (override).
export const PERMISSION_MODES = ["auto", "manual", "override"];

export class Controller extends EventEmitter {
  constructor(store, { probePath, bridgeUrl, browser = null }) {
    super();
    this.store = store;
    this.probePath = probePath;
    this.bridgeUrl = bridgeUrl;
    this.providers = [];
    this.active = new Map();
    this.approvalWaiters = new Map();
    this.bridgeTokens = new Map();
    this.browser = browser;
    this.bridgeBrowser = new Map();
    this.runners = { codex: runCodex, claude: runClaude, cursor: runCursor };
    this.workers = { claude: runClaudeWorker, codex: runCodexWorker };
    this.workerTimeoutMs = 5 * 60 * 1000;
    this.reviewerTimeoutMs = 60 * 1000;
    this.runCommand = runCommand;
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
  send(chatId, { actionId, text, provider, model, effort, permissions }) {
    const chat = this.store.conversation(chatId);
    if (!chat) throw new Error("Conversation not found");
    if (typeof text !== "string" || !text.trim() || text.length > 250000)
      throw new Error("Enter a message under 250,000 characters");
    if (typeof actionId !== "string" || !/^[-\w]{16,100}$/.test(actionId))
      throw new Error("A stable action ID is required");
    if (!["codex", "claude", "cursor"].includes(provider))
      throw new Error("Unknown agent");
    permissions ??= chat.permissions;
    if (!PERMISSION_MODES.includes(permissions))
      throw new Error("Choose auto-review, manual review or override");
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
      permissions,
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
  setPermissions(chatId, permissions) {
    const chat = this.store.conversation(chatId);
    if (!chat) throw new Error("Conversation not found");
    if (!PERMISSION_MODES.includes(permissions))
      throw new Error("Choose auto-review, manual review or override");
    if (chat.permissions === permissions) return chat;
    const updated = this.store.updateConversation(chatId, { permissions }),
      active = this.active.get(chatId);
    if (active && !active.cancelled) {
      // Native permission policies can be frozen for a turn. Interrupt before
      // resuming the same session so the entire mode, including its sandbox,
      // applies to the next action. Keep the same Harness run and user message.
      active.restart = true;
      active.abort.abort();
      this.event(chatId, active.run.id, "work", {
        kind: "permissions-change",
        item: {
          title: "Applying permission mode",
          description:
            "Pausing the agent and continuing this turn with " +
            {
              auto: "Auto-review",
              manual: "Manual review",
              override: "Override",
            }[permissions] +
            ".",
        },
      });
    }
    return updated;
  }
  async execute(run, text, effort, abort, continuing = false) {
    const chat = this.store.conversation(run.conversation_id),
      project = this.store.project(chat.project_id),
      messageMap = new Map();
    let actualModel =
      this.providers
        .find((p) => p.id === run.provider)
        ?.models.find((m) => m.id === run.model)?.resolvedModel ?? run.model;
    const permissions = chat.permissions,
      token = randomBytes(32).toString("base64url");
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
    // Override answers every permission request itself and logs it; questions
    // for the user still reach the user.
    const reviewer =
      permissions === "auto" && run.provider === "cursor"
        ? new CursorReviewer({
            controller: this,
            run,
            project,
            chat,
            text,
            signal: abort.signal,
          })
        : null;
    const approve = async (request) => {
      if (abort.signal.aborted) return Promise.resolve({ allow: false });
      if (
        reviewer &&
        request.kind === "permission" &&
        ["session/request_permission", "cursor/create_plan"].includes(
          request.method,
        )
      ) {
        const result = await reviewer.review(request);
        if (abort.signal.aborted) return { allow: false };
        if (result.decision !== "ask")
          return { allow: result.decision === "allow", reason: result.reason };
        return this.waitApproval(
          run,
          { ...request, reviewReason: result.reason },
          abort.signal,
        );
      }
      if (permissions !== "override" || request.kind === "question")
        return this.waitApproval(run, request, abort.signal);
      emit("work", {
        kind: "auto-approved",
        item: {
          title: `Allowed without review: ${request.title ?? "agent action"}`,
          description: "Permissions are set to Override.",
        },
      });
      return Promise.resolve({ allow: true, answers: {} });
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
    // The user's standing rules. What cannot be handed off this turn is left
    // out, and the turn says why rather than offering a tool that would fail.
    const rules = readRules(this.store),
      plan = planDelegation(rules, this.providers, run, this.store),
      delegator =
        plan.tools.length &&
        new Delegator({
          controller: this,
          run,
          project,
          plan,
          signal: abort.signal,
        });
    if (plan.note || plan.skipped.length)
      this.event(chat.id, run.id, "work", {
        kind: "delegation-fallback",
        item: {
          title: plan.workers.length
            ? `Hand-offs go to ${workerName(plan.workers[0], this.providers)}`
            : "Nothing is handed off this turn; this chat does its own work",
          description: [
            plan.note,
            ...plan.skipped.map(
              (s) => `${workerName(s.worker, this.providers)}: ${s.reason}`,
            ),
          ]
            .filter(Boolean)
            .join(" "),
        },
      });
    // The browser is offered only when it can start; a turn goes on without it.
    const browserTools = this.browser
      ? await this.browser.tools().then(
          (tools) =>
            tools.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          (failure) => {
            this.event(chat.id, run.id, "work", {
              kind: "browser-unavailable",
              item: {
                title: "The browser is unavailable this turn",
                description: failure.message,
              },
            });
            return [];
          },
        )
      : [];
    // Every action that can change a page asks the user, whichever agent calls it.
    const browser = async (name, args) => {
      const input = typeof args === "string" ? JSON.parse(args) : (args ?? {}),
        title = browserTitle(name, input);
      if (await this.browser.needsApproval(name)) {
        const answer = await approve({
          kind: "permission",
          title,
          details: { tool: name, input },
        });
        if (!answer.allow)
          return {
            isError: true,
            content: [
              { type: "text", text: "The user declined this browser action." },
            ],
          };
      }
      emit("work", { kind: "browser-tool", item: { title, name } });
      return this.browser.call(name, input);
    };
    if (browserTools.length)
      this.bridgeBrowser.set(token, { tools: browserTools, call: browser });
    const skills = skillsForTurn(this.store, chat.id);
    if (skills.length)
      this.event(chat.id, run.id, "work", {
        kind: "skills",
        item: {
          title:
            skills.length === 1
              ? `Skill · ${skills[0].name}`
              : `Skills · ${skills.map((skill) => skill.name).join(", ")}`,
          description: "Included in the instructions for this turn.",
        },
      });
    const ctx = {
      project,
      chat,
      text: continuing
        ? [
            `The user changed the permission mode to ${permissions} while you were working. Continue the current task from this session's saved progress under the new permissions.`,
            "Do not repeat completed actions. Requests awaiting permission when interrupted were not declined by the user; reevaluate them under the new mode. Unanswered questions still require user input.",
            "Original request:\n" + text,
          ].join("\n\n")
        : text,
      model: run.model,
      effort,
      permissions,
      session,
      handoff: [notice, handoff].filter(Boolean).join("\n\n"),
      instructions:
        agentInstructions(project, chat) +
        rulesInstructions(rules, plan, this.providers, COMMAND_SHELL) +
        skillInstructions(skills),
      tools: [...historyTools, ...plan.tools, ...browserTools],
      browser,
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
        if (isDelegationTool(name))
          return delegator
            ? delegator.handle(name, input)
            : {
                error: "Nothing can be handed off this turn.",
                instruction: "Do this yourself.",
              };
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
      approve,
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
    if (reviewer) reviewer.instructions = ctx.instructions;
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
      this.store.expireApprovals(run.id);
      this.bridgeTokens.delete(token);
      this.bridgeBrowser.delete(token);
      for (const [id, waiter] of this.approvalWaiters)
        if (waiter.runId === run.id) {
          waiter.resolve({ allow: false });
          this.approvalWaiters.delete(id);
        }
    }
    const active = this.active.get(chat.id);
    if (active?.restart && !active.cancelled) {
      active.restart = false;
      active.abort = new AbortController();
      this.store.setRun(run.id, "running");
      return this.execute(run, text, effort, active.abort, true);
    }
    this.store.setRun(run.id, status, null, error ?? null);
    this.active.delete(chat.id);
    this.event(chat.id, run.id, "run", {
      status,
      error,
      provider: run.provider,
      model: run.model,
    });
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
      active.cancelled = true;
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
    for (const work of active) {
      work.cancelled = true;
      work.abort.abort();
    }
    await Promise.allSettled([...active.map((a) => a.task), this.refreshing]);
    this.browser?.close();
  }
}
