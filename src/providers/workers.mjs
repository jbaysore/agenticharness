// Runs the host starts on a chat's behalf, on a model the user chose. A worker
// never joins the chat's native session; it gets one task and answers in text.
//   inline: answers from material given in the task, with no tools
//   search: may search, list and read files in the project
//   edit:   may read the project and change exactly one named file
//   review: returns a decision from supplied context, with execution disabled
import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../core/queue.mjs";
import { checkCodexBilling } from "../security/billing.mjs";
import { claudeAuth, claudeOptions, usageOf } from "./claude.mjs";
import {
  claudeUsageForAccount,
  CLAUDE_USAGE_POLL_INTERVAL_MS,
} from "../security/claude-usage.mjs";
import { checkCodexRoute, openCodex } from "./codex.mjs";
import {
  REVIEW_PROMPT,
  REVIEW_SCHEMA,
  reviewConfig,
} from "../core/review-policy.mjs";

export const workerPrompts = {
  review: REVIEW_PROMPT,
  inline:
    "You answer one request from another coding agent using only the material in the message. Do not use tools. Quote file content verbatim with its line numbers; never paraphrase code or invent lines. Include whole logical blocks rather than fragments. If the material does not contain the answer, say so plainly. Do not ask questions.",
  search:
    "You are a read-only repository worker for another coding agent. Use only tools that search, list and read files. Never create, change or delete files, run builds or tests, or use the network. Answer the task directly and briefly: give file paths with line numbers and short excerpts that support the answer. If you cannot find something, say what you searched. Do not ask questions.",
  edit: "You make one change to one file for another coding agent. Read the file, apply exactly the requested change with your editing tool, and change nothing else in that file or any other. Do not run commands. Reply with one sentence saying what you changed, or why you could not.",
};

// The provider cannot run included-usage work right now. The caller falls back
// to another worker and refreshes provider status.
export class WorkerUnavailable extends Error {
  unavailable = true;
}
const cancelled = () => new Error("The delegated task was cancelled");
const samePath = (cwd, a, b) =>
  typeof a === "string" &&
  resolve(cwd, a).toLowerCase() === resolve(cwd, b).toLowerCase();

// An edit worker may change the one file it was given and nothing else.
export function allowsClaudeTool(name, input, cwd, editPath) {
  return (
    !!editPath && name === "Edit" && samePath(cwd, input?.file_path, editPath)
  );
}
export function allowsCodexChange(changes, cwd, editPath) {
  return (
    !!editPath &&
    Array.isArray(changes) &&
    changes.length > 0 &&
    changes.every((change) => samePath(cwd, change.path, editPath))
  );
}

