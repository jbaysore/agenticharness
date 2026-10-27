import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AsyncQueue } from "../src/core/queue.mjs";
import { executable } from "../src/core/executables.mjs";
import { subscriptionEnvironment } from "../src/security/environment.mjs";
import { CLAUDE_SESSION_SETTINGS } from "../src/providers/claude.mjs";
const cwd = resolve(".local/probe-project");
await mkdir(cwd, { recursive: true });
const input = new AsyncQueue();
const q = query({
  prompt: input,
  options: {
    cwd,
    pathToClaudeCodeExecutable: executable("claude"),
    env: subscriptionEnvironment(),
    settingSources: [],
    strictMcpConfig: true,
    settings: CLAUDE_SESSION_SETTINGS,
    tools: [],
    permissionMode: "default",
    includePartialMessages: true,
  },
});
try {
  const account = await q.accountInfo(),
    models = await q.supportedModels();
  const usage =
    await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    });
  const context = process.argv.includes("--context")
    ? await q.getContextUsage({ detail: "summary" })
    : null;
  console.log(
    JSON.stringify(
      {
        account: {
          subscriptionType: account.subscriptionType,
          apiProvider: account.apiProvider,
        },
        models: models.map((m) => ({
          id: m.value,
          resolved: m.resolvedModel,
          efforts: m.supportedEffortLevels,
        })),
        usage: {
          plan: usage.subscription_type,
          available: usage.rate_limits_available,
          extraUsage: usage.rate_limits?.extra_usage?.is_enabled,
          windows: usage.rate_limits?.limits,
        },
        ...(context && {
          context: {
            model: context.model,
            usedTokens: context.totalTokens,
            workingWindowTokens: context.rawMaxTokens,
            method: "summary (no inference or per-category token-count calls)",
          },
        }),
      },
      null,
      2,
    ),
  );
  if (process.argv.includes("--smoke")) {
    if (
      account.apiProvider !== "firstParty" ||
      !["pro", "max"].includes(usage.subscription_type) ||
      usage.rate_limits?.extra_usage?.is_enabled !== false
    )
      throw new Error(
        "Subscription-only billing could not be established from the CLI",
      );
    input.push({
      type: "user",
      message: {
        role: "user",
        content:
          "Reply with exactly: subscription connection verified. Do not use tools.",
      },
      parent_tool_use_id: null,
      session_id: "",
    });
    for await (const event of q)
      if (event.type === "result") {
        console.log(
          JSON.stringify({
            type: event.type,
            subtype: event.subtype,
            result: event.result,
            error: event.errors,
            modelUsage: Object.keys(event.modelUsage ?? {}),
          }),
        );
        break;
      }
  }
} finally {
  input.end();
  q.close();
}
