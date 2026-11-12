import { RpcProcess } from "../core/rpc.mjs";
import { CodexStartupLog } from "../core/codex-startup-log.mjs";
import { waitForDiagnostics } from "../core/diagnostic-writes.mjs";
import { contextReporter, openAIUsage, tokenCount } from "../core/context.mjs";
import { executable } from "../core/executables.mjs";
import { subscriptionEnvironment } from "../security/environment.mjs";
import { checkCodexBilling, publicCodexUsage } from "../security/billing.mjs";
import { historyTools } from "../core/history.mjs";
import { isBrowserTool } from "../core/browser.mjs";
import { codexInput } from "./attachments.mjs";
import { CODEX_COMPUTER_CONTROL_OVERRIDES } from "../core/computer-control.mjs";
import { codexQuestionAnswers } from "../core/questions.mjs";
import { proposalText } from "../core/plans.mjs";
import {
  goalStopped,
  goalStatus as normalizeGoalStatus,
} from "../core/goals.mjs";

export function checkCodexRoute(config) {
  // config/read includes the official default even when the user set no override.
  const endpoint = config?.chatgpt_base_url;
  if (
    config?.model_provider !== "openai" ||
    config?.model_providers?.openai ||
    (endpoint &&
      ![
        "https://chatgpt.com/backend-api",
        "https://chatgpt.com/backend-api/",
      ].includes(endpoint))
  ) {
    return "A custom Codex provider endpoint is configured. Subscription billing cannot be verified for this route.";
  }
  return null;
}

// MXC runs each sandboxed command on the interactive desktop, so its console
// takes focus. Elevated commands use a private desktop and stay hidden.
// Unelevated isolation is weaker, and the private desktop stays on.
// Desktop control and the Chrome-backed browser stay off without a grant.
export function codexServerArgs(
  platform = process.platform,
  { computerControl = false } = {},
) {
  return [
    "app-server",
    "-c",
    'model_provider="openai"',
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'service_tier="default"',
    ...(platform === "win32"
      ? ["-c", "features.prefer_mxc=false", "-c", 'windows.sandbox="elevated"']
      : []),
    ...(computerControl
      ? []
      : CODEX_COMPUTER_CONTROL_OVERRIDES.flatMap((value) => ["-c", value])),
  ];
}