export async function runClaudeWorker(
  { cwd, model, effort, task, signal, mode = "search", editPath },
  {
    queryFn = query,
    readAuth = claudeAuth,
    baseOptions = claudeOptions,
    readUsage = usageOf,
    pollIntervalMs = CLAUDE_USAGE_POLL_INTERVAL_MS,
    usageForAccount = claudeUsageForAccount,
  } = {},
) {
  const input = new AsyncQueue();
  const options = baseOptions(cwd),
    q = queryFn({
      prompt: input,
      options: {
        ...options,
        model,
        effort: effort || undefined,
        // A short prompt of its own keeps a hand-off's fixed cost small.
        systemPrompt: workerPrompts[mode],
        tools: {
          review: [],
          inline: [],
          search: ["Read", "Grep", "Glob"],
          edit: ["Read", "Edit"],
        }[mode],
        includePartialMessages: false,
        persistSession: false,
        maxTurns: ["inline", "review"].includes(mode) ? 2 : 40,
        ...(mode === "review" && {
          outputFormat: { type: "json_schema", schema: REVIEW_SCHEMA },
          permissionMode: "dontAsk",
          mcpServers: {},
          plugins: [],
          hooks: {},
          settings: { ...options.settings, disableAllHooks: true },
        }),
        canUseTool: async (name, args) =>
          (mode === "edit" && allowsClaudeTool(name, args, cwd, editPath)) ||
          (mode === "review" && name === "StructuredOutput")
            ? { behavior: "allow", updatedInput: args }
            : {
                behavior: "deny",
                message:
                  mode === "edit"
                    ? "This worker may only edit the one file it was given."
                    : "This worker is read-only.",
              },
      },
    });
  let quotaTimer,
    checkingQuota = false,
    boundaryError;
  const stop = () =>
    mode === "review" ? q.close() : q.interrupt().catch(() => q.close());
  signal.addEventListener("abort", stop, { once: true });
  try {
    const auth = await readAuth(),
      monitor = usageForAccount(auth),
      { reason } = await monitor.read(() => readUsage(q));
    if (reason) throw new WorkerUnavailable(reason);
    if (signal.aborted) throw cancelled();
    input.push({
      type: "user",
      message: { role: "user", content: task },
      parent_tool_use_id: null,
      session_id: "",
    });
    if (mode === "review")
      quotaTimer = setInterval(async () => {
        if (checkingQuota) return;
        checkingQuota = true;
        try {
          const { reason: blocked } = await monitor.read(() => readUsage(q));
          if (blocked) throw new WorkerUnavailable(blocked);
        } catch (error) {
          boundaryError = error;
          q.close();
        } finally {
          checkingQuota = false;
        }
      }, pollIntervalMs);
    for await (const event of q) {
      if (boundaryError) throw boundaryError;
      if (
        mode === "review" &&
        event.type === "assistant" &&
        event.message?.content?.some(
          (block) =>
            block.type === "tool_use" && block.name !== "StructuredOutput",
        )
      )
        throw new Error(
          "The reviewer attempted to use a tool instead of returning a decision.",
        );
      if (
        event.type === "rate_limit_event" &&
        (event.rate_limit_info?.isUsingOverage ||
          event.rate_limit_info?.overageInUse ||
          event.rate_limit_info?.status === "rejected")
      ) {
        monitor.invalidate();
        throw new WorkerUnavailable("Claude reported a usage boundary");
      }
      if (event.type !== "result") continue;
      if (signal.aborted) throw cancelled();
      const text =
        mode === "review"
          ? JSON.stringify(event.structured_output)
          : event.result;
      if (event.is_error || typeof text !== "string")
        throw new Error(
          event.errors?.join("\n") || "The worker ended without an answer",
        );
      if (mode === "review") {
        const { reason: blocked } = await monitor.read(() => readUsage(q));
        if (blocked) throw new WorkerUnavailable(blocked);
      }
      const used = Object.values(event.modelUsage ?? {});
      return {
        text,
        model: Object.keys(event.modelUsage ?? {})[0] ?? model,
        usage: {
          input: used.reduce(
            (sum, u) =>
              sum +
              u.inputTokens +
              u.cacheReadInputTokens +
              u.cacheCreationInputTokens,
            0,
          ),
          output: used.reduce((sum, u) => sum + u.outputTokens, 0),
        },
      };
    }
    throw new Error("The worker ended without an answer");
  } catch (error) {
    throw boundaryError ?? error;
  } finally {
    clearInterval(quotaTimer);
    signal.removeEventListener("abort", stop);
    input.end();
    q.close();
  }
}

