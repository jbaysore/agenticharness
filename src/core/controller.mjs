import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCodex, runCodex } from "../providers/codex.mjs";
import { inspectClaude, runClaude } from "../providers/claude.mjs";
import {
  inspectCursor,
  learnCursorEfforts,
  runCursor,
} from "../providers/cursor.mjs";
import {
  agentInstructions,
  handoffContext,
  historyCall,
  historyTools,
  promptDelivery,
  provisionalTitle,
  renameInstructions,
  workspaceNotice,
  workspacePeers,
} from "./history.mjs";
import { projectPath, repositoryState } from "./repository.mjs";
import {
  delegationInstructions,
  planDelegation,
  readRules,
  standingInstructions,
  workerName,
} from "./rules.mjs";
import {
  ASK_DENY,
  ASK_INSTRUCTIONS,
  GOAL_INSTRUCTIONS,
  GOAL_QUESTION_LIMIT,
  GOAL_QUESTION_TIMEOUT,
  GOAL_QUESTION_TIMEOUT_MS,
  MODE_SUGGESTION_INSTRUCTIONS,
  askHostAllowed,
  checkMode,
  goalQuestionAnswers,
  hostToolsForMode,
  modeSuggestionTool,
  questionKey,
} from "./modes.mjs";
import {
  invokedSkills,
  listSkills,
  prepareMessage,
  skillInstructions,
} from "./skills.mjs";
import { isDelegationTool, offeredTools } from "./delegation.mjs";
import { Delegator } from "./delegator.mjs";
import { COMMAND_SHELL, runCommand } from "./commands.mjs";
import { browserGateway, browserTitle } from "./browser.mjs";
import {
  askUserTool,
  checkQuestions,
  QUESTION_INSTRUCTIONS,
} from "./questions.mjs";
import { proposalText, taggedProposal, PLAN_INSTRUCTIONS } from "./plans.mjs";
import {
  attachmentContext,
  attachmentInfo,
  resolveAttachments,
} from "./attachments.mjs";
import { runClaudeWorker, runCodexWorker } from "../providers/workers.mjs";
import { ActionReviewer } from "./reviewer.mjs";
import { restartTool } from "./self-restart.mjs";
import { blockingGoals, goalStopped } from "./goals.mjs";
import { isUsageExhausted } from "../security/billing.mjs";
import {
  createWorktree,
  landTool,
  landWorktree,
  restoreWorktree,
  syncWorktree,
  tidyWorktree,
} from "./worktrees.mjs";

export { CHAT_MODES, checkMode } from "./modes.mjs";

// Who answers permission requests: a native or separate reviewer (auto),
// the user (manual), or nobody, because everything is allowed (override).
export const PERMISSION_MODES = ["auto", "manual", "override"];
const sameDirectory = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