export async function openCodex(
  cwd,
  {
    signal,
    dataDir,
    chatId,
    runId,
    purpose,
    progress,
    timing,
    computerControl = false,
  } = {},
  {
    resolveExecutable = executable,
    environment = subscriptionEnvironment,
    createRpc = (...args) => new RpcProcess(...args),
    timeoutMs = 120_000,
    nativeLogPath,
    createStartupLog = (options) => new CodexStartupLog(options),
  } = {},
) {
  signal?.throwIfAborted();
  const executableDone = timing?.("executable-discovery");
  let command;
  try { command = resolveExecutable("codex"); executableDone?.(); }
  catch (error) { executableDone?.("failed"); throw error; }
  if (!command) throw new Error("Codex CLI is not installed");
  const startup = createStartupLog({
    dataDir,
    cwd,
    chatId,
    runId,
    purpose,
    nativeLogPath,
  });
  let rpc;
  let initializeDone;
  const stop = () => rpc?.close();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    progress?.({ phase: "initialize", state: "starting", startedAt: new Date(startedAt).toISOString(), deadlineAt: new Date(startedAt + timeoutMs).toISOString() });
    const environmentDone = timing?.("environment-discovery");
    let env;
    try { env = environment(); environmentDone?.(); }
    catch (error) { environmentDone?.("failed"); throw error; }
    rpc = createRpc(
      command,
      codexServerArgs(process.platform, { computerControl }),
      { cwd, env },
    );
    startup.attach(rpc, command);
    startup.record("initialize-sent", { timeoutMs });
    initializeDone = timing?.("provider-initialize");
    await rpc.call(
      "initialize",
      {
        clientInfo: {
          name: "agentic_harness",
          title: "Agentic Harness",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
      timeoutMs,
    );
    signal?.throwIfAborted();
    initializeDone?.();
    rpc.notify("initialized");
    const loggingDone = timing?.("diagnostic-persistence");
    void startup.finish("ready").then((saved) => loggingDone?.(saved ? "ready" : "unavailable"), () => loggingDone?.("failed"));
    signal?.throwIfAborted();
    progress?.({ phase: "initialize", state: "ready" });
    return rpc;
  } catch (error) {
    initializeDone?.(signal?.aborted ? "cancelled" : "failed");
    rpc?.close();
    progress?.({ phase: "initialize", state: signal?.aborted ? "cancelled" : "failed" });
    const saved = await waitForDiagnostics(startup.finish(
      signal?.aborted ? "cancelled" : "failed",
      error,
    ));
    rpc?.close();
    if (saved && !signal?.aborted)
      error.message += ` Startup diagnostics: ${startup.path}`;
    throw error;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
export async function inspectCodex(cwd, { dataDir } = {}) {
  const rpc = await openCodex(cwd, { dataDir, purpose: "connection-check" });
  try {
    const { account } = await rpc.call("account/read");
    const usage = await rpc.call("account/rateLimits/read");
    const { config } = await rpc.call("config/read", { includeLayers: false });
    let models = [],
      cursor = null;
    do {
      const page = await rpc.call("model/list", {
        includeHidden: false,
        limit: 100,
        cursor,
      });
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return {
      id: "codex",
      name: "Codex",
      route: "ChatGPT subscription",
      plan: account?.planType ?? "Unavailable",
      connected: account?.type === "chatgpt",
      blockReason: checkCodexBilling(account, usage) || checkCodexRoute(config),
      usage: publicCodexUsage(usage),
      models: models.map((m) => ({
        id: m.model,
        name: m.displayName,
        description: m.description,
        efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
        defaultEffort: m.defaultReasoningEffort,
        isDefault: m.isDefault,
        billing: "Included usage · standard speed",
        nativeSubagents: m.multiAgentVersion !== null,
      })),
      capabilities: {
        nativeResume: true,
        nativeSubagents: true,
        effort: true,
        usage: true,
        historyTools: true,
      },
    };
  } finally {
    rpc.close();
  }
}
// Reconnect only to stop a saved Goal. No prompt or active Goal is submitted.
export async function pauseCodexGoal(cwd, session, options = {}, { open = openCodex, timeoutMs = 180000 } = {}) {
  const rpc = await open(cwd, { ...options, purpose: "pause-verification" });
  const active = new Map(), ended = new Set();
  let pausing = false;
  const interrupt = (id) => {
    if (ended.has(id) || active.has(id)) return;
    const done = Promise.withResolvers();
    done.promise.catch(() => {});
    active.set(id, done);
    if (pausing) rpc.call("turn/interrupt", { threadId: session.id, turnId: id }, timeoutMs).catch(done.reject);
  };
  const notification = ({ method, params: p }) => {
    if (p?.threadId !== session.id) return;
    if (method === "turn/started") interrupt(p.turn.id);
    if (method === "turn/completed") {
      ended.add(p.turn.id);
      active.get(p.turn.id)?.resolve();
      active.delete(p.turn.id);
    }
  };
  const stopped = () => rpc.close();
  options.signal?.addEventListener("abort", stopped, { once: true });
  rpc.on("notification", notification);
  rpc.on("closed", (error) => { for (const turn of active.values()) turn.reject(error); });
  let timer;
  try {
    try {
      await rpc.call("thread/resume", { threadId: session.id, excludeTurns: true }, timeoutMs);
    } catch (error) {
      if (/no rollout found for thread id/i.test(error.message)) return "cleared";
      throw error;
    }
    pausing = true;
    const pause = rpc.call("thread/goal/set", { threadId: session.id, status: "paused", origin: "user" }, timeoutMs)
      .catch(async (error) => {
        const state = await rpc.call("thread/goal/get", { threadId: session.id }, timeoutMs);
        if (state.goal === null) return { goal: { status: "cleared" } };
        throw error;
      });
    for (const id of active.keys()) rpc.call("turn/interrupt", { threadId: session.id, turnId: id }, timeoutMs).catch(active.get(id).reject);
    const { goal } = await pause;
    if (!goalStopped(normalizeGoalStatus(goal?.status))) throw new Error("Codex did not confirm the Goal pause");
    const { data } = await rpc.call("thread/turns/list", { threadId: session.id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }, timeoutMs);
    for (const turn of data ?? []) if (turn.status === "inProgress") interrupt(turn.id);
    await Promise.race([
      (async () => { while (active.size) await Promise.all([...active.values()].map((turn) => turn.promise)); })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Codex has not confirmed the active turn ended")), timeoutMs); }),
    ]);
    return goal.status;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stopped);
    rpc.removeListener("notification", notification);
    rpc.close();
  }
}
// Harness's permission modes in Codex's terms: its auto-review subagent decides
// sandbox escapes in auto, and anything it passes on is reviewed by Harness.
// Override drops both the prompts and the sandbox.
// Ask mode ignores the chat's permission mode, including Override: the
// read-only sandbox cannot write, and a request to leave it is declined.
export function codexExecutionPolicy(mode, permissions = "auto") {
  if (mode === "ask")
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
    };
  return permissionModes[permissions] ?? permissionModes.auto;
}
// Plan is Codex's collaboration mode. Ask stays on the default collaboration
// mode and is read-only through the sandbox above.
export function codexCollaboration(mode) {
  return mode === "plan" ? "plan" : "default";
}
export function codexAskBlocksApproval(mode, method) {
  return (
    mode === "ask" &&
    (method === "item/fileChange/requestApproval" ||
      method === "item/commandExecution/requestApproval")
  );
}
const permissionModes = {
  manual: {
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  },
  auto: {
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
  },
  override: {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
  },
};
export async function runCodex(ctx, { open = openCodex, setupTimeoutMs = 180_000 } = {}) {
  const progress = (value) => ctx.emit("work", { kind: "provider-startup", ...value });
  const rpc = await open(ctx.project.path, {
    signal: ctx.signal,
    dataDir: ctx.dataDir,
    chatId: ctx.chat?.id,
    runId: ctx.runId,
    purpose: "chat",
    progress,
    timing: ctx.timing,
    computerControl: Boolean(ctx.computerControl),
  });
  ctx.attachClose?.(() => rpc.close());
  const setupLog = rpc.child ? new CodexStartupLog({ dataDir: ctx.dataDir, cwd: ctx.project.path, chatId: ctx.chat?.id, runId: ctx.runId, purpose: "session-setup" }) : null;
  setupLog?.attach(rpc, "codex");
  const setupCall = async (method, params) => {
    ctx.signal.throwIfAborted();
    const startedAt = Date.now();
    progress({ phase: method, state: "starting", startedAt: new Date(startedAt).toISOString(), deadlineAt: new Date(startedAt + setupTimeoutMs).toISOString() });
    setupLog?.record(method + "-sent", { timeoutMs: setupTimeoutMs });
    const setupDone = ctx.timing?.("thread-setup");
    try {
      const response = await rpc.call(method, params, setupTimeoutMs);
      setupDone?.();
      progress({ phase: method, state: "ready" });
      return response;
    } catch (error) {
      setupDone?.(ctx.signal.aborted ? "cancelled" : "failed");
      throw error;
    }
  };
  const context = contextReporter(ctx, "codex");
  let compacting = false;
  let turnId,
    threadId,
    finished = false,
    steerOpen = false,
    rejectDone,
    resolveDone,
    polling = false,
    killTimer,
    // A steer waits here until the open turn can be interrupted.
    steerHold = null;
  const steers = [];
  // A goal runs turn after turn until Codex marks it met, blocked or paused.
  let goalStatus =
      ctx.mode === "goal" ? "unknown" : (ctx.session?.goal?.status ?? null),
    goalVersion = 0,
    reportedGoalStatus,
    turnOpen = false,
    completedTurn = null,
    onTurnStarted,
    pauseAcknowledged = false,
    // A native pause request is in flight; parking waits for its answer.
    pauseInFlight = false,
    cancelling;
  const goal = ctx.mode === "goal";
  const hasRunningGoal = goal || (goalStatus !== null && !goalStopped(goalStatus));
  const userGoalPause = () => ctx.signal.reason?.kind === "user-pause" && hasRunningGoal;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const finishPause = () => {
    if (!userGoalPause() || finished || turnOpen || !pauseAcknowledged) return false;
    finished = true;
    ctx.pauseConfirmed?.(goalStatus);
    resolveDone({ status: "cancelled" });
    return true;
  };
  const finishCompleted = () => {
    if (finishPause()) return;
    if (userGoalPause()) return;
    if (finished || turnOpen || !completedTurn) return;
    // Silence between native Goal turns is not evidence that the Goal stopped.
    if (
      !ctx.signal.aborted &&
      completedTurn.status === "completed" &&
      (goal || goalStatus === "active") &&
      !goalStopped(goalStatus)
    )
      return;
    const parking = ctx.signal.reason?.kind;
    // The turn can end before Codex answers the pause request. Wait for that
    // answer, which calls back here, so the park is still confirmed.
    if (
      (parking === "watch-yield" || parking === "owner-pause") &&
      goal &&
      !goalStopped(goalStatus) &&
      pauseInFlight &&
      !rpc.closed
    )
      return;
    finished = true;
    if (
      (parking === "watch-yield" || parking === "owner-pause") &&
      ((!goal && goalStatus === null) || goalStopped(goalStatus))
    ) {
      if (parking === "watch-yield") ctx.watchParked?.();
      else ctx.ownerParked?.();
    }
    resolveDone({ status: completedTurn.status, error: completedTurn.error });
  };
  const updateGoal = (status, objective) => {
    // Keep Harness's complete objective when the native field is a reference.
    if (objective === nativeGoalObjective && fullGoalObjective)
      objective = fullGoalObjective;
    const next = normalizeGoalStatus(status);
    if (next !== reportedGoalStatus || objective)
      ctx.goalState?.(next, objective);
    reportedGoalStatus = next;
    goalStatus = next;
    finishCompleted();
  };
  const nextTurn = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      onTurnStarted = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
  // One app-server turn takes one input. Steering interrupts that turn and
  // starts the next on the same thread, so the session stays open. Stop uses
  // the abort signal; this path does not.
  const startSteeredTurn = async (item) => {
    turnOpen = true;
    completedTurn = null;
    const mode = item.mode ?? ctx.mode;
    const start = await rpc.call("turn/start", {
      threadId,
      model: ctx.model,
      effort: ctx.effort || undefined,
      serviceTierForTurn: "default",
      collaborationMode: {
        mode: codexCollaboration(mode),
        settings: {
          model: ctx.model,
          reasoning_effort: ctx.effort || null,
          developer_instructions: null,
        },
      },
      input: [{ type: "text", text: item.text }],
    });
    turnId = start.turn.id;
  };
  const pumpSteer = () => {
    if (
      steerHold ||
      !turnOpen ||
      !turnId ||
      !threadId ||
      ctx.signal.aborted ||
      finished
    )
      return;
    steerHold = steers.shift() ?? null;
    if (!steerHold) return;
    rpc.call("turn/interrupt", { threadId, turnId }).catch((error) => {
      if (!finished) rejectDone(error);
    });
  };
  const cancel = () => {
    if (cancelling) return cancelling;
    if (!userGoalPause()) killTimer ??= setTimeout(() => rpc.close(), 8000);
    cancelling = (async () => {
      if (!threadId || rpc.closed) {
        if (!ctx.session?.id) ctx.pauseConfirmed?.();
        rpc.close();
        return;
      }
      const requests = [];
      if (hasRunningGoal) pauseInFlight = true;
      if (hasRunningGoal) requests.push(rpc.call("thread/goal/set",
        { threadId, status: "paused", origin: "user" }, userGoalPause() ? 120000 : 5000)
        .catch(async (error) => {
          if (!userGoalPause()) throw error;
          const state = await rpc.call("thread/goal/get", { threadId }, 120000);
          if (state.goal === null) return { goal: { status: "cleared" } };
          throw error;
        })
        .then(({ goal: paused }) => {
          pauseAcknowledged = goalStopped(normalizeGoalStatus(paused?.status));
          updateGoal(paused?.status ?? "unknown");
        }).catch((error) => { if (userGoalPause()) throw error; })
        .finally(() => {
          pauseInFlight = false;
          finishCompleted();
        }));
      if (turnId && turnOpen) requests.push(rpc.call("turn/interrupt", { threadId, turnId }, userGoalPause() ? 120000 : 5000));
      await Promise.all(requests);
      if (!finishPause() && !turnOpen && !userGoalPause()) rpc.close();
    })().catch((error) => {
      if (userGoalPause() && !rpc.closed) {
        // A control timeout is not proof the Goal stopped. Keep listening.
        ctx.emit("work", { kind: "cancellation", state: "requested", text: "Still waiting for the provider to confirm the Goal pause." });
        cancelling = null;
      } else rpc.close();
    });
    return cancelling;
  };
  ctx.signal.addEventListener("abort", cancel, { once: true });
  rpc.on("closed", (error) => {
    if (!finished) rejectDone(error ?? new Error("Codex connection closed"));
  });
  rpc.on("request", async (message) => {
    try {
      const p = message.params;
      if (message.method === "item/tool/call" && isBrowserTool(p.tool)) {
        const result = await ctx.browser(p.tool, p.arguments);
        rpc.respond(message.id, {
          contentItems: (result.content ?? []).map((c) =>
            c.type === "image"
              ? {
                  type: "inputImage",
                  imageUrl: `data:${c.mimeType};base64,${c.data}`,
                }
              : { type: "inputText", text: c.text ?? JSON.stringify(c) },
          ),
          success: !result.isError,
        });
        return;
      }
      if (message.method === "item/tool/call") {
        // Codex shows a rejected request only as "dynamic tool request
        // failed", so return the host's reason as a failed result instead.
        let result,
          success = true;
        try {
          result = await ctx.history(p.tool, p.arguments);
        } catch (error) {
          result = { error: error.message };
          success = false;
        }
        if (rpc.closed) return;
        rpc.respond(message.id, {
          contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
          success,
        });
        return;
      }
      if (codexAskBlocksApproval(ctx.mode, message.method)) {
        if (!rpc.closed) rpc.respond(message.id, { decision: "decline" });
        return;
      }
      if (
        message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval"
      ) {
        const answer = await ctx.approve({
          kind: "permission",
          title: p.command ?? p.reason ?? "Approve agent action",
          details: p,
          method: message.method,
        });
        if (!rpc.closed)
          rpc.respond(message.id, {
            decision: answer.allow ? "accept" : "decline",
          });
        return;
      }
      if (message.method === "item/tool/requestUserInput") {
        // Codex marks questions outside Plan as non-blocking, and its terminal
        // UI then submits an empty answer after about two minutes. Harness is
        // the client for this request, so it waits for an explicit answer.
        // Goal applies its own 60 second timer before that answer is returned.
        const answer = await ctx.approve({
          kind: "question",
          title: "The agent needs your input",
          questions: p.questions,
          details: p,
        });
        if (!rpc.closed)
          rpc.respond(message.id, {
            answers: codexQuestionAnswers(p.questions ?? [], answer),
          });
        return;
      }
      rpc.reject(message.id);
    } catch (error) {
      if (!rpc.closed) rpc.reject(message.id, error.message);
    }
  });
  rpc.on("notification", ({ method, params: p }) => {
    if (finished) return;
    if (p?.threadId && threadId && p.threadId !== threadId) {
      if (
        ["item/started", "item/completed", "thread/status/changed"].includes(
          method,
        )
      )
        ctx.emit("work", {
          kind: "native-subagent",
          provider: "codex",
          threadId: p.threadId,
          method,
          item: p.item,
          status: p.status,
        });
      return;
    }
    if (method === "turn/started") {
      turnId = p.turn.id;
      turnOpen = true;
      completedTurn = null;
      onTurnStarted?.();
      ctx.emit("nativeTurn", { id: turnId });
      pumpSteer();
      if (ctx.signal.aborted) { cancelling = null; void cancel(); }
    }
    if (method === "item/agentMessage/delta")
      ctx.emit("text", { nativeId: p.itemId, delta: p.delta });
    // A plan-mode turn ends with its proposed plan, shown as a reply.
    if (
      method === "item/completed" &&
      ["agentMessage", "plan"].includes(p.item?.type)
    ) {
      if (
        ctx.mode === "plan" &&
        (p.item.type === "plan" || p.item.phase === "final_answer")
      ) {
        const text = proposalText(p.item.text);
        if (text) ctx.emit("proposed-plan", { text });
      }
      ctx.emit("text", {
        nativeId: p.item.id,
        text: p.item.text,
        phase: p.item.phase,
      });
    }
    if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
      goalVersion++;
      if (ctx.signal.aborted && (method === "thread/goal/cleared" || goalStopped(normalizeGoalStatus(p.goal?.status))))
        pauseAcknowledged = true;
      updateGoal(
        method === "thread/goal/cleared" ? "cleared" : p.goal?.status,
        p.goal?.objective,
      );
      ctx.emit("work", {
        kind: "goal",
        provider: "codex",
        item: p.goal
          ? {
              title: `Goal ${{ active: "active", paused: "paused", blocked: "blocked", usageLimited: "stopped at a usage limit", budgetLimited: "stopped at its budget", complete: "met" }[p.goal.status] ?? p.goal.status}: ${p.goal.objective}`,
            }
          : { title: "Goal cleared" },
      });
    }
    if (
      ["item/started", "item/completed"].includes(method) &&
      p.item?.type !== "agentMessage" &&
      p.item?.type !== "plan" &&
      p.item?.type !== "userMessage" &&
      p.item?.type !== "reasoning"
    )
      ctx.emit("work", {
        kind:
          p.item?.type === "collabAgentToolCall" ? "native-subagent" : "tool",
        provider: "codex",
        method,
        item: p.item,
      });
    if (method === "item/commandExecution/outputDelta")
      ctx.emit("work", {
        kind: "command-output",
        itemId: p.itemId,
        delta: p.delta,
      });
    if (method === "item/autoApprovalReview/completed")
      ctx.emit("work", {
        kind: "auto-review",
        provider: "codex",
        item: {
          title: `Auto-review ${p.review?.status ?? "finished"}: ${p.action?.command ?? p.action?.program ?? p.action?.type ?? "agent action"}`,
          description: [
            p.review?.riskLevel && `${p.review.riskLevel} risk`,
            p.review?.rationale,
          ]
            .filter(Boolean)
            .join(" · "),
        },
      });
    if (method === "turn/plan/updated")
      ctx.emit("work", { kind: "plan", ...p });
    if (method === "item/started" && p.item?.type === "contextCompaction") {
      compacting = true;
      context.compact();
    }
    if (method === "item/completed" && p.item?.type === "contextCompaction") compacting = false;
    if (method === "thread/tokenUsage/updated" && threadId) {
      ctx.emit("work", { kind: "token-usage", ...p });
      const usage = p.tokenUsage;
      if (!compacting && tokenCount(usage?.last?.totalTokens) !== null)
        context.update({
          usedTokens: usage.last.totalTokens,
          windowTokens: usage.modelContextWindow,
          basis: "last-request", accuracy: "provider-estimated",
          source: "Codex latest request usage",
          cache: openAIUsage(usage.last),
        });
      if (usage?.total) context.totals({ [ctx.model]: openAIUsage(usage.total) }, "root-thread");
    }
    if (method === "error") ctx.emit("work", { kind: "error", error: p.error });
    if (method === "turn/completed") {
      if (p.turn.id && turnId && p.turn.id !== turnId) return;
      turnOpen = false;
      completedTurn = p.turn;
      if (!ctx.signal.aborted && !finished && (steerHold || steers.length)) {
        const item = steerHold ?? steers.shift();
        steerHold = null;
        startSteeredTurn(item).catch((error) => {
          if (!finished) rejectDone(error);
        });
        return;
      }
      finishCompleted();
    }
  });
  const fullGoalObjective = ctx.goalObjective ?? ctx.session?.goal?.objective ?? ctx.text;
  // Codex limits its native objective to 4,000 characters. Deliver the full
  // requirements before goal/set can auto-start a turn, and use a reference.
  const nativeGoalObjective = fullGoalObjective?.length > 4000
    ? "Complete the full Harness goal supplied in the developer instructions. All requirements and completion criteria there remain binding; keep working until all are met."
    : fullGoalObjective;
  let timer;
  try {
    const preflightDone = ctx.timing?.("provider-preflight");
    let account, usage, configResult;
    try {
      [{ account }, usage, configResult] = await Promise.all([
        rpc.call("account/read"),
        rpc.call("account/rateLimits/read"),
        rpc.call("config/read", { includeLayers: false }),
      ]);
      preflightDone?.();
    } catch (error) {
      preflightDone?.("failed");
      throw error;
    }
    const blocked = checkCodexBilling(account, usage);
    if (blocked) throw new Error(blocked);
    const routeReason = checkCodexRoute(configResult.config);
    if (routeReason) throw new Error(routeReason);
    const options = {
      cwd: ctx.project.path,
      model: ctx.model,
      modelProvider: "openai",
      serviceTier: "default",
      ...codexExecutionPolicy(ctx.mode, ctx.permissions),
      developerInstructions: goal
        ? [ctx.instructions, ctx.addendum, ctx.handoff,
            fullGoalObjective?.length > 4000 ? `Full Harness goal:\n${fullGoalObjective}` : ""]
            .filter(Boolean).join("\n\n")
        : ctx.instructions,
      config: {
        model_provider: "openai",
        forced_login_method: "chatgpt",
        service_tier: "default",
      },
      dynamicTools: (ctx.tools ?? historyTools).map((t) => ({
        type: "function",
        ...t,
      })),
    };
    let response;
    if (ctx.session?.id) {
      try {
        response = await setupCall("thread/resume", {
          ...options,
          threadId: ctx.session.id,
          excludeTurns: true,
        });
      } catch (error) {
        // thread/start can return an id before any rollout is persisted.
        if (!/no rollout found for thread id/i.test(error.message)) throw error;
        ctx.ensureHandoff?.();
        options.developerInstructions = [options.developerInstructions, ctx.handoff]
          .filter(Boolean).join("\n\n");
        ctx.invalidatePromptDelivery?.();
        ctx.session = undefined;
        ctx.continuing = false;
        ctx.resumeGoal = false;
        ctx.goalObjective = fullGoalObjective;
      }
    }
    if (!response)
      response = await setupCall("thread/start", {
        ...options,
        allowProviderModelFallback: false,
      });
    threadId = response.thread.id;
    if (ctx.signal.aborted) { cancelling = null; await cancel(); return await done; }
    ctx.saveSession({ id: threadId });
    if (setupLog) {
      const loggingDone = ctx.timing?.("diagnostic-persistence");
      void setupLog.finish("ready").then((saved) => loggingDone?.(saved ? "ready" : "unavailable"), () => loggingDone?.("failed"));
    }
    context.start(threadId);
    if (ctx.session?.id && !ctx.startGoal && (goal || ctx.session.goal)) {
      const version = goalVersion;
      try {
        const { goal: saved } = await rpc.call("thread/goal/get", { threadId });
        if (version === goalVersion)
          updateGoal(saved ? saved.status : "cleared", saved?.objective);
      } catch {
        // Reading a saved Goal can resolve a legacy hold; a failed read cannot.
        if (version === goalVersion) updateGoal("unknown");
      }
    }
    steerOpen = true;
    ctx.attachSteer?.((item) => {
      if (!steerOpen || finished || ctx.signal.aborted)
        throw new Error("Codex's turn has ended");
      steers.push(item);
      pumpSteer();
    });
    if (ctx.signal.aborted)
      throw new Error("Cancelled before the turn started");
    // Setting a goal can start its first turn; start one only if it did not.
    let started = false;
    if (goal && !ctx.startGoal) {
      const soon = nextTurn(2000);
      const version = goalVersion;
      const { goal: set } = await rpc.call("thread/goal/set", {
        threadId,
        // A permission continuation or a resume reactivates this same paused
        // native Goal without replacing its objective or resetting its budget.
        // A resumed Goal that Codex no longer has is set again from Harness's copy.
        ...(!ctx.continuing &&
          (!ctx.resumeGoal ||
            (goalStatus === "cleared" && ctx.goalObjective)) && {
            objective: nativeGoalObjective,
          }),
        status: "active",
        origin: "user",
      });
      if (version === goalVersion) updateGoal(set.status, set.objective);
      started = await soon;
    }
    if (!started) {
      turnOpen = true;
      completedTurn = null;
      const start = await rpc.call("turn/start", {
        threadId,
        model: ctx.model,
        effort: ctx.effort || undefined,
        serviceTierForTurn: "default",
        collaborationMode: {
          mode: codexCollaboration(ctx.mode),
          settings: {
            model: ctx.model,
            reasoning_effort: ctx.effort || null,
            developer_instructions: null,
          },
        },
        input: codexInput(ctx),
      });
      turnId = start.turn.id;
      ctx.promptAccepted?.();
      if (ctx.signal.aborted) { cancelling = null; await cancel(); return await done; }
    }
    if (goal && ctx.startGoal) {
      // A resumed Plan session must first receive Default collaboration mode.
      // Setting the goal earlier could auto-start another turn in Plan mode.
      if (ctx.signal.aborted)
        throw new Error("Cancelled before the goal started");
      const version = goalVersion;
      const { goal: set } = await rpc.call("thread/goal/set", {
        threadId,
        objective: nativeGoalObjective,
        status: "active",
        origin: "user",
      });
      if (version === goalVersion) updateGoal(set.status, set.objective);
    }
    timer = setInterval(async () => {
      if (polling || finished || rpc.closed) return;
      polling = true;
      try {
        const latest = await rpc.call("account/rateLimits/read");
        ctx.emit("usage", publicCodexUsage(latest));
        const reason = checkCodexBilling(account, latest);
        if (reason) {
          ctx.emit("work", { kind: "billing-stop", reason });
          await cancel();
        }
      } catch {
        // A read cut off because the turn is already ending (a park, Stop or
        // close) is not lost quota; reporting it would undo the park.
        if (finished || rpc.closed || ctx.signal.aborted) return;
        ctx.emit("work", {
          kind: "billing-stop",
          reason: "Lost authoritative quota information",
        });
        await cancel();
      } finally {
        polling = false;
      }
    }, 20000);
    return await done;
  } catch (error) {
    if (setupLog) {
      const saved = await waitForDiagnostics(setupLog.finish(ctx.signal.aborted ? "cancelled" : "failed", error));
      if (saved && !ctx.signal.aborted) error.message += ` Startup diagnostics: ${setupLog.path}`;
    }
    progress({ phase: "session", state: ctx.signal.aborted ? "cancelled" : "failed" });
    throw error;
  } finally {
    context.finish();
    finished = true;
    steerOpen = false;
    clearInterval(timer);
    clearTimeout(killTimer);
    ctx.signal.removeEventListener("abort", cancel);
    rpc.close();
  }
}
