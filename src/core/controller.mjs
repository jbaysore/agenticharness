import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCodex, runCodex } from "../providers/codex.mjs";
import { inspectClaude, runClaude } from "../providers/claude.mjs";
import { runOpenRouter } from "../providers/openrouter-runner.mjs";
import {
  inspectCursor,
  learnCursorEfforts,
  runCursor,
} from "../providers/cursor.mjs";
import {
  agentInstructions,
  handoffContext,
  historyCall,
  independentDeliveryEnabled,
  promptDelivery,
  provisionalTitle,
  renameInstructions,
  workspaceNotice,
  workspacePeers,
} from "./history.mjs";
import { projectPath, repositoryState } from "./repository.mjs";
import {
  isMemoryTool,
  MEMORY_INSTRUCTIONS,
  memorySources,
  projectFolder,
} from "./memory-web.mjs";
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
  GOAL_RESUME_TEXT,
  MODE_SUGGESTION_INSTRUCTIONS,
  askHostAllowed,
  checkMode,
  goalQuestionAnswers,
  questionKey,
  usageContinuationText,
  usageGoalPrompt,
} from "./modes.mjs";
import {
  invokedSkills,
  listSkills,
  prepareMessage,
  skillInstructions,
} from "./skills.mjs";
import { isDelegationTool } from "./delegation.mjs";
import { Delegator } from "./delegator.mjs";
import { COMMAND_SHELL, runCommand } from "./commands.mjs";
import { commandInstructions } from "./command-shells.mjs";
import { executeCommand } from "./command-tool.mjs";
import { Reliability } from "./reliability-service.mjs";
import { browserGateway, browserTitle } from "./browser.mjs";
import { checkQuestions, QUESTION_INSTRUCTIONS } from "./questions.mjs";
import { proposalText, taggedProposal, PLAN_INSTRUCTIONS } from "./plans.mjs";
import {
  attachmentContext,
  attachmentInfo,
  resolveAttachments,
} from "./attachments.mjs";
import { runClaudeWorker, runCodexWorker } from "../providers/workers.mjs";
import { ActionReviewer } from "./reviewer.mjs";
import { PlanReviewer } from "./plan-review.mjs";
import { hostTools, hostToolsKey, toolFingerprint } from "./host-tools.mjs";
import { blockingGoals, goalStopped, resumableGoals } from "./goals.mjs";
import { Watchers } from "./watchers.mjs";
import { isWatchTool, WATCH_INSTRUCTIONS } from "./watch-tools.mjs";
import { isUsageExhausted } from "../security/billing.mjs";
import { usageWindows } from "../ui/status.mjs";
import {
  createWorktree,
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
      openrouter = null,
      memoryWeb = null,
      watcherOptions = {},
    },
  ) {
    super();
    this.store = store;
    // Shared cross-project knowledge (Memory Web); null leaves it out.
    this.memoryWeb = memoryWeb;
    this.probePath = probePath;
    this.dataDir = dataDir;
    this.bridgeUrl = bridgeUrl;
    this.openrouter = openrouter;
    this.providers = [];
    this.active = new Map();
    this.approvalWaiters = new Map();
    this.bridgeTokens = new Map();
    this.browser = browser;
    this.bridgeBrowser = new Map();
    this.bridgeLand = new Map();
    this.bridgeModes = new Map();
    this.bridgeQuestions = new Map();
    this.bridgeCommands = new Map();
    // Where every new chat gets its own worktree.
    this.worktreeRoot = worktreeRoot;
    // Worktree removals in progress, by chat, so a new turn waits for them.
    this.tidying = new Map();
    this.runners = { codex: runCodex, claude: runClaude, cursor: runCursor };
    if (openrouter) {
      this.runners.openrouter = (ctx) => runOpenRouter({ ...ctx, openrouter });
      this.openrouterChanged = () => {
        for (const [chatId, work] of this.active) {
          if (work.run.provider !== "openrouter") continue;
          this.event(chatId, work.run.id, "work", { kind: "policy-stop", item: { title: "OpenRouter settings changed", description: "The turn stopped. Send a message to continue under the current allowlist and data-sharing consent." } });
          this.cancel(chatId);
        }
        this.refreshOpenRouter().catch(() => {});
      };
      openrouter.on("change", this.openrouterChanged);
    }
    this.workers = { claude: runClaudeWorker, codex: runCodexWorker };
    this.openReviewer = openReviewerOption;
    this.planReviewJobs = new Map();
    this.planReviewTasks = new Set();
    this.planReviewFolders = new Map();
    this.workerTimeoutMs = 5 * 60 * 1000;
    this.reviewerTimeoutMs = 60 * 1000;
    this.reviewerTotalTimeoutMs = 120 * 1000;
    this.planReviewTimeoutMs = 3 * 60 * 1000;
    this.planReviewTotalTimeoutMs = 5 * 60 * 1000;
    this.goalQuestionTimeoutMs = GOAL_QUESTION_TIMEOUT_MS;
    this.runCommand = runCommand;
    store.recover();
    this.watchers = new Watchers(this, watcherOptions);
    this.reliability = new Reliability(this);
  }
  event(chatId, runId, type, payload) {
    const e = this.store.appendEvent(chatId, runId, type, payload);
    this.emit("event", e);
    this.reliability?.observe(e);
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
      if (this.openrouter) {
        functions.push(() => this.openrouter.inspect({ refresh: true }));
        ids.push("openrouter");
        names.push("OpenRouter");
      }
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
      this.scheduleProviderRefresh();
      return this.providers;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  async refreshOpenRouter() {
    if (!this.openrouter) return;
    const provider = await this.openrouter.inspect();
    this.providers = [...this.providers.filter((p) => p.id !== "openrouter"), provider];
    this.event(null, null, "providers", { providers: this.providers });
  }
  // Provider usage is only read on demand. Retry failed lookups at the monitor's
  // backoff deadline even while idle, and re-read quota windows after reset.
  scheduleProviderRefresh(now = Date.now()) {
    clearTimeout(this.providerTimer);
    const resets = [],
      retries = [];
    let overdue = false;
    for (const p of this.providers) {
      if (p.usage?.lookupProblem) {
        const retryAt = Date.parse(p.usage.nextCheckAt);
        if (Number.isFinite(retryAt))
          retries.push(Math.max(1000, retryAt - now));
      }
      const windows = usageWindows(p);
      // Out of usage with no reset still ahead: ask again soon.
      if (
        isUsageExhausted(p.blockReason) &&
        !windows.some((w) => w.resetsAt > now)
      )
        overdue = true;
      for (const w of windows) {
        if (w.remaining === 0 && !(w.resetsAt > now)) overdue = true;
        if (w.resetsAt) resets.push(w.resetsAt);
      }
    }
    const next = Math.min(...resets.filter((at) => at > now)),
      delay = Math.min(
        ...retries,
        Number.isFinite(next) ? next - now + 5000 : Infinity,
        overdue ? 60000 : Infinity,
      );
    if (!Number.isFinite(delay)) return;
    this.providerTimer = setTimeout(
      () => this.refreshProviders().catch(() => this.scheduleProviderRefresh()),
      Math.min(delay, 2 ** 31 - 1),
    );
    this.providerTimer.unref?.();
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
  send(chatId, input, releasing = false, watchOrigin = null) {
    const prepared = this.prepareSend(chatId, input);
    if (prepared.duplicate) return prepared.duplicate;
    this.selfRestart?.assertAdmission();
    const active = this.active.get(chatId);
    if (!releasing && (!watchOrigin || watchOrigin.manual)) {
      this.watchers.invalidate(chatId, "New user instructions superseded automatic follow-up.");
      if (active) active.supersededByUser = true;
    }
    prepared.watchOrigin = watchOrigin;
    if (
      prepared.resumeGoal &&
      (active || this.store.queuedInputs(chatId).length)
    )
      throw new Error("Resume the Goal after this chat's current work ends");
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
      resumeGoal = false,
      continueAfterUsage = false,
    },
  ) {
    const chat = this.store.conversation(chatId);
    if (!chat) throw new Error("Conversation not found");
    let continuedGoalObjective, continuedGoalPrompt;
    // Resuming reactivates the saved Goal; the message only marks the turn.
    if (resumeGoal) {
      if (!resumableGoals(chat).some((g) => g.provider === provider))
        throw new Error(
          "This agent has no paused Goal to resume. Send the objective as a new Goal.",
        );
      mode = "goal";
      parsed = true;
      if (typeof text !== "string" || !text.trim()) text = GOAL_RESUME_TEXT;
    }
    // A usage stop continues on another provider. The host writes the prompt
    // so the next agent is told to pick up, and a Goal keeps its objective.
    if (continueAfterUsage) {
      if (resumeGoal)
        throw new Error(
          "Resume the Goal or continue with a new provider, not both.",
        );
      if (!chat.usage_stopped_at)
        throw new Error("This chat is not stopped because usage ran out");
      if (provider === chat.provider)
        throw new Error(
          "Choose a different provider. This one is out of included usage.",
        );
      parsed = true;
      mode = mode ?? chat.mode;
      const from =
        this.providers.find((p) => p.id === chat.provider)?.name ||
        chat.provider;
      const objective =
        resumableGoals(chat).find((goal) => goal.provider === chat.provider)
          ?.objective || null;
      text = usageContinuationText({ from, mode, objective });
      if (mode === "goal") {
        continuedGoalObjective = objective || text;
        continuedGoalPrompt = usageGoalPrompt({
          from,
          objective,
          fallback: text,
        });
      }
    }
    if (typeof text !== "string" || text.length > 250000)
      throw new Error("Enter a message under 250,000 characters");
    if (typeof actionId !== "string" || !/^[-\w]{16,100}$/.test(actionId))
      throw new Error("A stable action ID is required");
    if (!["codex", "claude", "cursor", "openrouter"].includes(provider))
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
    if (provider === "openrouter") this.openrouter?.check(model);
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
      resumeGoal: Boolean(resumeGoal),
      continueAfterUsage: Boolean(continueAfterUsage),
      continuedGoalObjective,
      continuedGoalPrompt,
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
      text: prepared.watchOrigin ? this.watchers.displayText(prepared.watchOrigin.id) : prepared.text,
      source: prepared.watchOrigin ? "watcher" : null,
      attachments: prepared.files.map(attachmentInfo),
    });
    const abort = new AbortController();
    this.active.set(chatId, {
      run,
      abort,
      pendingSteers: [],
      resumeGoal: prepared.resumeGoal,
      continueAfterUsage: prepared.continueAfterUsage,
      continuedGoalObjective: prepared.continuedGoalObjective,
      continuedGoalPrompt: prepared.continuedGoalPrompt,
      watchOrigin: prepared.watchOrigin,
    });
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
    active.taskRootId = prepared.actionId;
    active.supersededByUser = false;
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
      if (active.watchYield) {
        clearTimeout(active.watchYield.timer);
        active.watchYield = null;
        this.watchers.invalidate(chatId, "Permission settings changed while the turn was yielding.");
      }
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
    if (mode !== chat.mode) this.watchers.invalidate(chatId, "The chat mode changed. Automatic follow-up was revoked.");
    return this.store.updateConversation(chatId, { mode });
  }
  // The folder a chat works in: its own worktree, created on its first turn,
  // or the project folder when that is not a Git repository on a branch or the
  // chat began before worktrees were given to every chat. Explicit moves reset
  // the native session before changing this folder.
  async chatFolder(chat, home, run) {
    if (home.scratch) {
      await mkdir(home.path, { recursive: true });
      return home;
    }
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
    this.watchers.invalidate(chatId, "The chat is moving to another directory.", true);
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
    if (!chat?.worktree || !home || this.active.has(chatId) || this.reviewingPlans(chatId)) return;
    const done = (this.tidying.get(chatId) ?? Promise.resolve())
      .then(() => this.active.has(chatId) || this.reviewingPlans(chatId)
        ? false : tidyWorktree(home.path, chat.worktree))
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
    const activeEntry = this.active.get(chat.id);
    const resumeGoal = chat.mode === "goal" && Boolean(activeEntry?.resumeGoal);
    const continueAfterUsage = Boolean(activeEntry?.continueAfterUsage);
    const savedGoal = chat.sessions[run.provider]?.goal;
    if (
      chat.mode === "goal" ||
      blockingGoals(chat).some((g) => g.provider === run.provider)
    )
      this.store.setGoalState(
        chat.id,
        run.provider,
        run.id,
        "starting",
        // A new Goal message replaces the objective; resuming or continuing
        // keeps the saved one until the provider reports its own. A usage
        // handoff keeps the stopped Goal's objective instead of the prompt.
        modeChange?.mode === "goal" && chat.mode === "goal"
          ? modeChange.objective
          : chat.mode === "goal" && !resumeGoal && !continuing
            ? continueAfterUsage
              ? activeEntry.continuedGoalObjective
              : text
            : undefined,
      );
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
    let contextSessionId = null;
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
      usageFlag = Boolean(this.store.conversation(chat.id)?.usage_stopped_at);
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
      if (type === "context-usage") {
        if (abort.signal.aborted || this.active.get(chat.id)?.run.id !== run.id || payload.sessionId !== contextSessionId) return;
        this.event(chat.id, run.id, type, { ...payload, provider: run.provider, runId: run.id });
        return;
      }
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
    const memoryProject = projectFolder(this.store.project(chat.project_id));
    const memory = this.memoryWeb
      ? await this.memoryWeb.context(requestText, memoryProject)
      : "";
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
    // Codex takes a thread's tools only when the thread starts. A thread that
    // started with a different set gets one fresh start with a handoff,
    // unless a Goal that lives in that thread is still open.
    const saved = chat.sessions[run.provider],
      session =
        run.provider === "codex" &&
        saved?.id &&
        saved.tools !== hostToolsKey &&
        (!saved.goal || ["complete", "cleared"].includes(saved.goal.status))
          ? undefined
          : saved;
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
    // draft would change the project or prepare a commit, so the instructions
    // leave them out and the host refuses them. The tools stay offered, so a
    // native session keeps them after the mode changes.
    let plan = planDelegation(rules, this.providers, run, this.store);
    if (chat.mode === "ask")
      plan = {
        ...plan,
        actions: { ...plan.actions, edit: false, run: false, draft: false },
      };
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
    // Ask mode refuses page changes when they are called, below.
    const browserTools = this.browser
      ? await this.browser.tools().then(
          (tools) =>
            tools.length
              ? [browserGateway(tools)].map(
                  ({ name, description, inputSchema }) => ({
                    name,
                    description,
                    inputSchema,
                  }),
                )
              : [],
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
      if (!worktree)
        return { error: "This chat works in the shared project folder." };
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
        result: { landed: result.landed, checked: result.checked, commit: result.commit },
        root: project.path,
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
    const command = (input) =>
      executeCommand(input, {
        project,
        approve,
        signal: abort.signal,
        emit,
        run: (options) => this.runCommand(options),
      });
    this.bridgeCommands.set(token, command);
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
      chat.mode === "ask" ? "" : commandInstructions(project),
      this.memoryWeb ? MEMORY_INSTRUCTIONS : "",
      QUESTION_INSTRUCTIONS,
      WATCH_INSTRUCTIONS,
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
    const blocks = [
      { key: "skills", text: skillInstructions(skills), repeat: skills.length > 0 && !continuing },
      { key: "memory-web", text: memory },
      { key: "workspace", text: notice, clear: "Workspace update: no other Harness chats are currently working in this directory. Other chats can start later; continue to check workspace_activity before committing." },
    ];
    const addendumBody = blocks.map((b) => b.text)
      .filter(Boolean)
      .join("\n\n");
    const delivery = promptDelivery({
      provider: run.provider,
      session: savedSession,
      prefix,
      addendum: addendumBody,
      blocks,
      independent: independentDeliveryEnabled(run.provider, this.store.setting("prompt-delivery-v2")),
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
    let promptAccepted = false;
    this.event(chat.id, run.id, "prompt-cache", {
      promptHash: delivery.promptHash,
      toolsHash: toolFingerprint([...hostTools, ...plan.tools, ...browserTools]),
      deliveredBlocks: delivery.deliveredBlocks,
      addendumBytes: Buffer.byteLength(delivery.addendum),
      independent: independentDeliveryEnabled(run.provider, this.store.setting("prompt-delivery-v2")),
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
      resumeGoal,
      goalObjective: startGoal
        ? modeChange.objective
        : resumeGoal
          ? savedGoal?.objective
          : continueAfterUsage && chat.mode === "goal" && !continuing
            ? activeEntry?.continuedGoalPrompt
            : undefined,
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
      context: this.store.contextByProvider(chat.id)[run.provider],
      promptAccepted: () => {
        const saved = this.store.conversation(chat.id)?.sessions[run.provider];
        if (promptAccepted || abort.signal.aborted || !contextSessionId || this.active.get(chat.id)?.run.id !== run.id || (saved?.deliveryGeneration ?? 0) !== delivery.generation) return;
        promptAccepted = true;
        writeSession({
          promptHash: delivery.promptHash,
          addendumHash: delivery.addendumHash,
          blockHashes: delivery.blockHashes,
          acceptedGeneration: delivery.generation,
          noticeRulesSent,
        });
      },
      invalidatePromptDelivery: () => {
        if (abort.signal.aborted || this.active.get(chat.id)?.run.id !== run.id) return;
        const saved = this.store.conversation(chat.id)?.sessions[run.provider];
        writeSession({ deliveryGeneration: (saved?.deliveryGeneration ?? 0) + 1 });
      },
      handoff,
      // Cursor can discard a saved id that was never stored. The transcript
      // is built only then, so a live session is not resent every turn.
      ensureHandoff: () => {
        if (ctx.handoff || messages.length <= 1) return;
        ctx.handoff = handoffContext(
          this.store,
          chat,
          run.provider,
          this.dataDir,
        );
        this.event(chat.id, run.id, "handoff", {
          from: lastAgent ?? "archive",
          to: run.provider,
          scope: chat.scope,
          source: `harness://conversation/${chat.id}`,
        });
      },
      instructions: delivery.instructions,
      addendum: [delivery.addendum, renameLine].filter(Boolean).join("\n\n"),
      firstTurn: messages.filter((m) => m.role === "user").length === 1,
      tools: [...hostTools, ...plan.tools, ...browserTools],
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
      // A Codex thread started this turn records the tools it was given.
      saveSession: (incoming) => {
        if (this.active.get(chat.id)?.abort !== abort) return;
        if (incoming?.id) contextSessionId = incoming.id;
        writeSession(
          run.provider === "codex" && !session?.id && incoming?.id
            ? { ...incoming, tools: hostToolsKey }
            : incoming,
        );
      },
      goalState: (status, objective) => {
        // A stopped/replaced runner cannot release a newer session's hold.
        if (abort.signal.aborted || this.active.get(chat.id)?.run.id !== run.id)
          return;
        const updated = this.store.setGoalState(
          chat.id,
          run.provider,
          run.id,
          status,
          typeof objective === "string" && objective.trim()
            ? objective
            : undefined,
        );
        this.event(chat.id, run.id, "chat", updated);
      },
      watchParked: () => {
        if (abort.signal.reason?.kind === "watch-yield" && this.active.get(chat.id)?.run.id === run.id)
          this.active.get(chat.id).watchParkAcknowledged = true;
      },
      history: async (name, args) => {
        const input =
          typeof args === "string" ? JSON.parse(args) : (args ?? {});
        if (chat.mode === "ask" && !askHostAllowed(name))
          return { error: ASK_DENY };
        if (name === "suggest_mode") return suggestMode(input);
        if (name === "ask_user") return askUser(input);
        if (name === "run_command") return command(input);
        if (isWatchTool(name)) return this.watchers.handle(chat.id, name, input);
        if (name === "restart_harness")
          return this.requestSelfRestart(chat.id).catch((failure) => ({
            error: failure.message,
          }));
        if (name === "land_changes") return land();
        if (name === "move_chat")
          return this.requestChatMove(chat.id, input.directory);
        if (isMemoryTool(name)) {
          const result = this.memoryWeb
            ? await this.memoryWeb.call(name, input, {
                project: memoryProject,
                author: {
                  provider: run.provider,
                  model: run.model,
                  conversation: `harness://conversation/${chat.id}`,
                },
              })
            : { error: "Memory Web is not enabled in this Harness." };
          emit("work", {
            kind: "history-tool",
            name,
            scope: chat.scope,
            sources: memorySources(name, result),
          });
          return result;
        }
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
      const reading = this.store.contextByProvider(chat.id)[run.provider];
      if (reading?.runId === run.id && (abort.signal.aborted || status === "failed"))
        this.event(chat.id, run.id, "context-usage", { ...reading, state: reading.usedTokens === null ? "unavailable" : "outdated" });
      this.store.expireApprovals(run.id);
      this.bridgeTokens.delete(token);
      this.bridgeBrowser.delete(token);
      this.bridgeLand.delete(token);
      this.bridgeModes.delete(token);
      this.bridgeQuestions.delete(token);
      this.bridgeCommands.delete(token);
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
    const parked = Boolean(active?.watchYield && active.watchParkAcknowledged && !active.cancelled && !usageStopReason && !billingStop);
    if (active?.watchYield) clearTimeout(active.watchYield.timer);
    if (parked) {
      status = "completed";
      error = null;
      if (chat.mode === "goal") this.store.setGoalState(chat.id, run.provider, run.id, "waiting");
      this.watchers.parked(chat.id, active);
    } else if (active?.goalStopRequested) this.store.stopGoals(chat.id);
    else {
      const goal = this.store.conversation(chat.id)?.sessions[run.provider]
        ?.goal;
      // Resuming a native session can replay its previous usageLimited state
      // before reactivating the Goal. Only its final state belongs to this
      // turn; an explicit billing stop above still keeps its own reason.
      // Claude also uses usageLimited for billing/setup stops, so preserve a
      // more specific reason instead of calling those exhausted usage.
      if (
        goal?.runId === run.id &&
        goal.status === "usageLimited" &&
        (!billingStop || isUsageExhausted(billingStop))
      )
        noteUsageStop("A provider usage limit has been reached.");
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
    if (active?.watchYield && !parked) {
      this.watchers.invalidate(chat.id, "The turn did not confirm suspension. CI will only notify.");
      if (!active.cancelled && !usageStopReason && !billingStop) {
        status = "failed";
        error ||= "The agent did not confirm suspension. CI is notification only; continue manually.";
      }
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
    this.watchers.kick();
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
  reviewingPlans(chatId) {
    return [...this.planReviewJobs.values()].some((job) => job.chatId === chatId);
  }
  reviewFolder(chat) {
    // Several plans in one chat can be reviewed together. Share restoration,
    // and keep cleanup away until the last review releases the folder.
    if (!this.planReviewFolders.has(chat.id))
      this.planReviewFolders.set(chat.id, this.prepareReviewFolder(chat));
    return this.planReviewFolders.get(chat.id);
  }
  async prepareReviewFolder(chat) {
    // An idle chat's landed worktree may already be removed or being removed.
    await this.tidying.get(chat.id);
    const home = this.store.project(chat.project_id);
    if (!home) throw new Error("Project not found");
    try {
      if (chat.worktree?.path) {
        await restoreWorktree(home.path, chat.worktree);
        return { ...home, path: await projectPath(chat.worktree.path), home: home.path, worktree: chat.worktree };
      }
      return { ...home, path: await projectPath(home.path) };
    } catch (error) {
      throw new Error(`The plan review folder could not be prepared: ${error.message}`);
    }
  }
  planText(chat, run, approvalId) {
    if (approvalId) {
      const approval = this.store.approval(approvalId);
      if (
        !approval ||
        approval.conversation_id !== chat.id ||
        approval.run_id !== run.id ||
        approval.request?.kind !== "plan"
      )
        throw new Error("Plan not found");
      return approval.request.plan ?? "";
    }
    return this.store.proposedPlans(chat.id)[run.id] ?? "";
  }
  // Advice for the user. It never resolves the plan or resumes its agent.
  reviewPlan({ chatId, runId, approvalId } = {}) {
    const chat = this.store.conversation(chatId);
    if (!chat) throw new Error("Conversation not found");
    const run = this.store.run(runId);
    if (!run || run.conversation_id !== chat.id)
      throw new Error("Plan not found");
    if (this.planReviewJobs.has(run.id))
      return this.store.planReview(chat.id, run.id);
    const plan = this.planText(chat, run, approvalId);
    if (typeof plan !== "string" || !plan.trim())
      throw new Error("The complete plan must be available before review");
    const abort = new AbortController();
    this.planReviewJobs.set(run.id, { chatId: chat.id, abort });
    this.recordPlanReview(chat, run, {
      status: "running",
      reviewer: null,
      result: null,
      error: null,
    });
    const task = this.finishPlanReview({ chat, run, plan, abort });
    this.planReviewTasks.add(task);
    task.finally(() => {
      this.planReviewTasks.delete(task);
      if (this.planReviewJobs.get(run.id)?.abort === abort)
        this.planReviewJobs.delete(run.id);
      if (!this.reviewingPlans(chat.id)) {
        this.planReviewFolders.delete(chat.id);
        this.tidy(chat.id);
      }
    });
    return this.store.planReview(chat.id, run.id);
  }
  recordPlanReview(chat, run, { status, reviewer, result, error }) {
    if (!this.store.conversation(chat.id)) return null;
    const saved = this.store.savePlanReview({
      conversationId: chat.id,
      runId: run.id,
      status,
      reviewer,
      result,
      error,
    });
    const assessments = {
      sound: "Sound",
      sound_with_suggestions: "Sound with suggestions",
      needs_revision: "Needs revision",
    };
    const title =
      status === "running"
        ? reviewer
          ? `Reviewing with ${reviewer.name}`
          : "Reviewing the plan"
        : status === "done"
          ? `Independent review: ${assessments[result?.assessment] ?? "Complete"}`
          : status === "cancelled"
            ? "Independent review cancelled"
            : "Independent review failed";
    this.event(chat.id, run.id, "work", {
      kind: "plan-review",
      status,
      item: {
        id: run.id,
        title,
        description: result?.summary || error || "",
      },
    });
    this.event(chat.id, run.id, "plan-review", {
      runId: run.id,
      status,
    });
    return saved;
  }
  async finishPlanReview({ chat, run, plan, abort }) {
    let reviewer = null;
    try {
      const reviewed = await new PlanReviewer({
        controller: this,
        run,
        project: await this.reviewFolder(chat),
        chat,
        plan,
        signal: abort.signal,
        onAttempt: (next) => {
          reviewer = next;
          this.recordPlanReview(chat, run, {
            status: "running",
            reviewer,
            result: null,
            error: null,
          });
        },
      }).review();
      if (abort.signal.aborted || !this.store.conversation(chat.id)) return;
      this.recordPlanReview(chat, run, {
        status: "done",
        reviewer: reviewed.reviewer,
        result: reviewed.result,
        error: null,
      });
    } catch (error) {
      if (!this.store.conversation(chat.id)) return;
      this.recordPlanReview(chat, run, {
        status: abort.signal.aborted ? "cancelled" : "failed",
        reviewer,
        result: null,
        error: abort.signal.aborted
          ? "The plan review was cancelled."
          : error.message,
      });
    }
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
    if (
      approval.request.kind === "plan" &&
      !result.allow &&
      typeof answer.reason === "string" &&
      answer.reason.trim()
    )
      result.reason = answer.reason.trim();
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
    this.watchers.invalidate(chatId, "Stop revoked automatic follow-up.");
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
        text: "Goal paused at your request. Resume it any time.",
      });
      return { requested: true };
    }
    return { requested: !!active };
  }
  async close() {
    clearTimeout(this.providerTimer);
    await this.watchers.close();
    this.openrouter?.off("change", this.openrouterChanged);
    this.openrouter?.close();
    for (const { abort } of this.planReviewJobs.values()) abort.abort();
    const active = [...this.active.values()];
    for (const work of active) {
      work.cancelled = true;
      work.abort.abort();
    }
    await Promise.allSettled([
      ...active.map((a) => a.task),
      ...this.planReviewTasks,
      this.refreshing,
    ]);
    this.browser?.close();
    await this.memoryWeb?.close();
  }
}