export class Controller extends EventEmitter {
  constructor(
    store,
    {
      probePath,
      bridgeUrl,
      browser = null,
      worktreeRoot = null,
      dataDir,
      openReviewer: openReviewerOption = null,
    },
  ) {
    super();
    this.store = store;
    this.probePath = probePath;
    this.dataDir = dataDir;
    this.bridgeUrl = bridgeUrl;
    this.providers = [];
    this.active = new Map();
    this.approvalWaiters = new Map();
    this.bridgeTokens = new Map();
    this.browser = browser;
    this.bridgeBrowser = new Map();
    this.bridgeLand = new Map();
    this.bridgeModes = new Map();
    this.bridgeQuestions = new Map();
    // Where every new chat gets its own worktree.
    this.worktreeRoot = worktreeRoot;
    // Worktree removals in progress, by chat, so a new turn waits for them.
    this.tidying = new Map();
    this.runners = { codex: runCodex, claude: runClaude, cursor: runCursor };
    this.workers = { claude: runClaudeWorker, codex: runCodexWorker };
    this.openReviewer = openReviewerOption;
    this.workerTimeoutMs = 5 * 60 * 1000;
    this.reviewerTimeoutMs = 60 * 1000;
    this.goalQuestionTimeoutMs = GOAL_QUESTION_TIMEOUT_MS;
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
          inspectCursor(
            this.probePath,
            this.store.setting("cursor-billing"),
            (options) => this.learnCursorEfforts(options),
          ),
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
  // Effort levels Cursor has shown for a model, kept for its picker.
  learnCursorEfforts(configOptions) {
    const known = this.store.setting("cursor-efforts") ?? {},
      next = learnCursorEfforts(known, configOptions);
    if (next === known) return known;
    this.store.setting("cursor-efforts", next);
    if (this.providers.some((p) => p.id === "cursor")) {
      this.providers = this.providers.map((p) =>
        p.id === "cursor"
          ? {
              ...p,
              models: p.models.map((m) =>
                next[m.id] ? { ...m, ...next[m.id] } : m,
              ),
            }
          : p,
      );
      this.event(null, null, "providers", { providers: this.providers });
    }
    return next;
  }
  send(chatId, input, releasing = false) {
    const prepared = this.prepareSend(chatId, input);
    if (prepared.duplicate) return prepared.duplicate;
    this.selfRestart?.assertAdmission();
    const active = this.active.get(chatId);
    // A running turn keeps the message until it finishes, unless /steer
    // redirects that turn. A stopped turn still drains its queue afterward.
    if (active && !releasing) {
      if (prepared.delivery === "steer" && !active.cancelled)
        return this.steer(prepared);
      return this.enqueue(prepared);
    }
    if (!releasing && this.store.queuedInputs(chatId).length) {
      const row = this.enqueue(prepared);
      this.releaseQueue(chatId);
      return { ...row, queued: true };
    }
    return this.startTurn(prepared);
  }
  prepareSend(
    chatId,
    {
      actionId,
      text = "",
      attachments = [],
      provider,
      model,
      effort,
      permissions,
      mode,
      parsed = false,
    },
  ) {
    const chat = this.store.conversation(chatId);
    if (!chat) throw new Error("Conversation not found");
    if (typeof text !== "string" || text.length > 250000)
      throw new Error("Enter a message under 250,000 characters");
    if (typeof actionId !== "string" || !/^[-\w]{16,100}$/.test(actionId))
      throw new Error("A stable action ID is required");
    if (!["codex", "claude", "cursor"].includes(provider))
      throw new Error("Unknown agent");
    permissions ??= chat.permissions;
    if (!PERMISSION_MODES.includes(permissions))
      throw new Error("Choose auto-review, manual review or override");
    const opened = parsed
      ? { delivery: null, mode: null, text: String(text) }
      : prepareMessage(text);
    const body = opened.text.trim();
    mode = opened.mode ?? mode ?? chat.mode;
    checkMode(mode, provider);
    const prior = this.store.runForAction(actionId);
    if (prior) {
      if (prior.conversation_id !== chatId)
        throw new Error("Action ID belongs to another conversation");
      return { duplicate: { ...prior, duplicate: true } };
    }
    const existing = this.store.inputForAction(actionId);
    if (existing) {
      if (existing.conversation_id !== chatId)
        throw new Error("Action ID belongs to another conversation");
      return {
        duplicate: {
          ...existing,
          duplicate: true,
          queued: existing.status === "queued",
          steered: existing.status === "steered",
        },
      };
    }
    const files = resolveAttachments(
      this.store,
      chat.project_id,
      attachments,
      this.dataDir,
    );
    if (!body && !files.length)
      throw new Error("Enter a message or attach a file");
    const selected = this.providers.find((p) => p.id === provider);
    if (!selected) throw new Error("Refresh provider connections first");
    if (selected.blockReason) throw new Error(selected.blockReason);
    const selectedModel = selected.models.find((m) => m.id === model);
    if (!selectedModel || selectedModel.disabled)
      throw new Error("Select an available model");
    if (effort && !selectedModel.efforts.includes(effort))
      throw new Error("The selected model does not expose that effort setting");
    return {
      chat,
      chatId,
      actionId,
      text: body,
      delivery: opened.delivery,
      files,
      provider,
      model,
      effort: effort || null,
      permissions,
      mode,
    };
  }
  startTurn(prepared) {
    this.selfRestart?.assertAdmission();
    const { chat, chatId } = prepared;
    if (this.active.has(chatId))
      throw new Error("This chat already has active work");
    const run = this.store.createRun({
      conversationId: chatId,
      actionId: prepared.actionId,
      provider: prepared.provider,
      model: prepared.model,
      text: prepared.text,
      attachments: prepared.files.map(attachmentInfo),
    });
    const abort = new AbortController();
    this.active.set(chatId, { run, abort, pendingSteers: [] });
    const entry = this.active.get(chatId);
    entry.flushSteer = () => this.flushSteers(chatId);
    if (chat.archived_at) this.store.setArchived(chatId, false);
    this.store.updateConversation(chatId, {
      provider: prepared.provider,
      model: prepared.model,
      effort: prepared.effort,
      permissions: prepared.permissions,
      mode: prepared.mode,
    });
    this.event(chatId, run.id, "run", {
      status: "starting",
      provider: prepared.provider,
      model: prepared.model,
    });
    const task = this.execute(run, prepared.text, prepared.effort, abort).catch(
      (error) => {
        this.event(chatId, run.id, "error", { message: error.message });
      },
    );
    entry.task = task;
    return run;
  }
  enqueue(prepared) {
    const row = this.store.enqueueInput({
      conversationId: prepared.chatId,
      actionId: prepared.actionId,
      text: prepared.text,
      attachments: prepared.files.map(attachmentInfo),
      provider: prepared.provider,
      model: prepared.model,
      effort: prepared.effort,
      permissions: prepared.permissions,
      mode: prepared.mode,
    });
    this.event(prepared.chatId, null, "queue", { id: row.id });
    return { ...row, queued: true };
  }
  steer(prepared) {
    const active = this.active.get(prepared.chatId);
    if (!active || active.cancelled) return this.enqueue(prepared);
    const skills = invokedSkills(listSkills(this.store), prepared.text);
    const modeNote =
      prepared.mode === "ask"
        ? "\n\n" + ASK_INSTRUCTIONS
        : prepared.mode === "plan"
          ? "\n\nPlan mode: propose the work before changing anything. Do not change the project yet."
          : "";
    if (prepared.mode !== prepared.chat.mode)
      this.setMode(prepared.chatId, prepared.mode);
    const row = this.store.enqueueInput({
      conversationId: prepared.chatId,
      actionId: prepared.actionId,
      text: prepared.text,
      attachments: prepared.files.map(attachmentInfo),
      provider: prepared.provider,
      model: prepared.model,
      effort: prepared.effort,
      permissions: prepared.permissions,
      mode: prepared.mode,
      status: "steered",
    });
    active.pendingSteers ??= [];
    active.pendingSteers.push({
      id: row.id,
      text:
        prepared.text +
        attachmentContext(prepared.files) +
        skillInstructions(skills) +
        modeNote,
      displayText: prepared.text,
      attachments: prepared.files.map(attachmentInfo),
      mode: prepared.mode,
      skills,
      delivered: false,
    });
    active.flushSteer?.();
    this.event(prepared.chatId, active.run.id, "queue", {
      steered: true,
      id: row.id,
    });
    return { ...row, steered: true };
  }
  flushSteers(chatId) {
    const entry = this.active.get(chatId);
    if (!entry?.deliverSteer) return;
    let added = false;
    for (const item of entry.pendingSteers ?? []) {
      if (item.delivered) continue;
      try {
        entry.deliverSteer(item);
      } catch {
        continue;
      }
      item.delivered = true;
      added = true;
      this.store.addMessage({
        conversationId: chatId,
        runId: entry.run.id,
        role: "user",
        content: item.displayText,
        attachments: item.attachments,
      });
      if (item.skills?.length)
        this.event(chatId, entry.run.id, "work", {
          kind: "skills",
          item: {
            title:
              item.skills.length === 1
                ? `Skill · ${item.skills[0].name}`
                : `Skills · ${item.skills.map((skill) => skill.name).join(", ")}`,
            description: "Invoked by a slash command in this message.",
          },
        });
    }
    if (added) this.event(chatId, entry.run.id, "queue", { steered: true });
  }
  requeuePending(entry) {
    for (const item of [...(entry?.pendingSteers ?? [])].reverse())
      if (!item.delivered) this.store.requeueInput(item.id);
    if (entry) entry.pendingSteers = [];
  }
  releaseQueue(chatId) {
    if (this.selfRestart?.gated) return;
    if (this.active.has(chatId)) return;
    const next = this.store.claimNextQueued(chatId);
    if (!next) return;
    try {
      this.send(
        chatId,
        {
          actionId: next.action_id,
          text: next.text,
          attachments: (next.attachments ?? []).map((file) => file.id),
          provider: next.provider,
          model: next.model,
          effort: next.effort,
          permissions: next.permissions,
          mode: next.mode,
          parsed: true,
        },
        true,
      );
    } catch (error) {
      this.store.restoreQueued(next);
      this.event(chatId, null, "error", { message: error.message });
    }
  }
  removeQueued(chatId, id) {
    const row = this.store.queuedInput(id);
    if (!row || row.conversation_id !== chatId || row.status !== "queued")
      throw new Error("That queued message is no longer waiting");
    this.store.deleteQueued(id);
    this.event(chatId, null, "queue", { id, removed: true });
    return { id };
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
  // A new mode applies from the next message, as switching it does natively.
  setMode(chatId, mode) {
    const chat = this.store.conversation(chatId);
    if (!chat) throw new Error("Conversation not found");
    checkMode(mode, chat.provider);
    return this.store.updateConversation(chatId, { mode });
  }
  // The folder a chat works in: its own worktree, created on its first turn,
  // or the project folder when that is not a Git repository on a branch or the
  // chat began before worktrees were given to every chat. Explicit moves reset
  // the native session before changing this folder.
  async chatFolder(chat, home, run) {
    await this.tidying.get(chat.id);
    let worktree = chat.worktree;
    if (!worktree && this.worktreeRoot && !Object.keys(chat.sessions).length)
      try {
        worktree = await createWorktree({
          projectPath: home.path,
          root: this.worktreeRoot,
          chatId: chat.id,
        });
        this.store.updateConversation(chat.id, { worktree });
        this.event(chat.id, null, "chat", this.store.conversation(chat.id));
        this.event(chat.id, run.id, "work", {
          kind: "worktree",
          item: {
            title: `Working in its own copy on ${worktree.branch}`,
            description: `This chat has its own Git worktree at ${worktree.path}, so other chats' unfinished edits never reach it. Its commits reach ${worktree.base} through land_changes.`,
          },
        });
      } catch (failure) {
        // Only worth a notice when sharing the folder with a busy chat.
        if (!workspacePeers(this.store, chat.id, { byProject: true }).length)
          return home;
        this.event(chat.id, run.id, "work", {
          kind: "worktree-unavailable",
          item: {
            title: "Working in the shared project folder",
            description: `Another chat is working here, but this chat could not get its own worktree: ${failure.message}`,
          },
        });
        return home;
      }
    if (!worktree) return home;
    await restoreWorktree(home.path, worktree);
    const sync = await syncWorktree(worktree).catch(() => null);
    if (sync?.updated)
      this.event(chat.id, run.id, "work", {
        kind: "worktree-sync",
        item: {
          title: `Brought ${worktree.branch} up to date with ${worktree.base}`,
          description: `${sync.behind} new ${sync.behind === 1 ? "commit" : "commits"} from other chats.`,
        },
      });
    return { ...home, path: worktree.path, home: home.path, worktree };
  }
  async requestChatMove(chatId, directory) {
    const chat = this.store.conversation(chatId);
    if (!chat) throw new Error("Conversation not found");
    if (chat.mode === "ask") throw new Error(ASK_DENY);
    const active = this.active.get(chatId);
    if (!active) throw new Error("Move this chat during an active turn");
    if (active.pendingMove)
      throw new Error("A move is already queued for this turn");
    if (typeof directory !== "string" || !directory.trim())
      throw new Error("Choose an existing absolute destination directory");
    const path = await projectPath(directory.trim()),
      home = this.store.project(chat.project_id);
    if (this.active.get(chatId) !== active)
      throw new Error("The turn ended before the move could be queued");
    if (active.pendingMove)
      throw new Error("A move is already queued for this turn");
    if (!home) throw new Error("The current project is no longer available");
    if (chat.worktree && sameDirectory(path, chat.worktree.path))
      throw new Error(
        "That is this chat's temporary worktree. Choose the project directory or another destination.",
      );
    this.event(chatId, active.run.id, "work", {
      kind: "history-tool",
      name: "move_chat",
      scope: chat.scope,
      sources: [],
    });
    if (sameDirectory(path, home.path))
      return { queued: false, moved: false, directory: path };
    active.pendingMove = { path };
    return {
      queued: true,
      directory: path,
      instruction:
        "Harness will move the chat after this turn ends. Stop task work now and tell the user the move is queued, not complete. Harness will report whether it completed; future turns will start in the destination directory.",
    };
  }
  async requestSelfRestart(chatId) {
    const chat = this.store.conversation(chatId);
    if (!this.selfRestart || !chat)
      throw new Error("Self restart is unavailable");
    return this.selfRestart.request(
      this.store.project(chat.project_id)?.path,
      chat.mode,
    );
  }
  async finishChatMove(chatId, pendingMove) {
    const chat = this.store.conversation(chatId),
      home = chat && this.store.project(chat.project_id);
    if (!chat || !home) return false;
    const destination = await projectPath(pendingMove.path);
    if (chat.worktree) {
      const removed = await tidyWorktree(home.path, chat.worktree);
      if (!removed) {
        this.event(chatId, null, "work", {
          kind: "chat-move-failed",
          item: {
            title: "Chat was not moved",
            description:
              "Its current worktree has uncommitted changes or commits that have not landed. Keep working in the old directory, then land or save that work before asking to move the chat again.",
          },
        });
        return false;
      }
    }
    const project = this.store.addProject(
        basename(destination) || destination,
        destination,
      ),
      moved = this.store.moveConversation(chatId, project.id);
    this.event(null, null, "projects", {});
    this.event(chatId, null, "chat", moved);
    this.event(chatId, null, "work", {
      kind: "chat-moved",
      item: {
        title: "Chat moved",
        description: `Future turns will work in ${project.path}. The provider session was reset, and chat history stays available.`,
      },
    });
    return true;
  }
  // Between turns, a worktree whose work has all landed is removed, so a
  // project left idle is back to its one folder.
  tidy(chatId) {
    const chat = this.store.conversation(chatId),
      home = chat && this.store.project(chat.project_id);
    if (!chat?.worktree || !home || this.active.has(chatId)) return;
    const done = (this.tidying.get(chatId) ?? Promise.resolve())
      .then(() => tidyWorktree(home.path, chat.worktree))
      .catch(() => false)
      .finally(() => {
        if (this.tidying.get(chatId) === done) this.tidying.delete(chatId);
      });
    this.tidying.set(chatId, done);
    return done;
  }
  tidyAll() {
    return Promise.all(this.store.conversations().map((c) => this.tidy(c.id)));
  }
  async execute(
    run,
    text,
    effort,
    abort,
    continuing = false,
    modeChange = null,
  ) {
    const chat = this.store.conversation(run.conversation_id),
      home = this.store.project(chat.project_id),
      messageMap = new Map(),
      proposalBuffers = new Map();
    let project;
    try {
      project = await this.chatFolder(chat, home, run);
    } catch (failure) {
      const error = `This chat's worktree could not be prepared: ${failure.message}`;
      this.store.setRun(run.id, "failed", null, error);
      const entry = this.active.get(chat.id);
      this.requeuePending(entry);
      this.active.delete(chat.id);
      this.event(chat.id, run.id, "run", {
        status: "failed",
        error,
        provider: run.provider,
        model: run.model,
      });
      this.releaseQueue(chat.id);
      return;
    }
    if (
      chat.mode === "goal" ||
      blockingGoals(chat).some((g) => g.provider === run.provider)
    )
      this.store.setGoalState(chat.id, run.provider, run.id, "starting");
    let actualModel =
      this.providers
        .find((p) => p.id === run.provider)
        ?.models.find((m) => m.id === run.model)?.resolvedModel ?? run.model;
    const permissions = chat.permissions,
      token = randomBytes(32).toString("base64url");
    this.bridgeTokens.set(token, chat.id);
    let status = "failed",
      error;
    let latestProposal = null;
    const saveProposal = (text) => {
      if (!text || text === latestProposal) return;
      latestProposal = text;
      this.event(chat.id, run.id, "proposed-plan", { text });
    };
    // A usage flag from an earlier turn drops once this turn is actually
    // working. The stop itself is recorded after the runner returns.
    let sawWork = false,
      billingStop = null,
      usageStopReason = null,
      usageFlag = Boolean(
        this.store.conversation(chat.id)?.usage_stopped_at,
      );
    const noteUsageStop = (reason) => {
      if (isUsageExhausted(reason)) usageStopReason ??= reason;
    };
    const noteActivity = () => {
      sawWork = true;
      if (!usageFlag || usageStopReason || abort.signal.aborted) return;
      usageFlag = false;
      this.store.clearUsageStop(chat.id);
      this.event(chat.id, null, "chat", this.store.conversation(chat.id));
    };
    const emit = (type, payload) => {
      if (type === "proposed-plan") {
        noteActivity();
        saveProposal(proposalText(payload.text));
        return;
      }
      if (type === "nativeModel" && typeof payload.model === "string")
        actualModel = payload.model;
      if (type === "text") {
        noteActivity();
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
        if (chat.mode === "plan") {
          const content =
            payload.text ??
            (proposalBuffers.get(id) ?? "") + (payload.delta ?? "");
          proposalBuffers.set(id, content);
          if (content.includes("</proposed_plan>"))
            saveProposal(taggedProposal(content));
        }
        this.event(chat.id, run.id, "text", {
          ...payload,
          messageId: id,
          provider: run.provider,
          model: actualModel,
        });
        return;
      }
      if (type === "nativeTurn") {
        noteActivity();
        this.store.setRun(run.id, "running", payload.id);
      }
      if (type === "work" && payload?.kind === "billing-stop") {
        billingStop = typeof payload.reason === "string" ? payload.reason : "";
        noteUsageStop(billingStop);
      } else if (
        type === "work" &&
        !["token-usage", "error"].includes(payload?.kind)
      )
        noteActivity();
      if (type === "usage") {
        // Reloading the page must keep the latest reading, including stale status.
        this.providers = this.providers.map((p) =>
          p.id === run.provider ? { ...p, usage: payload } : p,
        );
        payload = { ...payload, provider: run.provider };
      }
      this.event(chat.id, run.id, type, payload);
    };
    // Override answers every permission request itself and logs it. Questions,
    // plans and mode suggestions still reach the user. In Auto-review, the
    // reviewer decides permissions and asks the user only when it returns ask.
    // Goal never waits on a permission, a plan, or a mode change. A question
    // waits 60 seconds, then the agent chooses and the goal continues.
    const goal = chat.mode === "goal";
    const reviewer =
      permissions === "auto" || (goal && permissions === "manual")
        ? new ActionReviewer({
            controller: this,
            run,
            project,
            chat,
            text,
            signal: abort.signal,
          })
        : null;
    const review = async (request) => {
      const result = await reviewer.review(request);
      if (abort.signal.aborted) return { allow: false };
      if (result.decision !== "ask")
        return { allow: result.decision === "allow", reason: result.reason };
      if (goal) {
        const reason = `${result.reason} Goal mode declined this because it needs you. Continue without it.`;
        emit("work", {
          kind: "goal-declined",
          item: {
            title: `Goal declined ${request.title ?? "an action"} that needs you`,
            description: reason,
          },
        });
        return { allow: false, reason };
      }
      return this.waitApproval(
        run,
        { ...request, reviewReason: result.reason },
        abort.signal,
      );
    };
    const approve = async (request) => {
      if (abort.signal.aborted) return Promise.resolve({ allow: false });
      if (request.kind === "plan") {
        const text =
          proposalText(request.plan) ??
          this.store.proposedPlans(chat.id)[run.id];
        request = { ...request, plan: text };
        saveProposal(text);
      }
      if (goal && request.kind === "mode-change")
        return {
          allow: false,
          reason:
            "Goal mode stays on until the objective is met. Do not suggest another mode.",
        };
      if (goal && request.kind === "plan") return { allow: true };
      if (goal && request.kind === "question")
        return this.answerGoalQuestion(chat.id, run, request, abort.signal);
      if (reviewer && request.kind === "permission") return review(request);
      if (
        permissions !== "override" ||
        ["question", "plan", "mode-change"].includes(request.kind)
      )
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
    const attached =
      messages.find((m) => m.run_id === run.id && m.role === "user")
        ?.attachments ?? [];
    const files = resolveAttachments(
      this.store,
      chat.project_id,
      attached.map((f) => f.id),
      this.dataDir,
    );
    const requestText = text + attachmentContext(files);
    const continuationText = continuing
      ? [
          modeChange
            ? `The user approved changing the chat mode from ${modeChange.fromMode} to ${chat.mode}. Continue the current task from this session's saved progress in ${chat.mode} mode. This approval changes the mode only; it does not approve a proposed plan or expand the task scope.`
            : `The user changed the permission mode to ${permissions} while you were working. Continue the current task from this session's saved progress under the new permissions.`,
          "Do not repeat completed actions. Requests awaiting permission when interrupted were not declined by the user; reevaluate them under the new mode. Unanswered questions still require user input.",
          modeChange?.objective &&
            "Approved Goal objective:\n" + modeChange.objective,
          "Original request:\n" + requestText,
        ]
          .filter(Boolean)
          .join("\n\n")
      : requestText;
    const startGoal = modeChange?.mode === "goal" && chat.mode === "goal";
    const lastAgent = messages
      .filter((m) => m.role === "assistant")
      .at(-1)?.provider;
    const session = chat.sessions[run.provider];
    const handoff =
      (lastAgent && lastAgent !== run.provider) ||
      (!session && messages.length > 1)
        ? handoffContext(this.store, chat, run.provider, this.dataDir)
        : "";
    if (handoff)
      this.event(chat.id, run.id, "handoff", {
        from: lastAgent ?? "archive",
        to: run.provider,
        scope: chat.scope,
        source: `harness://conversation/${chat.id}`,
      });
    // Chats sharing this folder are told about each other when that notice
    // changes. The shared Git rules go out with the first notice only.
    const savedSession = session && typeof session === "object" ? session : {},
      peers = workspacePeers(this.store, chat.id),
      notice = workspaceNotice(
        peers,
        peers.length
          ? await repositoryState(project.path).then(
              (state) => state.changes,
              () => null,
            )
          : null,
        { rules: !savedSession.noticeRulesSent },
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
    const rules = readRules(this.store);
    // Ask mode may hand off a read or a search. An edit, a command, or a
    // draft would change the project or prepare a commit, so they are absent.
    let plan = planDelegation(rules, this.providers, run, this.store);
    if (chat.mode === "ask") {
      const actions = {
        ...plan.actions,
        edit: false,
        run: false,
        draft: false,
      };
      plan = { ...plan, actions, tools: offeredTools(actions) };
    }
    const delegator =
      plan.tools.length &&
      new Delegator({
        controller: this,
        run,
        project,
        plan,
        signal: abort.signal,
        approve: goal ? approve : null,
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
          (tools) => {
            const visible = tools.filter(
              (tool) => chat.mode !== "ask" || tool.readOnly,
            );
            return visible.length
              ? [browserGateway(visible)].map(
                  ({ name, description, inputSchema }) => ({
                    name,
                    description,
                    inputSchema,
                  }),
                )
              : [];
          },
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
    // Every action that can change a page is approved first, whichever agent
    // calls it: by the reviewer in Auto-review, otherwise by the user.
    const browser = async (name, args) => {
      const raw = typeof args === "string" ? JSON.parse(args) : (args ?? {}),
        action = name === "browser" ? raw.action : name,
        input = name === "browser" ? (raw.arguments ?? {}) : raw;
      if (!action)
        return {
          isError: true,
          content: [{ type: "text", text: "Choose a browser action." }],
        };
      const title = browserTitle(action, input);
      let needsApproval = true;
      try {
        needsApproval = await this.browser.needsApproval(action);
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
        };
      }
      if (chat.mode === "ask" && needsApproval)
        return {
          isError: true,
          content: [{ type: "text", text: ASK_DENY }],
        };
      if (typeof this.browser.validate === "function") {
        const failure = await this.browser.validate(action, input);
        if (failure)
          return {
            isError: true,
            content: [{ type: "text", text: failure }],
          };
      }
      if (needsApproval) {
        const request = {
            kind: "permission",
            title,
            details: { tool: action, input },
          },
          answer = await (reviewer && !abort.signal.aborted
            ? review(request)
            : approve(request));
        if (!answer.allow)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: answer.reason
                  ? `Auto-review declined this browser action: ${answer.reason}`
                  : "The user declined this browser action.",
              },
            ],
          };
      }
      emit("work", { kind: "browser-tool", item: { title, name: action } });
      return this.browser.call(action, input);
    };
    if (browserTools.length)
      this.bridgeBrowser.set(token, { tools: browserTools, call: browser });
    // A chat in its own worktree delivers its commits through land_changes.
    const land = async () => {
      const { worktree } = project;
      emit("work", {
        kind: "landing",
        item: { title: `Landing ${worktree.branch} on ${worktree.base}` },
      });
      const result = await landWorktree({
        projectPath: home.path,
        worktree,
        check: home.check_command,
        run: this.runCommand,
        signal: abort.signal,
      });
      if (
        result.landed &&
        this.selfRestart &&
        (await this.selfRestart.eligible(
          home.path,
          this.store.conversation(chat.id)?.mode,
        ))
      ) {
        try {
          result.selfRestart = await this.selfRestart.request(
            home.path,
            this.store.conversation(chat.id).mode,
            { automatic: true, commit: result.commit },
          );
        } catch (failure) {
          result.selfRestart = { status: "failed", error: failure.message };
          emit("work", {
            kind: "self-restart",
            item: {
              title: "Self restart was not queued",
              description: failure.message,
            },
          });
        }
      }
      emit("work", {
        kind: "land-result",
        item: result.landed
          ? {
              title: `Landed on ${result.branch} · ${result.commit.slice(0, 7)}`,
              description: [
                `${result.commits} ${result.commits === 1 ? "commit" : "commits"}${result.checked ? `, checked with ${result.checked}` : ", no check command set"}.`,
                result.pushed
                  ? `Pushed to ${result.pushedTo}.`
                  : result.pushNote,
              ].join(" "),
            }
          : { title: "Not landed", description: result.reason },
      });
      return result;
    };
    if (project.worktree && chat.mode !== "ask")
      this.bridgeLand.set(token, land);
    // This request is always a user decision, never an action for the reviewer.
    // Restart the native session so its sandbox and collaboration mode agree.
    let suggestingMode = false,
      effectiveMode = chat.mode;
    const suggestMode = async (input) => {
      if (abort.signal.aborted)
        return { changed: false, reason: "Turn stopped." };
      checkMode(input.mode, run.provider);
      if (
        typeof input.reason !== "string" ||
        !input.reason.trim() ||
        input.reason.length > 4000
      )
        throw new Error("Explain the mode suggestion in 1–4,000 characters");
      if (
        input.mode === "goal" &&
        (typeof input.objective !== "string" ||
          !input.objective.trim() ||
          input.objective.length > 250000)
      )
        throw new Error(
          "Include a concrete Goal objective under 250,000 characters",
        );
      const current = this.store.conversation(chat.id);
      if (current.mode !== effectiveMode)
        return {
          changed: false,
          mode: current.mode,
          reason:
            "The user already changed the mode. Continue under their selection on the next message.",
        };
      if (input.mode === current.mode)
        return {
          changed: false,
          mode: current.mode,
          reason: "Already in this mode.",
        };
      if (current.mode === "goal")
        return {
          changed: false,
          mode: "goal",
          reason:
            "Goal mode stays on until the objective is met. Do not suggest another mode.",
        };
      if (suggestingMode)
        return {
          changed: false,
          reason: "A mode suggestion is already awaiting the user's decision.",
        };
      suggestingMode = true;
      try {
        const request = {
          kind: "mode-change",
          title: `Switch from ${current.mode} to ${input.mode}?`,
          fromMode: current.mode,
          mode: input.mode,
          reason: input.reason.trim(),
          ...(input.mode === "goal" && { objective: input.objective.trim() }),
        };
        const answer = await approve(request);
        if (!answer.allow || abort.signal.aborted)
          return {
            changed: false,
            mode: current.mode,
            reason:
              "The mode change was not approved. Continue in the current mode; do not repeat this suggestion.",
          };
        if (this.store.conversation(chat.id).mode !== current.mode)
          return {
            changed: false,
            reason:
              "The user changed the mode while this suggestion was pending. Their selection takes precedence.",
          };
        const active = this.active.get(chat.id);
        if (!active || active.cancelled || active.abort !== abort)
          return { changed: false, reason: "Turn stopped." };
        this.event(chat.id, null, "chat", this.setMode(chat.id, request.mode));
        active.modeChange = request;
        active.restart = true;
        abort.abort();
        emit("work", {
          kind: "mode-change",
          item: {
            title: `Applying ${request.mode} mode`,
            description: request.reason,
          },
        });
        return { changed: true, mode: request.mode };
      } finally {
        suggestingMode = false;
      }
    };
    this.bridgeModes.set(token, suggestMode);
    const askUser = async (input) =>
      approve({
        kind: "question",
        title: "The agent needs your input",
        questions: checkQuestions(input),
      });
    this.bridgeQuestions.set(token, askUser);
    const skills = invokedSkills(listSkills(this.store), text);
    if (skills.length)
      this.event(chat.id, run.id, "work", {
        kind: "skills",
        item: {
          title:
            skills.length === 1
              ? `Skill · ${skills[0].name}`
              : `Skills · ${skills.map((skill) => skill.name).join(", ")}`,
          description: "Invoked by a slash command in this message.",
        },
      });
    const firstMessage = messages.find((m) => m.role === "user");
    const needsRename =
      firstMessage &&
      chat.title ===
        provisionalTitle(firstMessage.content, firstMessage.attachments);
    const prefix = [
      agentInstructions(project, chat),
      QUESTION_INSTRUCTIONS,
      chat.mode === "plan" ? PLAN_INSTRUCTIONS : "",
      standingInstructions(rules),
      chat.mode === "goal" ? GOAL_INSTRUCTIONS : MODE_SUGGESTION_INSTRUCTIONS,
      delegationInstructions(plan, this.providers, COMMAND_SHELL),
      chat.mode === "ask" ? ASK_INSTRUCTIONS : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    // The rename line is repeated until the title is set. The rest of the
    // addendum is sent only when its text changes.
    const addendumBody = [skillInstructions(skills), notice]
      .filter(Boolean)
      .join("\n\n");
    const delivery = promptDelivery({
      provider: run.provider,
      session: savedSession,
      prefix,
      addendum: addendumBody,
    });
    const renameLine = needsRename ? renameInstructions(run.provider) : "";
    const noticeRulesSent = Boolean(
      savedSession.noticeRulesSent ||
      (notice.includes("While they are working:") && delivery.addendum),
    );
    const writeSession = (patch) => {
      const current = this.store.conversation(chat.id);
      const prev = current.sessions[run.provider];
      const base = prev && typeof prev === "object" ? prev : {};
      const next = { ...base, ...patch };
      if (JSON.stringify(base) === JSON.stringify(next)) return;
      this.store.updateConversation(chat.id, {
        sessions: { ...current.sessions, [run.provider]: next },
      });
    };
    writeSession({
      promptHash: delivery.promptHash,
      addendumHash: delivery.addendumHash,
      noticeRulesSent,
    });
    const ctx = {
      project,
      dataDir: this.dataDir,
      chat,
      attachments: files,
      text: continuationText,
      model: run.model,
      effort,
      permissions,
      mode: chat.mode,
      continuing,
      startGoal,
      goalObjective: startGoal ? modeChange.objective : undefined,
      // An approved plan ends plan mode, so the chat goes on to build it.
      planApproved: () => {
        effectiveMode = "default";
        this.event(
          chat.id,
          null,
          "chat",
          this.store.updateConversation(chat.id, { mode: "default" }),
        );
      },
      session,
      handoff,
      instructions: delivery.instructions,
      addendum: [delivery.addendum, renameLine].filter(Boolean).join("\n\n"),
      firstTurn: messages.filter((m) => m.role === "user").length === 1,
      tools: [
        ...hostToolsForMode(chat.mode, [
          ...historyTools,
          askUserTool,
          ...(chat.mode === "goal" ? [] : [modeSuggestionTool]),
          ...(project.worktree ? [landTool] : []),
          ...((await this.selfRestart?.eligible(home.path, chat.mode))
            ? [restartTool]
            : []),
          ...plan.tools,
        ]),
        ...browserTools,
      ],
      browser,
      signal: abort.signal,
      // The provider calls this once its session can take another user message.
      attachSteer: (deliver) => {
        const current = this.active.get(chat.id);
        if (!current) return;
        current.deliverSteer = deliver;
        this.flushSteers(chat.id);
      },
      emit,
      billingConfirmation: this.store.setting("cursor-billing"),
      learnEfforts: (options) => this.learnCursorEfforts(options),
      saveSession: (incoming) => writeSession(incoming),
      goalState: (status) => {
        // A stopped/replaced runner cannot release a newer session's hold.
        if (abort.signal.aborted || this.active.get(chat.id)?.run.id !== run.id)
          return;
        // Claude labels every billing stop usageLimited. A native Goal that
        // actually reached its usage limit has no earlier, different reason.
        if (
          status === "usageLimited" &&
          (!billingStop || isUsageExhausted(billingStop))
        )
          noteUsageStop("A provider usage limit has been reached.");
        const updated = this.store.setGoalState(
          chat.id,
          run.provider,
          run.id,
          status,
        );
        this.event(chat.id, run.id, "chat", updated);
      },
      history: async (name, args) => {
        const input =
          typeof args === "string" ? JSON.parse(args) : (args ?? {});
        if (chat.mode === "ask" && !askHostAllowed(name))
          return { error: ASK_DENY };
        if (name === "suggest_mode") return suggestMode(input);
        if (name === "ask_user") return askUser(input);
        if (name === "restart_harness") return this.requestSelfRestart(chat.id);
        if (name === "land_changes")
          return project.worktree
            ? land()
            : { error: "This chat works in the shared project folder." };
        if (name === "move_chat")
          return this.requestChatMove(chat.id, input.directory);
        if (isDelegationTool(name))
          return delegator
            ? delegator.handle(name, input)
            : {
                error: "Nothing can be handed off this turn.",
                instruction: "Do this yourself.",
              };
        const result = historyCall(
          this.store,
          chat.id,
          name,
          input,
          this.dataDir,
        );
        if (name === "rename_chat" && result.renamed)
          this.event(chat.id, null, "chat", this.store.conversation(chat.id));
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
      if (
        !usageStopReason &&
        sawWork &&
        !abort.signal.aborted &&
        isUsageExhausted(error)
      )
        usageStopReason = error;
    } catch (caught) {
      status = abort.signal.aborted ? "cancelled" : "failed";
      error = caught.message;
      if (
        !usageStopReason &&
        sawWork &&
        !abort.signal.aborted &&
        isUsageExhausted(error)
      )
        usageStopReason = error;
    } finally {
      await reviewer?.close();
      this.store.expireApprovals(run.id);
      this.bridgeTokens.delete(token);
      this.bridgeBrowser.delete(token);
      this.bridgeLand.delete(token);
      this.bridgeModes.delete(token);
      this.bridgeQuestions.delete(token);
      for (const [id, waiter] of this.approvalWaiters)
        if (waiter.runId === run.id) {
          waiter.resolve({ allow: false });
          this.approvalWaiters.delete(id);
        }
    }
    const active = this.active.get(chat.id);
    if (active?.restart && !active.cancelled) {
      active.deliverSteer = null;
      active.restart = false;
      const nextModeChange = active.modeChange;
      active.modeChange = null;
      active.abort = new AbortController();
      this.store.setRun(run.id, "running");
      return this.execute(
        run,
        text,
        effort,
        active.abort,
        true,
        nextModeChange,
      );
    }
    if (active?.goalStopRequested) this.store.stopGoals(chat.id);
    else {
      const goal = this.store.conversation(chat.id)?.sessions[run.provider]
        ?.goal;
      if (goal?.runId === run.id && !goalStopped(goal.status))
        this.store.setGoalState(chat.id, run.provider, run.id, "unknown");
    }
    // A quota poll can interrupt the native turn. Keep that as a failed turn
    // with the usage reason, not as a host restart.
    if (usageStopReason && !abort.signal.aborted) {
      status = "failed";
      error = usageStopReason;
      this.store.setUsageStop(chat.id, usageStopReason);
    }
    this.store.setRun(run.id, status, null, error ?? null);
    this.requeuePending(active);
    this.event(chat.id, run.id, "run", {
      status,
      error,
      provider: run.provider,
      model: run.model,
    });
    if (active?.pendingMove)
      await this.finishChatMove(chat.id, active.pendingMove).catch(
        (failure) => {
          this.event(chat.id, null, "work", {
            kind: "chat-move-failed",
            item: {
              title: "Chat was not moved",
              description: failure.message,
            },
          });
        },
      );
    this.active.delete(chat.id);
    this.event(chat.id, null, "chat", this.store.conversation(chat.id));
    if (!active?.pendingMove && project?.worktree) this.tidy(chat.id);
    this.releaseQueue(chat.id);
  }
  // A Goal question waits out its deadline, then the agent chooses. Any other
  // call still waits until the user answers or the turn stops.
  async answerGoalQuestion(chatId, run, request, signal) {
    const active = this.active.get(chatId);
    if (active) {
      active.goalQuestions ??= new Set();
      active.goalTimeouts ??= 0;
    }
    const key = questionKey(request);
    const outcome = () => ({
      allow: true,
      timedOut: true,
      answers: goalQuestionAnswers(request.questions),
      reason: GOAL_QUESTION_TIMEOUT,
    });
    const repeated =
      active &&
      ((key && active.goalQuestions.has(key)) ||
        active.goalTimeouts >= GOAL_QUESTION_LIMIT);
    if (repeated) {
      this.event(chatId, run.id, "work", {
        kind: "goal-question",
        item: {
          title: "The agent is choosing",
          description:
            key && active.goalQuestions.has(key)
              ? "This question already timed out. " + GOAL_QUESTION_TIMEOUT
              : "Three questions already timed out. " + GOAL_QUESTION_TIMEOUT,
        },
      });
      return outcome();
    }
    const answer = await this.waitApproval(run, request, signal, {
      timeoutMs: this.goalQuestionTimeoutMs,
    });
    if (answer.timedOut && active) {
      active.goalTimeouts += 1;
      if (key) active.goalQuestions.add(key);
    }
    return answer;
  }
  waitApproval(run, request, signal, { timeoutMs = 0 } = {}) {
    if (signal.aborted) return Promise.resolve({ allow: false });
    const stored =
      timeoutMs > 0
        ? { ...request, deadline: Date.now() + timeoutMs }
        : request;
    const approval = this.store.addApproval(
      run.conversation_id,
      run.id,
      run.provider,
      stored,
    );
    this.store.setRun(run.id, "waiting");
    let timer;
    const response = new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        this.approvalWaiters.delete(approval.id);
        this.store.expireApprovals(run.id);
        resolve({ allow: false });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.approvalWaiters.set(approval.id, {
        runId: run.id,
        resolve: (answer) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          this.approvalWaiters.delete(approval.id);
          this.store.setRun(run.id, "running");
          resolve(answer);
        },
      });
      if (timeoutMs > 0)
        timer = setTimeout(() => {
          const result = {
            allow: true,
            timedOut: true,
            answers: goalQuestionAnswers(request.questions),
            reason: GOAL_QUESTION_TIMEOUT,
          };
          if (!this.store.resolveApproval(approval.id, result)) return;
          this.event(run.conversation_id, run.id, "approval-resolved", {
            id: approval.id,
            response: result,
          });
          this.event(run.conversation_id, run.id, "work", {
            kind: "goal-question",
            item: {
              title: "No answer in time. The agent is choosing.",
              description: GOAL_QUESTION_TIMEOUT,
            },
          });
          this.approvalWaiters.get(approval.id)?.resolve(result);
        }, timeoutMs);
    });
    this.event(run.conversation_id, run.id, "approval", approval);
    return response;
  }
  answer(id, answer) {
    const approval = this.store.approval(id);
    if (!approval) throw new Error("Approval not found");
    if (approval.status === "resolved") return approval;
    if (
      answer.allow === true &&
      approval.request.kind === "plan" &&
      !approval.request.plan?.trim()
    )
      throw new Error(
        "The complete plan must be available before confirmation",
      );
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
      active.goalStopRequested = true;
      active.abort.abort();
      this.event(chatId, active.run.id, "work", {
        kind: "cancellation",
        text: "Stop requested. Waiting for the agent to acknowledge.",
      });
    } else if (this.store.stopGoals(chatId)) {
      this.event(chatId, null, "chat", this.store.conversation(chatId));
      this.event(chatId, null, "work", {
        kind: "cancellation",
        text: "Goal stopped at your request.",
      });
      return { requested: true };
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
