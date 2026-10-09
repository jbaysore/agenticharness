// Read-only runs the host starts on a chat's behalf. A worker searches, lists
// and reads files, then answers in text; it never joins the chat's native session.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../core/queue.mjs";
import { checkCodexBilling } from "../security/billing.mjs";
import {
  checkClaudeBilling,
  claudeAuth,
  claudeOptions,
  usageOf,
} from "./claude.mjs";
import { checkCodexRoute, openCodex } from "./codex.mjs";

export const workerPrompt =
  "You are a read-only repository worker for another coding agent. Use only tools that search, list and read files. Never create, change or delete files, run builds or tests, or use the network. Answer the task directly and briefly: give file paths with line numbers and short excerpts that support the answer. If you cannot find something, say what you searched. Do not ask questions.";

// The provider cannot run included-usage work right now. The caller falls back
// to another worker and refreshes provider status.
export class WorkerUnavailable extends Error {
  unavailable = true;
}
const cancelled = () => new Error("The delegated task was cancelled");

export async function runClaudeWorker({ cwd, model, effort, task, signal }) {
  const input = new AsyncQueue();
  const q = query({
    prompt: input,
    options: {
      ...claudeOptions(cwd),
      model,
      effort: effort || undefined,
      // A short prompt of its own keeps a delegation's fixed cost small.
      systemPrompt: workerPrompt,
      tools: ["Read", "Grep", "Glob"],
      includePartialMessages: false,
      persistSession: false,
      maxTurns: 40,
      canUseTool: async () => ({
        behavior: "deny",
        message: "This worker is read-only.",
      }),
    },
  });
  const stop = () => q.interrupt().catch(() => q.close());
  signal.addEventListener("abort", stop, { once: true });
  try {
    const reason = checkClaudeBilling(await claudeAuth(), await usageOf(q));
    if (reason) throw new WorkerUnavailable(reason);
    if (signal.aborted) throw cancelled();
    input.push({
      type: "user",
      message: { role: "user", content: task },
      parent_tool_use_id: null,
      session_id: "",
    });
    for await (const event of q) {
      if (
        event.type === "rate_limit_event" &&
        (event.rate_limit_info?.isUsingOverage ||
          event.rate_limit_info?.overageInUse ||
          event.rate_limit_info?.status === "rejected")
      )
        throw new WorkerUnavailable("Claude reported a usage boundary");
      if (event.type !== "result") continue;
      if (signal.aborted) throw cancelled();
      if (event.is_error || typeof event.result !== "string")
        throw new Error(
          event.errors?.join("\n") || "The worker ended without an answer",
        );
      return {
        text: event.result,
        model: Object.keys(event.modelUsage ?? {})[0] ?? model,
        tokens: Object.values(event.modelUsage ?? {}).reduce(
          (sum, u) =>
            sum +
            u.inputTokens +
            u.outputTokens +
            u.cacheReadInputTokens +
            u.cacheCreationInputTokens,
          0,
        ),
      };
    }
    throw new Error("The worker ended without an answer");
  } finally {
    signal.removeEventListener("abort", stop);
    input.end();
    q.close();
  }
}

export async function runCodexWorker({ cwd, model, effort, task, signal }) {
  const rpc = await openCodex(cwd);
  let threadId,
    turnId,
    text = "",
    tokens = 0,
    finished = false,
    resolveDone,
    rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const stop = async () => {
    if (threadId && turnId && !rpc.closed)
      await rpc
        .call("turn/interrupt", { threadId, turnId }, 5000)
        .catch(() => {});
    rpc.close();
  };
  signal.addEventListener("abort", stop, { once: true });
  rpc.on("closed", (error) => {
    if (!finished) rejectDone(error ?? cancelled());
  });
  // Nothing a read-only worker does should need approval; anything that asks is refused.
  rpc.on("request", (message) => {
    if (rpc.closed) return;
    if (/requestApproval$/.test(message.method))
      rpc.respond(message.id, { decision: "decline" });
    else rpc.reject(message.id);
  });
  rpc.on("notification", ({ method, params: p }) => {
    if (p?.threadId && threadId && p.threadId !== threadId) return;
    if (method === "turn/started") turnId = p.turn.id;
    if (method === "item/completed" && p.item?.type === "agentMessage")
      text = p.item.text;
    if (method === "thread/tokenUsage/updated")
      tokens = p.tokenUsage?.total?.totalTokens ?? tokens;
    if (method === "turn/completed") {
      finished = true;
      resolveDone(p.turn);
    }
  });
  try {
    const { account } = await rpc.call("account/read"),
      blocked = checkCodexBilling(
        account,
        await rpc.call("account/rateLimits/read"),
      );
    if (blocked) throw new WorkerUnavailable(blocked);
    const route = checkCodexRoute(
      (await rpc.call("config/read", { includeLayers: false })).config,
    );
    if (route) throw new WorkerUnavailable(route);
    const { thread } = await rpc.call("thread/start", {
      cwd,
      model,
      modelProvider: "openai",
      serviceTier: "default",
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: workerPrompt,
      config: {
        model_provider: "openai",
        forced_login_method: "chatgpt",
        service_tier: "default",
      },
      ephemeral: true,
      allowProviderModelFallback: false,
    });
    threadId = thread.id;
    if (signal.aborted) throw cancelled();
    turnId = (
      await rpc.call("turn/start", {
        threadId,
        model,
        effort: effort || undefined,
        serviceTierForTurn: "default",
        input: [{ type: "text", text: task }],
      })
    ).turn.id;
    const turn = await done;
    if (signal.aborted) throw cancelled();
    if (turn.status !== "completed" || !text)
      throw new Error(
        turn.error?.message ?? "The worker ended without an answer",
      );
    return { text, model, tokens };
  } finally {
    finished = true;
    signal.removeEventListener("abort", stop);
    rpc.close();
  }
}
