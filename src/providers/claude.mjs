import {
  query,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AsyncQueue } from "../core/queue.mjs";
import { executable } from "../core/executables.mjs";
import { subscriptionEnvironment } from "../security/environment.mjs";
import { isBrowserTool } from "../core/browser.mjs";
import { claudeContent } from "./attachments.mjs";
import {
  checkClaudeBilling,
  createClaudeUsageMonitor,
} from "../security/claude-usage.mjs";
export { checkClaudeBilling };
const exec = promisify(execFile);

export function claudeOptions(cwd) {
  const path = executable("claude");
  if (!path) throw new Error("Claude Code is not installed");
  return {
    cwd,
    pathToClaudeCodeExecutable: path,
    env: subscriptionEnvironment(),
    settingSources: [],
    strictMcpConfig: true,
    settings: { forceLoginMethod: "claudeai", fastMode: false },
    permissionMode: "default",
    includePartialMessages: true,
    extraArgs: { "forward-subagent-text": null },
  };
}
// Harness's permission modes in Claude Code's terms. Auto mode's classifier
// still asks through canUseTool when it cannot decide.
const permissionModes = {
  manual: { permissionMode: "default" },
  auto: { permissionMode: "auto" },
  override: {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
};
export async function claudeAuth() {
  const path = executable("claude");
  if (!path) throw new Error("Claude Code is not installed");
  const result = await exec(path, ["auth", "status"], {
    env: subscriptionEnvironment(),
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 128 * 1024,
  });
  return JSON.parse(result.stdout);
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
  try {
    return await fn.call(q, { skipBehaviors: true });
  } catch {
    return null;
  }
}
export async function inspectClaude(cwd) {
  const auth = await claudeAuth();
  if (!auth.loggedIn)
    return {
      id: "claude",
      name: "Claude Code",
      route: "Claude subscription",
      connected: false,
      models: [],
      blockReason:
        "Run Claude Code authentication with your Claude subscription.",
    };
  const input = new AsyncQueue(),
    q = query({ prompt: input, options: { ...claudeOptions(cwd), tools: [] } });
  try {
    const models = await q.supportedModels(),
      verification = createClaudeUsageMonitor(auth).update(await usageOf(q));
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
// Browser tools arrive as JSON schemas; one the SDK cannot take is left out.
const browserShape = (schema) => {
  try {
    return z.fromJSONSchema(schema).shape;
  } catch {
    return null;
  }
};
export async function runClaude(
  ctx,
  {
    queryFn = query,
    readAuth = claudeAuth,
    readUsage = usageOf,
    baseOptions = claudeOptions,
    pollIntervalMs = 20000,
  } = {},
) {
  const input = new AsyncQueue(),
    goal = ctx.mode === "goal";
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
      tool(
        "project_notes",
        "Read project decisions and evidence",
        {},
        async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(await ctx.history("project_notes", {})),
            },
          ],
        }),
      ),
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
        "Give this chat a concise title summarizing the user's first message. Works once and never replaces a title the user chose.",
        { title: z.string() },
        async (args) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(await ctx.history("rename_chat", args)),
            },
          ],
        }),
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
      // Offered only to a chat working in its own worktree.
      ...(ctx.tools ?? [])
        .filter((t) => t.name === "land_changes")
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
      // Harness asks the user before any browser action that can change a page.
      ...(ctx.tools ?? [])
        .filter((t) => isBrowserTool(t.name))
        .map((t) => [t, browserShape(t.inputSchema)])
        .filter(([, shape]) => shape)
        .map(([t, shape]) =>
          tool(t.name, t.description, shape, (args) =>
            ctx.browser(t.name, args),
          ),
        ),
    ],
  });
  const q = queryFn({
    prompt: input,
    options: {
      ...baseOptions(ctx.project.path),
      ...permissionModes[ctx.permissions ?? "auto"],
      ...(ctx.mode === "plan" && { permissionMode: "plan" }),
      model: ctx.model,
      effort: ctx.effort || undefined,
      resume: ctx.session?.id,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        // /goal has to open the message, so a goal turn's hand-off goes here.
        append: [
          ctx.instructions,
          goal && ctx.handoff,
          await projectInstructions(ctx.project.path),
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      mcpServers: { harness: historyServer },
      canUseTool: async (name, args) => {
        if (name.startsWith("mcp__harness__"))
          return { behavior: "allow", updatedInput: args };
        // Approving a plan leaves plan mode for the chat's permission mode,
        // as accepting one does in Claude Code.
        if (name === "ExitPlanMode") {
          const answer = await ctx.approve({
            kind: "plan",
            title: "Review the plan before anything changes",
            plan: args.plan,
            details: args,
          });
          if (!answer.allow)
            return {
              behavior: "deny",
              message:
                "The user wants to keep planning. Stay in plan mode and ask what to change.",
            };
          ctx.planApproved?.();
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
                  ? { ...args, answers: answer.answers }
                  : args,
            }
          : {
              behavior: "deny",
              message: "The user declined this action. Do not retry it.",
            };
      },
    },
  });
  let timer,
    killTimer,
    polling = false,
    finished = false,
    stopped = null;
  const cancel = () => {
    q.interrupt().catch(() => q.close());
    killTimer ??= setTimeout(() => q.close(), 8000);
  };
  ctx.signal.addEventListener("abort", cancel, { once: true });
  try {
    const auth = await readAuth(),
      monitor = createClaudeUsageMonitor(auth),
      initial = monitor.update(await readUsage(q));
    ctx.emit("usage", initial.usage);
    if (initial.reason) throw new Error(initial.reason);
    if (ctx.signal.aborted)
      throw new Error("Cancelled before the turn started");
    input.push({
      type: "user",
      message: {
        role: "user",
        content: await claudeContent(ctx),
      },
      parent_tool_use_id: null,
      session_id: ctx.session?.id ?? "",
    });
    timer = setInterval(async () => {
      if (polling || finished || stopped || ctx.signal.aborted) return;
      polling = true;
      try {
        // A failed lookup is telemetry loss, not evidence of a billing change.
        const reading = await readUsage(q).catch(() => null);
        if (finished || ctx.signal.aborted) return;
        const next = monitor.update(reading);
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
    for await (const event of q) {
      if (event.session_id) ctx.saveSession({ id: event.session_id });
      if (event.type === "active_goal")
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
      if (event.type === "system" && event.subtype === "init" && event.model)
        ctx.emit("nativeModel", { model: event.model, requested: ctx.model });
      if (event.type === "stream_event" && !event.parent_tool_use_id) {
        if (event.event.type === "message_start")
          currentId = event.event.message.id;
        if (
          event.event.type === "content_block_delta" &&
          event.event.delta.type === "text_delta"
        )
          ctx.emit("text", {
            nativeId: currentId,
            delta: event.event.delta.text,
          });
      }
      if (event.type === "assistant") {
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
          if (text) ctx.emit("text", { nativeId: event.message.id, text });
        }
        for (const block of event.message.content.filter(
          (c) => c.type === "tool_use",
        ))
          ctx.emit("work", {
            kind:
              block.name === "Agent" || block.name === "Task"
                ? "native-subagent"
                : "tool",
            provider: "claude",
            ...(event.parent_tool_use_id && {
              parentId: event.parent_tool_use_id,
            }),
            item: block,
          });
      }
      if (event.type === "user" && event.tool_use_result) {
        // The result names its tool call, so the chat can mark that step done or failed.
        const result = Array.isArray(event.message?.content)
          ? event.message.content.find((c) => c.type === "tool_result")
          : null;
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
          item: event.tool_use_result,
        });
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
        stopped = "Claude reported a usage boundary";
        cancel();
        ctx.emit("work", { kind: "billing-stop", reason: stopped });
      }
      if (event.type === "result") {
        ctx.emit("work", {
          kind: "token-usage",
          modelUsage: event.modelUsage,
          estimatedCostUsd: event.total_cost_usd,
          label: "Provider token/cost estimate; not a charge or quota meter",
        });
        return {
          status: ctx.signal.aborted
            ? "cancelled"
            : stopped || event.is_error
              ? "failed"
              : "completed",
          error: stopped || event.errors?.join("\n"),
        };
      }
    }
    throw new Error(stopped || "Claude ended without a final result");
  } catch (error) {
    if (stopped) return { status: "failed", error: stopped };
    throw error;
  } finally {
    finished = true;
    clearInterval(timer);
    clearTimeout(killTimer);
    ctx.signal.removeEventListener("abort", cancel);
    input.end();
    q.close();
  }
}
