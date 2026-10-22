import { RpcProcess } from "../core/rpc.mjs";
import { executable } from "../core/executables.mjs";
import { subscriptionEnvironment } from "../security/environment.mjs";
import { checkCodexBilling, publicCodexUsage } from "../security/billing.mjs";
import { historyTools } from "../core/history.mjs";
import { isBrowserTool } from "../core/browser.mjs";

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

export async function openCodex(cwd) {
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
  try {
    await rpc.call("initialize", {
      clientInfo: {
        name: "agentic_harness",
        title: "Agentic Harness",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized");
    return rpc;
  } catch (error) {
    rpc.close();
    throw error;
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
// sandbox escapes in auto, and override drops both the prompts and the sandbox.
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
export async function runCodex(ctx) {
  const rpc = await openCodex(ctx.project.path);
  let turnId,
    threadId,
    finished = false,
    rejectDone,
    resolveDone,
    polling = false,
    killTimer,
    // A goal runs turn after turn until Codex marks it met, blocked or paused.
    goalStatus = null,
    goalWait,
    onTurnStarted;
  const goal = ctx.mode === "goal";
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const nextTurn = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      onTurnStarted = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
  const cancel = async () => {
    killTimer ??= setTimeout(() => rpc.close(), 8000);
    // Stopping pauses the goal, as interrupting it does in Codex.
    if (goal && threadId && !rpc.closed)
      await rpc
        .call(
          "thread/goal/set",
          { threadId, status: "paused", origin: "user" },
          5000,
        )
        .catch(() => {});
    if (threadId && turnId && !rpc.closed) {
      try {
        await rpc.call("turn/interrupt", { threadId, turnId }, 5000);
      } catch {
        rpc.close();
      }
    } else rpc.close();
  };
  ctx.signal.addEventListener("abort", cancel, { once: true });
  rpc.on("closed", (error) => {
    if (!finished) rejectDone(error);
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
        const answer = await ctx.approve({
          kind: "question",
          title: "The agent needs your input",
          questions: p.questions,
          details: p,
        });
        if (!rpc.closed)
          rpc.respond(message.id, {
            answers: Object.fromEntries(
              (p.questions ?? []).map((q) => [
                q.id,
                { answers: [answer.answers?.[q.id] ?? "Cancelled by user"] },
              ]),
            ),
          });
        return;
      }
      rpc.reject(message.id);
    } catch (error) {
      if (!rpc.closed) rpc.reject(message.id, error.message);
    }
  });
  rpc.on("notification", ({ method, params: p }) => {
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
      clearTimeout(goalWait);
      onTurnStarted?.();
      ctx.emit("nativeTurn", { id: turnId });
    }
    if (method === "item/agentMessage/delta")
      ctx.emit("text", { nativeId: p.itemId, delta: p.delta });
    // A plan-mode turn ends with its proposed plan, shown as a reply.
    if (
      method === "item/completed" &&
      ["agentMessage", "plan"].includes(p.item?.type)
    )
      ctx.emit("text", {
        nativeId: p.item.id,
        text: p.item.text,
        phase: p.item.phase,
      });
    if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
      goalStatus = p.goal?.status ?? null;
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
    if (method === "thread/tokenUsage/updated")
      ctx.emit("work", { kind: "token-usage", ...p });
    if (method === "error") ctx.emit("work", { kind: "error", error: p.error });
    if (method === "turn/completed") {
      const finish = () => {
        finished = true;
        resolveDone({ status: p.turn.status, error: p.turn.error });
      };
      // Codex starts the goal's next turn itself; the run lasts until it stops.
      if (goal && goalStatus === "active" && p.turn.status === "completed")
        goalWait = setTimeout(finish, 5000);
      else finish();
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
      ...permissionModes[ctx.permissions ?? "auto"],
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
    if (ctx.signal.aborted)
      throw new Error("Cancelled before the turn started");
    // Setting a goal can start its first turn; start one only if it did not.
    let started = false;
    if (goal && !ctx.continuing) {
      const soon = nextTurn(2000);
      const { goal: set } = await rpc.call("thread/goal/set", {
        threadId,
        objective: ctx.text,
        status: "active",
        origin: "user",
      });
      goalStatus = set.status;
      started = await soon;
    }
    if (!started) {
      const start = await rpc.call("turn/start", {
        threadId,
        model: ctx.model,
        effort: ctx.effort || undefined,
        serviceTierForTurn: "default",
        collaborationMode: {
          mode: ctx.mode === "plan" ? "plan" : "default",
          settings: {
            model: ctx.model,
            reasoning_effort: ctx.effort || null,
            developer_instructions: null,
          },
        },
        input: [
          {
            type: "text",
            text: [ctx.handoff, ctx.text]
              .filter(Boolean)
              .join("\n\nCurrent request:\n"),
          },
        ],
      });
      turnId = start.turn.id;
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
    finished = true;
    clearInterval(timer);
    clearTimeout(killTimer);
    clearTimeout(goalWait);
    ctx.signal.removeEventListener("abort", cancel);
    rpc.close();
  }
}
