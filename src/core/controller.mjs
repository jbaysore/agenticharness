import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
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
  provisionalTitle,
  renameInstructions,
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
import {
  ASK_DENY,
  ASK_INSTRUCTIONS,
  MODE_SUGGESTION_INSTRUCTIONS,
  askHostAllowed,
  checkMode,
  hostToolsForMode,
  modeSuggestionTool,
} from "./modes.mjs";
import { invokedSkills, listSkills, skillInstructions } from "./skills.mjs";
import { isDelegationTool, offeredTools } from "./delegation.mjs";
import { Delegator } from "./delegator.mjs";
import { COMMAND_SHELL, runCommand } from "./commands.mjs";
import { browserTitle } from "./browser.mjs";
import {
  attachmentContext,
  attachmentInfo,
  resolveAttachments,
} from "./attachments.mjs";
import { runClaudeWorker, runCodexWorker } from "../providers/workers.mjs";
import { ActionReviewer } from "./reviewer.mjs";
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

export class Controller extends EventEmitter {
  constructor(
    store,
    { probePath, bridgeUrl, browser = null, worktreeRoot = null, dataDir },
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
    // Where every new chat gets its own worktree.
    this.worktreeRoot = worktreeRoot;
    // Worktree removals in progress, by chat, so a new turn waits for them.
    this.tidying = new Map();
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
  send(
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
    mode ??= chat.mode;
    checkMode(mode, provider);
    const prior = this.store.runForAction(actionId);
    if (prior) {
      if (prior.conversation_id !== chatId)
        throw new Error("Action ID belongs to another conversation");
      return { ...prior, duplicate: true };
    }
    const files = resolveAttachments(
      this.store,
      chat.project_id,
      attachments,
      this.dataDir,
    );
    if (!text.trim() && !files.length)
      throw new Error("Enter a message or attach a file");
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
      attachments: files.map(attachmentInfo),
    });
    const abort = new AbortController();
    this.active.set(chatId, { run, abort });
    if (chat.archived_at) this.store.setArchived(chatId, false);
    this.store.updateConversation(chatId, {
      provider,
      model,
      effort: effort || null,
      permissions,
      mode,
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
  // A new mode applies from the next message, as switching it does natively.
  setMode(chatId, mode) {
    const chat = this.store.conversation(chatId);
    if (!chat) throw new Error("Conversation not found");
    checkMode(mode, chat.provider);
    return this.store.updateConversation(chatId, { mode });
  }
  // The folder a chat works in: its own worktree, created on its first turn,
  // or the project folder when that is not a Git repository on a branch or the
  // chat began before worktrees were given to every chat. A chat keeps that
  // folder for good, because native sessions are tied to it.
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
      messageMap = new Map();
    let project;
    try {
      project = await this.chatFolder(chat, home, run);
    } catch (failure) {
      const error = `This chat's worktree could not be prepared: ${failure.message}`;
      this.store.setRun(run.id, "failed", null, error);
      this.active.delete(chat.id);
      this.event(chat.id, run.id, "run", {
        status: "failed",
        error,
        provider: run.provider,
        model: run.model,
      });
      return;
    }
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
    const reviewer =
      permissions === "auto"
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
      return this.waitApproval(
        run,
        { ...request, reviewReason: result.reason },
        abort.signal,
      );
    };
    const approve = async (request) => {
      if (abort.signal.aborted) return Promise.resolve({ allow: false });
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
            tools
              .filter((tool) => chat.mode !== "ask" || tool.readOnly)
              .map(({ name, description, inputSchema }) => ({
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
    // Every action that can change a page is approved first, whichever agent
    // calls it: by the reviewer in Auto-review, otherwise by the user.
    const browser = async (name, args) => {
      const input = typeof args === "string" ? JSON.parse(args) : (args ?? {}),
        title = browserTitle(name, input);
      if (chat.mode === "ask" && (await this.browser.needsApproval(name)))
        return {
          isError: true,
          content: [{ type: "text", text: ASK_DENY }],
        };
      if (await this.browser.needsApproval(name)) {
        const request = {
            kind: "permission",
            title,
            details: { tool: name, input },
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
      emit("work", { kind: "browser-tool", item: { title, name } });
      return this.browser.call(name, input);
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
    const ctx = {
      project,
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
      handoff: [notice, handoff].filter(Boolean).join("\n\n"),
      instructions:
        agentInstructions(project, chat) +
        rulesInstructions(rules, plan, this.providers, COMMAND_SHELL) +
        skillInstructions(skills) +
        "\n\n" +
        MODE_SUGGESTION_INSTRUCTIONS +
        (startGoal ? "\n\n" + continuationText : "") +
        (chat.mode === "ask" ? "\n\n" + ASK_INSTRUCTIONS : ""),
      firstTurn: messages.filter((m) => m.role === "user").length === 1,
      tools: [
        ...hostToolsForMode(chat.mode, [
          ...historyTools,
          modeSuggestionTool,
          ...(project.worktree ? [landTool] : []),
          ...plan.tools,
        ]),
        ...browserTools,
      ],
      browser,
      signal: abort.signal,
      emit,
      billingConfirmation: this.store.setting("cursor-billing"),
      learnEfforts: (options) => this.learnCursorEfforts(options),
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
        if (chat.mode === "ask" && !askHostAllowed(name))
          return { error: ASK_DENY };
        if (name === "suggest_mode") return suggestMode(input);
        if (name === "land_changes")
          return project.worktree
            ? land()
            : { error: "This chat works in the shared project folder." };
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
    if (reviewer) reviewer.instructions = ctx.instructions;
    // Only the agent doing the work names the chat, not its reviewer. A missed
    // first-turn rename is retried until the provisional title is replaced.
    const firstMessage = messages.find((m) => m.role === "user");
    if (
      firstMessage &&
      chat.title ===
        provisionalTitle(firstMessage.content, firstMessage.attachments)
    )
      ctx.instructions += renameInstructions(run.provider);
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
      this.bridgeLand.delete(token);
      this.bridgeModes.delete(token);
      for (const [id, waiter] of this.approvalWaiters)
        if (waiter.runId === run.id) {
          waiter.resolve({ allow: false });
          this.approvalWaiters.delete(id);
        }
    }
    const active = this.active.get(chat.id);
    if (active?.restart && !active.cancelled) {
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
    this.store.setRun(run.id, status, null, error ?? null);
    this.active.delete(chat.id);
    this.event(chat.id, run.id, "run", {
      status,
      error,
      provider: run.provider,
      model: run.model,
    });
    if (project.worktree) this.tidy(chat.id);
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
