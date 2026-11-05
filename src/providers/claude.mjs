import {
  query,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { contextReporter, contextSampler, claudeUsage } from "../core/context.mjs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { AsyncQueue } from "../core/queue.mjs";
import { historyTools } from "../core/history.mjs";
import { memoryTools } from "../core/memory-web.mjs";
import { claudeQuestionAnswers } from "../core/questions.mjs";
import { planRevisionRequest, proposalText } from "../core/plans.mjs";
import { goalStopped } from "../core/goals.mjs";
import { watchTools } from "../core/watch-tools.mjs";
import { ownerPauseTool } from "../core/owner-pause.mjs";
import { executable } from "../core/executables.mjs";
import { subscriptionEnvironment } from "../security/environment.mjs";
import { claudeContent } from "./attachments.mjs";
import {
  checkClaudeBilling,
  claudeUsageForAccount,
  CLAUDE_USAGE_POLL_INTERVAL_MS,
} from "../security/claude-usage.mjs";
import {
  ASK_DENY,
  CLAUDE_ASK_TOOLS,
  claudeAskAllowed,
  CHAT_MODES,
} from "../core/modes.mjs";
export { checkClaudeBilling };
const exec = promisify(execFile);

// Claude's question timer and its five-minute remote-dialog deadline do not
// see someone reading or typing in Harness. Only Goal's own 60 second timer
// may close a question. CLAUDE_CODE_* variables are already left out of the
// provider environment, so they cannot override this.
export const CLAUDE_SESSION_SETTINGS = {
  forceLoginMethod: "claudeai",
  fastMode: false,
  askUserQuestionTimeout: "never",
  dialogExpiry: "never",
};

// Memory Web tools are loaded up front: agents are asked to search and save
// as part of ordinary work, which a tool-discovery round trip discourages.
function memoryClaudeTools(ctx) {
  const describe = (name) => memoryTools.find((t) => t.name === name).description;
  const respond = (name) => async (args) => ({
    content: [
      { type: "text", text: JSON.stringify(await ctx.history(name, args)) },
    ],
  });
  const strings = z.array(z.string()).optional();
  return [
    tool(
      "memory_search",
      describe("memory_search"),
      {
        query: z.string().max(500),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(10).optional(),
        includeInactive: z.boolean().optional(),
      },
      respond("memory_search"),
      { alwaysLoad: true },
    ),
    tool(
      "memory_read",
      describe("memory_read"),
      { slug: z.string().min(1) },
      respond("memory_read"),
      { alwaysLoad: true },
    ),
    tool(
      "memory_write",
      describe("memory_write"),
      {
        title: z.string().max(120),
        description: z.string().max(300),
        body: z.string().max(20000).optional(),
        type: z.enum(["fact", "decision", "lesson", "procedure", "preference", "project", "topic", "episode"]).optional(),
        projects: strings,
        tags: strings,
        aliases: strings,
        sources: z.array(z.string()),
        trust: z.enum(["user", "verified", "inferred", "external"]).optional(),
        expires: z.string().optional(),
        path: z.string().optional(),
        slug: z.string().optional(),
        supersedes: z.string().optional(),
      },
      respond("memory_write"),
      { alwaysLoad: true },
    ),
  ];
}

export function claudeOptions(cwd) {
  const path = executable("claude");
  if (!path) throw new Error("Claude Code is not installed");
  return {
    cwd,
    pathToClaudeCodeExecutable: path,
    env: subscriptionEnvironment(),
    settingSources: [],
    strictMcpConfig: true,
    settings: CLAUDE_SESSION_SETTINGS,
    permissionMode: "default",
    includePartialMessages: true,
    extraArgs: { "forward-subagent-text": null },
  };
}
// Harness's permission modes in Claude Code's terms. Auto mode's classifier
// still calls canUseTool when it cannot decide; Harness reviews that call.
const permissionModes = {
  manual: { permissionMode: "default" },
  auto: { permissionMode: "auto" },
  override: {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
};
export const CLAUDE_SIGN_IN = {
  provider: "claude",
  label: "Sign in",
  command: "claude auth login --claudeai",
};
const LOGIN_ARGS = ["auth", "login", "--claudeai"];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const loginGate = { current: null };

// Claude Code 2.1 exits 1 when signed out and still prints this JSON. A
// missing or non-boolean loggedIn is not a status. Never return the raw text.
function authFromOutput(stdout) {
  const text = Buffer.isBuffer(stdout)
    ? stdout.toString("utf8")
    : typeof stdout === "string"
      ? stdout
      : null;
  if (text == null) return null;
  try {
    const auth = JSON.parse(text);
    if (!auth || typeof auth.loggedIn !== "boolean") return null;
    return auth;
  } catch {
    return null;
  }
}
function loginUrl(output) {
  const match = String(output).match(/https:\/\/[^\s<>"']+/);
  return match ? match[0].replace(/[),.;]+$/, "") : null;
}
export async function claudeAuth({ run = exec, path = executable("claude") } = {}) {
  if (!path) throw new Error("Claude Code is not installed");
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try {
      result = await run(path, ["auth", "status"], {
        env: subscriptionEnvironment(),
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 128 * 1024,
      });
    } catch (cause) {
      // A non-zero exit can still carry a complete status. Real command
      // failures have no status and are not retried. Do not expose stdout.
      const auth = authFromOutput(cause?.stdout);
      if (auth) return auth;
      throw cause;
    }
    const auth = authFromOutput(result.stdout);
    if (auth) return auth;
    // This command is read-only: retry its response, never the model turn
    // or tools that may already have performed work. Do not expose stdout.
    if (attempt === 1)
      throw new Error(
        "Claude's sign-in check returned an empty or invalid response twice. Try continuing the chat; if it repeats, check Claude Code in Connections & usage.",
      );
  }
}
// Starts the subscription login only. The caller decides when the user asked.
// One login at a time. Output stays off the provider; a URL is returned alone.
export function startClaudeLogin({
  path = executable("claude"),
  spawnFn = spawn,
  env = subscriptionEnvironment(),
  timeoutMs = LOGIN_TIMEOUT_MS,
  gate = loginGate,
} = {}) {
  if (gate.current) throw new Error("Claude sign-in is already in progress.");
  if (!path) throw new Error("Claude Code is not installed");
  const child = spawnFn(path, LOGIN_ARGS, {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child) throw new Error("Claude sign-in could not start.");
  gate.current = child;
  let resolve;
  let reject;
  let resolveDone;
  const result = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const done = new Promise((finish) => {
    resolveDone = finish;
  });
  let settled = false;
  let output = "";
  const finish = (payload) => {
    if (settled) return;
    settled = true;
    resolve(payload);
  };
  const clear = () => {
    if (gate.current === child) gate.current = null;
  };
  const capture = (chunk) => {
    output = (output + String(chunk)).slice(-8192);
    const url = loginUrl(output);
    if (url) finish({ url, pending: true });
  };
  child.stdout?.on?.("data", capture);
  child.stderr?.on?.("data", capture);
  const timer = setTimeout(() => child.kill?.(), timeoutMs);
  child.on?.("error", (error) => {
    clearTimeout(timer);
    clear();
    resolveDone();
    if (!settled) {
      settled = true;
      reject(error);
    }
  });
  child.on?.("close", () => {
    clearTimeout(timer);
    clear();
    finish({ url: loginUrl(output), pending: false });
    resolveDone();
  });
  return { result, done };
}
// Harness keeps Claude Code's setting sources off, so it would read neither
// CLAUDE.md nor AGENTS.md. Pass the project's AGENTS.md on, plus anything
// Claude-only in a CLAUDE.md that imports it with @AGENTS.md.
export async function projectInstructions(dir) {
  const read = (name) =>
    readFile(join(dir, name), "utf8").then(
      (text) => text.trim().slice(0, 40000),
      () => "",
    );
  const agents = await read("AGENTS.md");
  let claude = (await read("CLAUDE.md"))
    .split(/\r?\n/)
    .filter((line) => !/^@(\.\/)?AGENTS\.md$/i.test(line.trim()))
    .join("\n")
    .trim();
  if (claude === agents.replaceAll("\r\n", "\n")) claude = "";
  return [
    agents && "Project instructions from AGENTS.md:\n" + agents,
    claude && "Project instructions from CLAUDE.md:\n" + claude,
  ]
    .filter(Boolean)
    .join("\n\n");
}
export async function usageOf(q) {
  const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof fn !== "function") return null;
  return await fn.call(q, { skipBehaviors: true });
}
// A control-only query verifies interruption without sending a user message.
export async function pauseClaudeGoal(cwd, session, { signal } = {}, { queryFn = query, baseOptions = claudeOptions, timeoutMs = 120000 } = {}) {
  signal?.throwIfAborted();
  const input = new AsyncQueue();
  const q = queryFn({ prompt: input, options: { ...baseOptions(cwd), resume: session.id, tools: [] } });
  const stop = () => q.close();
  signal?.addEventListener("abort", stop, { once: true });
  let timer;
  try {
    await Promise.race([q.interrupt(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Claude has not confirmed interruption")), timeoutMs);
    })]);
    signal?.throwIfAborted();
    return "paused";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    input.end();
    q.close();
  }
}
export async function inspectClaude(
  cwd,
  {
    readAuth = claudeAuth,
    queryFn = query,
    readUsage = usageOf,
    baseOptions = claudeOptions,
    usageForAccount = claudeUsageForAccount,
  } = {},
) {
  const auth = await readAuth(),
    monitor = usageForAccount(auth);
  if (!auth.loggedIn)
    return {
      id: "claude",
      name: "Claude Code",
      route: "Claude subscription",
      connected: false,
      models: [],
      blockReason:
        "Run Claude Code authentication with your Claude subscription.",
      signIn: CLAUDE_SIGN_IN,
    };
  const input = new AsyncQueue(),
    q = queryFn({ prompt: input, options: { ...baseOptions(cwd), tools: [] } });
  try {
    const models = await q.supportedModels(),
      verification = await monitor.read(() => readUsage(q));
    return {
      id: "claude",
      name: "Claude Code",
      route: "Claude subscription",
      plan: auth.subscriptionType,
      connected: true,
      blockReason: verification.reason,
      usage: verification.usage,
      // The SDK's "Default (recommended)" entry only aliases another model.
      models: models
        .filter((m) => m.value !== "default")
        .map((m) => ({
          id: m.value,
          name: m.displayName,
          resolvedModel: m.resolvedModel,
          description: m.description,
          efforts: m.supportedEffortLevels ?? [],
          defaultEffort: m.supportedEffortLevels?.includes("medium")
            ? "medium"
            : null,
          billing: "Included usage · fast mode off",
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
    input.end();
    q.close();
  }
}
// The delegation tools' inputs, as the SDK wants them. The same tools reach
// Codex through their JSON schemas in core/delegation.mjs.
const delegationShapes = {
  delegate_read: {
    paths: z.array(z.string()),
    question: z.string(),
    purpose: z.enum(["read", "extract", "triage", "summarise"]),
  },
  delegate_locate: { query: z.string() },
  delegate_edit: {
    path: z.string(),
    instruction: z.string(),
    lines: z.number().int(),
    have_read: z.boolean().optional(),
  },
  delegate_run: { command: z.string(), want: z.string().optional() },
  delegate_draft: {
    kind: z.enum(["commit", "changelog"]),
    staged: z.boolean().optional(),
  },
};

// New SDKs keep the proposal in a file instead of ExitPlanMode's input.
// Only this chat's files written during this run can supply its approval.
export async function readClaudePlan(directory, since) {
  if (!directory) return null;
  const names = await readdir(directory).catch(() => []);
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".md"))
      .map(async (name) => {
        const path = join(directory, name);
        const info = await stat(path).catch(() => null);
        return info?.isFile() && info.mtimeMs >= since
          ? { path, time: info.mtimeMs }
          : null;
      }),
  );
  const latest = files.filter(Boolean).sort((a, b) => b.time - a.time)[0];
  return latest
    ? proposalText(await readFile(latest.path, "utf8").catch(() => ""))
    : null;
}
export async function runClaude(
  ctx,
  {
    queryFn = query,
    readAuth = claudeAuth,
    readUsage = usageOf,
    baseOptions = claudeOptions,
    pollIntervalMs = CLAUDE_USAGE_POLL_INTERVAL_MS,
    usageForAccount = claudeUsageForAccount,
  } = {},
) {
  const planSince = Date.now();
  const planDirectory =
    ctx.dataDir && ctx.chat?.id
      ? join(ctx.dataDir, "plans", "claude", ctx.chat.id)
      : null;
  if (planDirectory) await mkdir(planDirectory, { recursive: true });
  const base = baseOptions(ctx.project.path);
  const input = new AsyncQueue();
  let currentId = "initial";
  const historyServer = createSdkMcpServer({
    name: "harness",
    version: "0.1.0",
    tools: [
      tool(
        "history_search",
        "Search shared conversation history within the selected scope",
        { query: z.string() },
        async (args) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(await ctx.history("history_search", args)),
            },
          ],
        }),
      ),
      tool(
        "history_read",
        "Read a source conversation with attribution",
        { conversationId: z.string(), offset: z.number().optional() },
        async (args) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(await ctx.history("history_read", args)),
            },
          ],
        }),
      ),
      ...memoryClaudeTools(ctx),
      tool(
        "workspace_activity",
        "List the other Harness chats working in this repository right now. Call it before committing.",
        {},
        async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(await ctx.history("workspace_activity", {})),
            },
          ],
        }),
      ),
      tool(
        "rename_chat",
        historyTools.find((t) => t.name === "rename_chat").description,
        { title: z.string() },
        async (args) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(await ctx.history("rename_chat", args)),
            },
          ],
        }),
        // Naming happens before task work, without a tool-discovery round trip.
        { alwaysLoad: true },
      ),
      ...(ctx.tools ?? [])
        .filter((t) => t.name === "ask_user")
        .map((t) =>
          tool(
            t.name,
            t.description,
            {
              questions: z
                .array(
                  z.object({
                    id: z.string().min(1),
                    question: z.string().min(1),
                    multiSelect: z.boolean().optional(),
                    options: z
                      .array(
                        z.object({
                          label: z.string().min(1),
                          description: z.string().min(1),
                        }),
                      )
                      .min(2)
                      .optional(),
                  }),
                )
                .min(1)
                .max(3),
            },
            async (args) => ({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(await ctx.history(t.name, args)),
                },
              ],
            }),
          ),
        ),
      ...(ctx.tools ?? [])
        .filter((t) => t.name === "move_chat")
        .map((t) =>
          tool(
            t.name,
            t.description,
            { directory: z.string().min(1) },
            async (args) => ({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(await ctx.history(t.name, args)),
                },
              ],
            }),
            { alwaysLoad: true },
          ),
        ),
      ...(ctx.tools ?? []).filter((t) => watchTools.some((w) => w.name === t.name)).map((t) =>
        tool(t.name, t.description, {
          watch_github_ci: {
            repository: z.string(), commit: z.string().optional(), pr: z.number().int().positive().optional(),
            resumeOn: z.array(z.enum(["success", "failure", "complete"])).max(3).optional(),
            continuation: z.string().max(2000).optional(), expiryHours: z.number().min(0.25).max(24).optional(),
          },
          list_watches: { id: z.string().optional() },
          cancel_watch: { id: z.string() },
          yield_to_watch: { ids: z.array(z.string()).min(1).max(10), checkpoint: z.string().min(1).max(2000) },
        }[t.name], async (args) => ({ content: [{ type: "text", text: JSON.stringify(await ctx.history(t.name, args)) }] }))),
      ...(ctx.tools ?? [])
        .filter((t) => t.name === ownerPauseTool.name)
        .map((t) =>
          tool(
            t.name,
            t.description,
            { statement: z.string().min(1).max(2000) },
            async (args) => ({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(await ctx.history(t.name, args)),
                },
              ],
            }),
          ),
        ),
      // Offered only on turns where the user's rules allow a hand-off.
      ...(ctx.tools ?? [])
        .filter((t) => delegationShapes[t.name])
        .map((t) =>
          tool(
            t.name,
            t.description,
            delegationShapes[t.name],
            async (args) => ({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(await ctx.history(t.name, args)),
                },
              ],
            }),
          ),
        ),
      // The tool itself always asks the user, including in Ask and Plan modes.
      ...(ctx.tools ?? [])
        .filter((t) => t.name === "suggest_mode")
        .map((t) =>
          tool(
            t.name,
            t.description,
            {
              mode: z.enum(CHAT_MODES),
              reason: z.string().min(1).max(4000),
              objective: z.string().min(1).max(250000).optional(),
            },
            async (args) => ({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(await ctx.history(t.name, args)),
                },
              ],
            }),
          ),
        ),
      // Offered in every mode; the host answers when a call cannot apply.
      ...(ctx.tools ?? [])
        .filter((t) => ["land_changes", "restart_harness"].includes(t.name))
        .map((t) =>
          tool(t.name, t.description, {}, async () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify(await ctx.history(t.name, {})),
              },
            ],
          })),
        ),
      ...(ctx.tools ?? [])
        .filter((t) => t.name === "run_command")
        .map((t) =>
          tool(
            t.name,
            t.description,
            {
              command: z.string().min(1).max(8000),
              shell: z.enum(["powershell", "cmd", "bash"]).optional(),
              cwd: z.string().optional(),
              timeoutSeconds: z.number().int().min(1).max(600).optional(),
              isolateDependencies: z.boolean().optional(),
            },
            async (args) => ({
              content: [
                { type: "text", text: JSON.stringify(await ctx.history(t.name, args)) },
              ],
            }),
          ),
        ),
      // One browser tool. Harness checks the action against Playwright's schema
      // and asks before any action that can change a page.
      ...((gateway) =>
        gateway?.inputSchema?.properties?.action?.enum?.length
          ? [
              tool(
                gateway.name,
                gateway.description,
                {
                  action: z.enum(gateway.inputSchema.properties.action.enum),
                  arguments: z.record(z.string(), z.any()).optional(),
                },
                (args) => ctx.browser(gateway.name, args),
              ),
            ]
          : [])((ctx.tools ?? []).find((t) => t.name === "browser")),
    ],
  });
  const q = queryFn({
    prompt: input,
    options: {
      ...base,
      ...(planDirectory && {
        settings: {
          ...base.settings,
          plansDirectory: planDirectory,
        },
      }),
      ...permissionModes[ctx.permissions ?? "auto"],
      ...(ctx.mode === "plan" && { permissionMode: "plan" }),
      // Ask mode has no native permission mode. The allowlist removes write
      // tools, and canUseTool denies anything that is still requested.
      ...(ctx.mode === "ask" && { tools: CLAUDE_ASK_TOOLS }),
      model: ctx.model,
      effort: ctx.effort || undefined,
      resume: ctx.session?.id,
      allowedTools: [
        "mcp__harness__rename_chat",
        "mcp__harness__suggest_mode",
        "mcp__harness__ask_user",
      ],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        // Project files sit after the stable prefix. A goal handoff stays in
        // the user message so it does not rewrite this prefix.
        append: [ctx.instructions, await projectInstructions(ctx.project.path)]
          .filter(Boolean)
          .join("\n\n"),
      },
      mcpServers: { harness: historyServer },
      canUseTool: async (name, args) => {
        if (ctx.mode === "ask" && !claudeAskAllowed(name, ctx.tools))
          return { behavior: "deny", message: ASK_DENY };
        if (name.startsWith("mcp__harness__"))
          return { behavior: "allow", updatedInput: args };
        // Approving a plan leaves plan mode for the chat's permission mode,
        // as accepting one does in Claude Code.
        if (name === "ExitPlanMode") {
          const plan =
            proposalText(args.plan) ??
            (await readClaudePlan(planDirectory, planSince));
          const answer = await ctx.approve({
            kind: "plan",
            title: "Review the plan before anything changes",
            plan,
            details: args,
          });
          if (!answer.allow)
            return {
              behavior: "deny",
              message: answer.reason
                ? `The user wants to keep planning. Stay in plan mode. ${planRevisionRequest(answer.reason)}`
                : "The user wants to keep planning. Stay in plan mode and ask what to change.",
            };
          // Carrying out a plan inside Goal must not switch the chat to Default.
          if (ctx.mode !== "goal") ctx.planApproved?.();
          return {
            behavior: "allow",
            updatedInput: args,
            updatedPermissions: [
              {
                type: "setMode",
                mode: permissionModes[ctx.permissions ?? "auto"].permissionMode,
                destination: "session",
              },
            ],
          };
        }
        const answer = await ctx.approve({
          kind: name === "AskUserQuestion" ? "question" : "permission",
          title: name,
          questions: args.questions,
          details: args,
        });
        return answer.allow
          ? {
              behavior: "allow",
              updatedInput:
                name === "AskUserQuestion"
                  ? { ...args, answers: claudeQuestionAnswers(answer.answers) }
                  : args,
            }
          : {
              behavior: "deny",
              message: answer.reason
                ? /do not retry/i.test(answer.reason)
                  ? answer.reason
                  : `${answer.reason} Do not retry this action.`
                : "The user declined this action. Do not retry it.",
            };
      },
    },
  });
  const context = contextReporter(ctx, "claude");
  const contextRead = contextSampler(q, context);
  let timer,
    killTimer,
    polling = false,
    finished = false,
    accepting = false,
    stopped = null,
    goalStatus =
      ctx.mode === "goal" ? "unknown" : (ctx.session?.goal?.status ?? null),
    pendingResult = null,
    sawModel = false,
    retriedUnread = false,
    phase = "sign-in check",
    interrupting,
    pauseAcknowledged = false,
    queryClosed = false;
  const closeQuery = () => { if (!queryClosed) { queryClosed = true; q.close(); } };
  ctx.attachClose?.(closeQuery);
  const cancel = () => {
    interrupting ??= q.interrupt().then(() => {
      // An idle gap between Goal turns has no further result to wait for.
      if (ctx.signal.reason?.kind === "user-pause" && pendingResult) {
        pauseAcknowledged = true;
        closeQuery();
      }
    }).catch((error) => {
      if (ctx.signal.reason?.kind !== "user-pause" || ctx.mode !== "goal") closeQuery();
      throw error;
    });
    interrupting.catch(() => {});
    if (ctx.signal.reason?.kind !== "user-pause" || ctx.mode !== "goal")
      killTimer ??= setTimeout(closeQuery, 8000);
  };
  ctx.signal.addEventListener("abort", cancel, { once: true });
  try {
    const auth = await readAuth();
    phase = "subscription usage check";
    const monitor = usageForAccount(auth),
      initial = await monitor.read(() => readUsage(q));
    ctx.emit("usage", initial.usage);
    if (initial.reason) throw new Error(initial.reason);
    if (ctx.signal.aborted)
      throw new Error("Cancelled before the turn started");
    const promptMessage = {
      type: "user",
      message: {
        role: "user",
        content: await claudeContent(ctx),
      },
      parent_tool_use_id: null,
      session_id: ctx.session?.id ?? "",
    };
    input.push(promptMessage);
    accepting = true;
    ctx.attachSteer?.((item) => {
      if (!accepting) throw new Error("Claude's turn has ended");
      input.push({
        type: "user",
        message: { role: "user", content: item.text },
        parent_tool_use_id: null,
        priority: "now",
        session_id: ctx.session?.id ?? "",
      });
    });
    timer = setInterval(async () => {
      if (polling || finished || stopped || ctx.signal.aborted) return;
      polling = true;
      try {
        // A failed lookup is telemetry loss, not evidence of a billing change.
        const next = await monitor.read(() => readUsage(q));
        if (finished || ctx.signal.aborted) return;
        ctx.emit("usage", next.usage);
        if (next.reason) {
          stopped = next.reason;
          ctx.emit("work", { kind: "billing-stop", reason: stopped });
          cancel();
        }
      } finally {
        polling = false;
      }
    }, pollIntervalMs);
    phase = "session stream";
    for await (const event of q) {
      if (event.session_id && !event.parent_tool_use_id && !event.agent_id) {
        ctx.saveSession({ id: event.session_id });
        if (context.snapshot?.sessionId !== event.session_id) context.start(event.session_id);
      }
      if (["assistant", "stream_event", "user"].includes(event.type))
        pendingResult = null;
      if (event.type === "active_goal") {
        goalStatus = event.value ? "active" : "complete";
        ctx.goalState?.(goalStatus, event.value?.condition);
        ctx.emit("work", {
          kind: "goal",
          provider: "claude",
          item: event.value
            ? {
                title: `Goal: ${event.value.condition}`,
                description: [
                  `Checked ${event.value.iterations} ${event.value.iterations === 1 ? "time" : "times"}`,
                  event.value.last_reason,
                ]
                  .filter(Boolean)
                  .join(" · "),
              }
            : { title: "Goal met" },
        });
        if (goalStopped(goalStatus) && pendingResult) return pendingResult;
      }
      if (event.type === "system" && event.subtype === "init" && event.model)
        ctx.emit("nativeModel", { model: event.model, requested: ctx.model });
      if (event.type === "stream_event" && !event.parent_tool_use_id) {
        if (event.event.type === "message_start")
          currentId = event.event.message.id;
        if (
          event.event.type === "content_block_delta" &&
          event.event.delta.type === "text_delta"
        ) {
          sawModel = true;
          ctx.emit("text", {
            nativeId: currentId,
            delta: event.event.delta.text,
          });
        }
      }
      if (event.type === "assistant") {
        if (!event.parent_tool_use_id && !event.agent_id) {
          if (event.message.usage) context.update({ cache: claudeUsage(event.message.usage) });
          void contextRead.sample();
        }
        if (event.parent_tool_use_id)
          ctx.emit("work", {
            kind: "native-subagent",
            provider: "claude",
            parentId: event.parent_tool_use_id,
            item: {
              id: event.uuid,
              text: event.message.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n"),
            },
          });
        else {
          const text = event.message.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          if (text) {
            sawModel = true;
            ctx.emit("text", { nativeId: event.message.id, text });
          }
        }
        for (const block of event.message.content.filter(
          (c) => c.type === "tool_use",
        )) {
          if (!event.parent_tool_use_id && !event.agent_id) sawModel = true;
          ctx.emit("work", {
            kind:
              block.name === "Agent" || block.name === "Task"
                ? "native-subagent"
                : "tool",
            provider: "claude",
            ...(event.parent_tool_use_id && {
              parentId: event.parent_tool_use_id,
            }),
            ...(event.agent_id && { agentId: event.agent_id }),
            item: block,
          });
        }
      }
      if (event.type === "user") {
        // The result names its tool call, so the chat can mark that step done or failed.
        const results = Array.isArray(event.message?.content)
          ? event.message.content.filter((c) => c.type === "tool_result")
          : [];
        for (const result of results.length ? results : event.tool_use_result ? [null] : []) {
          ctx.emit("work", {
            kind: "tool-result",
            provider: "claude",
            ...(result && {
              toolUseId: result.tool_use_id,
              isError: !!result.is_error,
            }),
            ...(event.parent_tool_use_id && {
              parentId: event.parent_tool_use_id,
            }),
            ...(event.agent_id && { agentId: event.agent_id }),
            item: event.tool_use_result,
          });
        }
      }
      if (
        event.type === "system" &&
        [
          "task_started",
          "task_progress",
          "task_updated",
          "task_notification",
          "background_tasks_changed",
          "compact_boundary",
        ].includes(event.subtype)
      )
        ctx.emit("work", {
          kind: event.subtype.startsWith("task")
            ? "native-subagent"
            : event.subtype,
          provider: "claude",
          item: event,
        });
      if (
        event.type === "rate_limit_event" &&
        (event.rate_limit_info?.isUsingOverage ||
          event.rate_limit_info?.overageInUse ||
          event.rate_limit_info?.status === "rejected")
      ) {
        monitor.invalidate();
        stopped = "Claude reported a usage boundary";
        cancel();
        ctx.emit("work", { kind: "billing-stop", reason: stopped });
      }
      if (event.type === "system" && event.subtype === "compact_boundary" && !event.parent_tool_use_id) {
        context.compact();
        void contextRead.sample(true);
      }
      if (event.type === "result") {
        // An interrupted empty result is terminal, never an unread-input retry.
        if (ctx.signal.aborted) {
          await interrupting;
          ctx.pauseConfirmed?.();
          if (ctx.signal.reason?.kind === "watch-yield") ctx.watchParked?.();
          if (ctx.signal.reason?.kind === "owner-pause") ctx.ownerParked?.();
          return { status: "cancelled" };
        }
        // A resumed session can emit a leftover background-task result before
        // it reads the new prompt. That result is not this turn.
        const queuedFollows =
          !event.is_error && (event.queued_turn_count ?? 0) > 0;
        const resultText =
          typeof event.result === "string" ? event.result.trim() : "";
        const unread =
          !event.is_error &&
          !sawModel &&
          !resultText &&
          event.duration_api_ms === 0;
        if (queuedFollows) continue;
        if (unread && !retriedUnread) {
          retriedUnread = true;
          input.push(promptMessage);
          continue;
        }
        if (unread)
          return {
            status: "failed",
            error:
              "Claude closed the turn before it read this message. Send it again.",
          };
        if (!event.is_error && !sawModel && resultText) {
          sawModel = true;
          ctx.emit("text", {
            nativeId: event.uuid || currentId,
            text: event.result,
          });
        }
        context.totals(Object.fromEntries(Object.entries(event.modelUsage ?? {}).map(([model, usage]) => [model, claudeUsage(usage)])), "query-including-native-children");
        await contextRead.sample(true);
        ctx.emit("work", {
          kind: "token-usage",
          modelUsage: event.modelUsage,
          estimatedCostUsd: event.total_cost_usd,
          label: "Provider token/cost estimate; not a charge or quota meter",
        });
        const result = {
          status: ctx.signal.aborted
            ? "cancelled"
            : stopped || event.is_error
              ? "failed"
              : "completed",
          error: stopped || event.errors?.join("\n"),
        };
        if (ctx.signal.reason?.kind === "watch-yield") ctx.watchParked?.();
        if (ctx.signal.reason?.kind === "owner-pause") ctx.ownerParked?.();
        if (
          result.status === "completed" &&
          (ctx.mode === "goal" || goalStatus === "active") &&
          !goalStopped(goalStatus)
        ) {
          pendingResult = result;
          continue;
        }
        if (!event.is_error && result.status === "completed")
          ctx.promptAccepted?.();
        return result;
      }
    }
    if (ctx.signal.aborted && pauseAcknowledged) {
      ctx.pauseConfirmed?.();
      return { status: "cancelled" };
    }
    if (retriedUnread && !sawModel)
      return {
        status: "failed",
        error:
          "Claude closed the turn before it read this message. Send it again.",
      };
    throw new Error(stopped || "Claude ended without a final result");
  } catch (error) {
    if (stopped) return { status: "failed", error: stopped };
    if (error instanceof SyntaxError && /JSON/i.test(error.message))
      throw new Error(
        `Claude returned incomplete or invalid JSON during its ${phase}. The saved chat and goal are retained. Send a message to continue.`,
        { cause: error },
      );
    throw error;
  } finally {
    contextRead.dispose();
    context.finish();
    finished = true;
    accepting = false;
    clearInterval(timer);
    clearTimeout(killTimer);
    ctx.signal.removeEventListener("abort", cancel);
    input.end();
    closeQuery();
    if (stopped) ctx.goalState?.("usageLimited");
  }
}
