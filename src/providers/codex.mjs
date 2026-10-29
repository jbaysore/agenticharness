import { RpcProcess } from "../core/rpc.mjs";
import { contextReporter, openAIUsage, tokenCount } from "../core/context.mjs";
import { executable } from "../core/executables.mjs";
import { subscriptionEnvironment } from "../security/environment.mjs";
import { checkCodexBilling, publicCodexUsage } from "../security/billing.mjs";
import { historyTools } from "../core/history.mjs";
import { isBrowserTool } from "../core/browser.mjs";
import { codexInput } from "./attachments.mjs";
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

export async function openCodex(cwd, { signal } = {}) {
  signal?.throwIfAborted();
  const command = executable("codex");
  if (!command) throw new Error("Codex CLI is not installed");
  const rpc = new RpcProcess(
    command,
    [
      "app-server",
      "-c",
      'model_provider="openai"',
      "-c",
      'forced_login_method="chatgpt"',
      "-c",
      'service_tier="default"',
      // The desktop app prefers MXC on supported Windows devices. Standalone
      // app-server clients must opt in; otherwise they use the legacy sandbox.
      ...(process.platform === "win32"
        ? ["-c", "features.prefer_mxc=true"]
        : []),
    ],
    { cwd, env: subscriptionEnvironment() },
  );
  const stop = () => rpc.close();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    signal?.throwIfAborted();
    await rpc.call("initialize", {
      clientInfo: {
        name: "agentic_harness",
        title: "Agentic Harness",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    signal?.throwIfAborted();
    rpc.notify("initialized");
    return rpc;
  } catch (error) {
    rpc.close();
    throw error;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
export async function inspectCodex(cwd) {
  const rpc = await openCodex(cwd);
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
export async function runCodex(ctx, { open = openCodex } = {}) {
  const rpc = await open(ctx.project.path);
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
    onTurnStarted;
  const goal = ctx.mode === "goal";
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const finishCompleted = () => {
    if (finished || turnOpen || !completedTurn) return;
    // Silence between native Goal turns is not evidence that the Goal stopped.
    if (
      !ctx.signal.aborted &&
      completedTurn.status === "completed" &&
      (goal || goalStatus === "active") &&
      !goalStopped(goalStatus)
    )
      return;
    finished = true;
    resolveDone({ status: completedTurn.status, error: completedTurn.error });
  };
  const updateGoal = (status, objective) => {
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
  const cancel = async () => {
    killTimer ??= setTimeout(() => rpc.close(), 8000);
    // Stopping pauses the goal, as interrupting it does in Codex.
    if ((goal || goalStatus !== null) && threadId && !rpc.closed)
      await rpc
        .call(
          "thread/goal/set",
          { threadId, status: "paused", origin: "user" },
          5000,
        )
        .then(({ goal: paused }) => updateGoal(paused?.status ?? "paused"))
        .catch(() => {});
    if (threadId && turnId && turnOpen && !rpc.closed) {
      try {
        await rpc.call("turn/interrupt", { threadId, turnId }, 5000);
      } catch {
        rpc.close();
      }
    } else rpc.close();
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
        const result = await ctx.history(p.tool, p.arguments);
        rpc.respond(message.id, {
          contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
          success: true,
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
  let timer;
  try {
    const { account } = await rpc.call("account/read"),
      usage = await rpc.call("account/rateLimits/read");
    const blocked = checkCodexBilling(account, usage);
    if (blocked) throw new Error(blocked);
    const configResult = await rpc.call("config/read", {
      includeLayers: false,
    });
    const routeReason = checkCodexRoute(configResult.config);
    if (routeReason) throw new Error(routeReason);
    const options = {
      cwd: ctx.project.path,
      model: ctx.model,
      modelProvider: "openai",
      serviceTier: "default",
      ...codexExecutionPolicy(ctx.mode, ctx.permissions),
      developerInstructions: ctx.instructions,
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
    if (ctx.session?.id)
      response = await rpc.call("thread/resume", {
        ...options,
        threadId: ctx.session.id,
      });
    else
      response = await rpc.call("thread/start", {
        ...options,
        allowProviderModelFallback: false,
      });
    threadId = response.thread.id;
    ctx.saveSession({ id: threadId });
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
            objective: ctx.goalObjective ?? ctx.text,
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
    }
    if (goal && ctx.startGoal) {
      // A resumed Plan session must first receive Default collaboration mode.
      // Setting the goal earlier could auto-start another turn in Plan mode.
      if (ctx.signal.aborted)
        throw new Error("Cancelled before the goal started");
      const version = goalVersion;
      const { goal: set } = await rpc.call("thread/goal/set", {
        threadId,
        objective: ctx.goalObjective,
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