export async function runCodexWorker(
  { cwd, model, effort, task, signal, mode = "search", editPath },
  { open = openCodex } = {},
) {
  const rpc = await open(cwd);
  let threadId,
    turnId,
    text = "",
    usage = { input: 0, output: 0 },
    finished = false,
    resolveDone,
    rejectDone,
    quotaTimer,
    checkingQuota = false;
  const proposed = new Map();
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
  // The only approval a worker is ever given is an edit worker's change to
  // its one file. Commands and every other request are refused.
  rpc.on("request", (message) => {
    if (rpc.closed) return;
    if (message.method === "item/fileChange/requestApproval")
      rpc.respond(message.id, {
        decision:
          mode === "edit" &&
          allowsCodexChange(proposed.get(message.params?.itemId), cwd, editPath)
            ? "accept"
            : "decline",
      });
    else if (/requestApproval$/.test(message.method))
      rpc.respond(message.id, { decision: "decline" });
    else rpc.reject(message.id);
  });
  rpc.on("notification", ({ method, params: p }) => {
    if (p?.threadId && threadId && p.threadId !== threadId) return;
    if (
      mode === "review" &&
      method === "item/started" &&
      ![
        "agentMessage",
        "reasoning",
        "userMessage",
        "contextCompaction",
      ].includes(p.item?.type)
    ) {
      rejectDone(
        new Error(
          "The reviewer attempted to use a tool instead of returning a decision.",
        ),
      );
      stop();
      return;
    }
    if (method === "turn/started") turnId = p.turn.id;
    if (method === "item/started" && p.item?.type === "fileChange")
      proposed.set(p.item.id, p.item.changes);
    if (method === "item/completed" && p.item?.type === "agentMessage")
      text = p.item.text;
    if (method === "thread/tokenUsage/updated" && p.tokenUsage?.total)
      usage = {
        input: p.tokenUsage.total.inputTokens,
        output: p.tokenUsage.total.outputTokens,
      };
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
    const { config } = await rpc.call("config/read", { includeLayers: false }),
      route = checkCodexRoute(config);
    if (route) throw new WorkerUnavailable(route);
    const { thread } = await rpc.call("thread/start", {
      cwd,
      model,
      modelProvider: "openai",
      serviceTier: "default",
      // An edit worker asks before every change, so the host can refuse any
      // that is not to its one file. The others cannot write at all.
      approvalPolicy: mode === "edit" ? "untrusted" : "never",
      sandbox: mode === "edit" ? "workspace-write" : "read-only",
      developerInstructions: workerPrompts[mode],
      config: {
        model_provider: "openai",
        forced_login_method: "chatgpt",
        service_tier: "default",
        ...(mode === "review" && reviewConfig(config)),
      },
      ephemeral: true,
      allowProviderModelFallback: false,
      ...(mode === "review" && {
        baseInstructions: REVIEW_PROMPT,
        dynamicTools: [],
      }),
    });
    threadId = thread.id;
    if (signal.aborted) throw cancelled();
    turnId = (
      await rpc.call("turn/start", {
        threadId,
        model,
        effort: effort || undefined,
        serviceTierForTurn: "default",
        ...(mode === "review" && { outputSchema: REVIEW_SCHEMA }),
        input: [{ type: "text", text: task }],
      })
    ).turn.id;
    if (mode === "review")
      quotaTimer = setInterval(async () => {
        if (finished || checkingQuota || rpc.closed) return;
        checkingQuota = true;
        try {
          const reason = checkCodexBilling(
            account,
            await rpc.call("account/rateLimits/read"),
          );
          if (reason) throw new WorkerUnavailable(reason);
        } catch (error) {
          rejectDone(error);
          await stop();
        } finally {
          checkingQuota = false;
        }
      }, 15000);
    const turn = await done;
    if (signal.aborted) throw cancelled();
    if (turn.status !== "completed" || !text)
      throw new Error(
        turn.error?.message ?? "The worker ended without an answer",
      );
    if (mode === "review") {
      const boundary = checkCodexBilling(
        account,
        await rpc.call("account/rateLimits/read"),
      );
      if (boundary) throw new WorkerUnavailable(boundary);
    }
    return { text, model, usage };
  } finally {
    finished = true;
    clearInterval(quotaTimer);
    signal.removeEventListener("abort", stop);
    rpc.close();
  }
}

const reviewResult = (event, model) => {
  const text = JSON.stringify(event.structured_output);
  if (event.is_error || typeof text !== "string")
    throw new Error(
      event.errors?.join("\n") || "The reviewer ended without a decision",
    );
  const used = Object.values(event.modelUsage ?? {});
  return {
    text,
    model: Object.keys(event.modelUsage ?? {})[0] ?? model,
    usage: {
      input: used.reduce(
        (sum, u) =>
          sum +
          u.inputTokens +
          u.cacheReadInputTokens +
          u.cacheCreationInputTokens,
        0,
      ),
      output: used.reduce((sum, u) => sum + u.outputTokens, 0),
    },
  };
};

// One review thread for a turn. The first message carries the policies.
// Later messages carry the action. Close ends the process.
export async function openClaudeReviewer(
  { cwd, model, effort, signal },
  {
    queryFn = query,
    readAuth = claudeAuth,
    baseOptions = claudeOptions,
    readUsage = usageOf,
    usageForAccount = claudeUsageForAccount,
  } = {},
) {
  const input = new AsyncQueue(),
    options = baseOptions(cwd),
    q = queryFn({
      prompt: input,
      options: {
        ...options,
        model,
        effort: effort || undefined,
        systemPrompt: workerPrompts.review,
        tools: [],
        includePartialMessages: false,
        persistSession: false,
        maxTurns: 40,
        outputFormat: { type: "json_schema", schema: REVIEW_SCHEMA },
        permissionMode: "dontAsk",
        mcpServers: {},
        plugins: [],
        hooks: {},
        settings: { ...options.settings, disableAllHooks: true },
        canUseTool: async (name, args) =>
          name === "StructuredOutput"
            ? { behavior: "allow", updatedInput: args }
            : { behavior: "deny", message: "This reviewer has no tools." },
      },
    });
  const waiting = [];
  let ended = null,
    closed = false;
  const fail = (error) => {
    ended ??= error;
    for (const pending of waiting.splice(0)) pending.reject(ended);
  };
  const auth = await readAuth(),
    monitor = usageForAccount(auth),
    { reason } = await monitor.read(() => readUsage(q));
  if (reason) {
    input.end();
    q.close();
    throw new WorkerUnavailable(reason);
  }
  const loop = (async () => {
    try {
      for await (const event of q) {
        if (
          event.type === "assistant" &&
          event.message?.content?.some(
            (block) =>
              block.type === "tool_use" && block.name !== "StructuredOutput",
          )
        ) {
          fail(
            new Error(
              "The reviewer attempted to use a tool instead of returning a decision.",
            ),
          );
          q.close();
          return;
        }
        if (
          event.type === "rate_limit_event" &&
          (event.rate_limit_info?.isUsingOverage ||
            event.rate_limit_info?.overageInUse ||
            event.rate_limit_info?.status === "rejected")
        ) {
          monitor.invalidate();
          fail(new WorkerUnavailable("Claude reported a usage boundary"));
          q.close();
          return;
        }
        if (event.type !== "result") continue;
        const pending = waiting.shift();
        if (pending) pending.resolve(event);
      }
      fail(new Error("The reviewer session ended"));
    } catch (error) {
      fail(error);
    }
  })();
  loop.catch(() => {});
  const stop = () => {
    if (closed) return;
    closed = true;
    fail(cancelled());
    input.end();
    q.close();
  };
  signal.addEventListener("abort", stop, { once: true });
  return {
    async ask(task, askSignal) {
      if (ended) throw ended;
      if (signal.aborted || askSignal?.aborted) throw cancelled();
      const { reason: blocked } = await monitor.read(() => readUsage(q));
      if (blocked) throw new WorkerUnavailable(blocked);
      const event = await new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error("The reviewer timed out."));
        askSignal?.addEventListener("abort", onAbort, { once: true });
        waiting.push({
          resolve: (value) => {
            askSignal?.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject: (error) => {
            askSignal?.removeEventListener("abort", onAbort);
            reject(error);
          },
        });
        input.push({
          type: "user",
          message: { role: "user", content: task },
          parent_tool_use_id: null,
          session_id: "",
        });
      });
      if (signal.aborted) throw cancelled();
      const answer = reviewResult(event, model);
      const { reason: after } = await monitor.read(() => readUsage(q));
      if (after) throw new WorkerUnavailable(after);
      return answer;
    },
    async close() {
      if (closed) return;
      stop();
    },
  };
}

