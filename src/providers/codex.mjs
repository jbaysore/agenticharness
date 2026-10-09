import { RpcProcess } from "../core/rpc.mjs";
import { executable } from "../core/executables.mjs";
import { subscriptionEnvironment } from "../security/environment.mjs";
import { checkCodexBilling, publicCodexUsage } from "../security/billing.mjs";
import { historyTools } from "../core/history.mjs";

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
export async function runCodex(ctx) {
  const rpc = await openCodex(ctx.project.path);
  let turnId,
    threadId,
    finished = false,
    rejectDone,
    resolveDone,
    polling = false,
    killTimer;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const cancel = async () => {
    killTimer ??= setTimeout(() => rpc.close(), 8000);
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
      ctx.emit("nativeTurn", { id: turnId });
    }
    if (method === "item/agentMessage/delta")
      ctx.emit("text", { nativeId: p.itemId, delta: p.delta });
    if (method === "item/completed" && p.item?.type === "agentMessage")
      ctx.emit("text", {
        nativeId: p.item.id,
        text: p.item.text,
        phase: p.item.phase,
      });
    if (
      ["item/started", "item/completed"].includes(method) &&
      p.item?.type !== "agentMessage" &&
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
    if (method === "turn/plan/updated")
      ctx.emit("work", { kind: "plan", ...p });
    if (method === "thread/tokenUsage/updated")
      ctx.emit("work", { kind: "token-usage", ...p });
    if (method === "error") ctx.emit("work", { kind: "error", error: p.error });
    if (method === "turn/completed") {
      finished = true;
      resolveDone({ status: p.turn.status, error: p.turn.error });
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
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
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
    const start = await rpc.call("turn/start", {
      threadId,
      model: ctx.model,
      effort: ctx.effort || undefined,
      serviceTierForTurn: "default",
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
    ctx.signal.removeEventListener("abort", cancel);
    rpc.close();
  }
}