export async function openCodexReviewer(
  { cwd, model, effort, signal },
  { open = openCodex } = {},
) {
  const rpc = await open(cwd);
  let threadId,
    turnId,
    text = "",
    usage = { input: 0, output: 0 },
    settle = null,
    closed = false;
  const rejectSettle = (error) => {
    const current = settle;
    settle = null;
    current?.reject(error);
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    rejectSettle(cancelled());
    rpc.close();
  };
  signal.addEventListener("abort", stop, { once: true });
  rpc.on("closed", (error) => {
    if (!closed) rejectSettle(error ?? cancelled());
  });
  rpc.on("request", (message) => {
    if (rpc.closed) return;
    if (/requestApproval$/.test(message.method))
      rpc.respond(message.id, { decision: "decline" });
    else rpc.reject(message.id);
  });
  rpc.on("notification", ({ method, params: p }) => {
    if (p?.threadId && threadId && p.threadId !== threadId) return;
    if (
      method === "item/started" &&
      ![
        "agentMessage",
        "reasoning",
        "userMessage",
        "contextCompaction",
      ].includes(p.item?.type)
    ) {
      rejectSettle(
        new Error(
          "The reviewer attempted to use a tool instead of returning a decision.",
        ),
      );
      stop();
      return;
    }
    if (method === "turn/started") turnId = p.turn.id;
    if (method === "item/completed" && p.item?.type === "agentMessage")
      text = p.item.text;
    if (method === "thread/tokenUsage/updated" && p.tokenUsage?.total)
      usage = {
        input: p.tokenUsage.total.inputTokens,
        output: p.tokenUsage.total.outputTokens,
      };
    if (method === "turn/completed") {
      const current = settle;
      settle = null;
      current?.resolve(p.turn);
    }
  });
  const { account } = await rpc.call("account/read");
  const blocked = checkCodexBilling(
    account,
    await rpc.call("account/rateLimits/read"),
  );
  if (blocked) {
    rpc.close();
    throw new WorkerUnavailable(blocked);
  }
  const { config } = await rpc.call("config/read", { includeLayers: false }),
    route = checkCodexRoute(config);
  if (route) {
    rpc.close();
    throw new WorkerUnavailable(route);
  }
  const started = await rpc.call("thread/start", {
    cwd,
    model,
    modelProvider: "openai",
    serviceTier: "default",
    approvalPolicy: "never",
    sandbox: "read-only",
    developerInstructions: workerPrompts.review,
    config: {
      model_provider: "openai",
      forced_login_method: "chatgpt",
      service_tier: "default",
      ...reviewConfig(config),
    },
    ephemeral: true,
    allowProviderModelFallback: false,
    baseInstructions: REVIEW_PROMPT,
    dynamicTools: [],
  });
  threadId = started.thread.id;
  return {
    async ask(task, askSignal) {
      if (closed || signal.aborted || askSignal?.aborted) throw cancelled();
      if (settle) throw new Error("A review is already running");
      text = "";
      const onAbort = () => {
        if (threadId && turnId && !rpc.closed)
          rpc
            .call("turn/interrupt", { threadId, turnId }, 5000)
            .catch(() => {});
        rejectSettle(new Error("The reviewer timed out."));
      };
      askSignal?.addEventListener("abort", onAbort, { once: true });
      let turn;
      try {
        turn = await new Promise((resolve, reject) => {
          settle = { resolve, reject };
          rpc
            .call("turn/start", {
              threadId,
              model,
              effort: effort || undefined,
              serviceTierForTurn: "default",
              outputSchema: REVIEW_SCHEMA,
              input: [{ type: "text", text: task }],
            })
            .then((start) => {
              turnId = start.turn.id;
            })
            .catch((error) => {
              settle = null;
              reject(error);
            });
        });
      } finally {
        askSignal?.removeEventListener("abort", onAbort);
      }
      if (signal.aborted) throw cancelled();
      if (turn.status !== "completed" || !text)
        throw new Error(
          turn.error?.message ?? "The reviewer ended without a decision",
        );
      const boundary = checkCodexBilling(
        account,
        await rpc.call("account/rateLimits/read"),
      );
      if (boundary) throw new WorkerUnavailable(boundary);
      return { text, model, usage };
    },
    async close() {
      if (closed) return;
      stop();
    },
  };
}

export function openReviewer(spec, deps) {
  if (spec.provider === "claude") return openClaudeReviewer(spec, deps);
  if (spec.provider === "codex") return openCodexReviewer(spec, deps);
  throw new Error(`No reviewer session for ${spec.provider}`);
}
