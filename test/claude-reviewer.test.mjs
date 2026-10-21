import test from "node:test";
import assert from "node:assert/strict";
import { runClaudeWorker } from "../src/providers/workers.mjs";
import { REVIEW_SCHEMA } from "../src/core/review-policy.mjs";

const auth = () => ({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "pro",
});
const usage = () => ({
  rate_limits_available: true,
  rate_limits: {
    extra_usage: { is_enabled: false, user_disabled: true },
    limits: [{ percent: 10 }],
  },
});
const verdict = { decision: "allow", reason: "The task permits this action." };
const result = () => ({
  type: "result",
  is_error: false,
  result: "Use structured_output instead of this text",
  structured_output: verdict,
  modelUsage: {
    "claude-pinned": {
      inputTokens: 10,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  },
});

function fixture({ problem, signal = new AbortController().signal } = {}) {
  let options,
    closed = false,
    inputSeen = false,
    reads = 0,
    release;
  const q = {
    close() {
      closed = true;
      release?.();
    },
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      const input = await q.prompt.next();
      inputSeen = !input.done;
      if (problem === "poll" || problem === "cancel") {
        await new Promise((resolve) => {
          release = resolve;
        });
        throw new Error("SDK session closed");
      }
      if (problem === "overage-event")
        yield {
          type: "rate_limit_event",
          rate_limit_info: { isUsingOverage: true },
        };
      if (problem === "tool")
        yield {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash" }] },
        };
      const event = result();
      if (problem === "missing-output") delete event.structured_output;
      if (problem === "error") {
        event.is_error = true;
        event.errors = ["Structured output failed"];
      }
      yield event;
    },
  };
  const run = () =>
    runClaudeWorker(
      {
        cwd: process.cwd(),
        model: "claude-pinned",
        effort: "high",
        task: "Synthetic review",
        mode: "review",
        signal,
      },
      {
        queryFn: (args) => {
          options = args.options;
          q.prompt = args.prompt;
          return q;
        },
        baseOptions: () => ({
          settingSources: [],
          strictMcpConfig: true,
          settings: { forceLoginMethod: "claudeai", fastMode: false },
        }),
        readAuth: async () => ({
          ...auth(),
          ...(problem === "api" && { authMethod: "api_key" }),
        }),
        readUsage: async () => {
          reads++;
          const current = usage();
          if (
            problem === "quota" ||
            (["post-quota", "poll"].includes(problem) && reads > 1)
          )
            current.rate_limits.limits[0].percent = 100;
          if (problem === "paid")
            current.rate_limits.extra_usage.is_enabled = true;
          if (problem === "unknown") current.rate_limits_available = false;
          return current;
        },
        pollIntervalMs: 5,
      },
    );
  return {
    run,
    get options() {
      return options;
    },
    get closed() {
      return closed;
    },
    get inputSeen() {
      return inputSeen;
    },
    get reads() {
      return reads;
    },
  };
}

test("Claude reviewer uses the pinned model, no execution tools, structured output and verified included usage", async () => {
  const f = fixture(),
    answer = await f.run();
  assert.equal(answer.text, JSON.stringify(verdict));
  assert.equal(answer.model, "claude-pinned");
  assert.equal(f.options.model, "claude-pinned");
  assert.equal(f.options.effort, "high");
  assert.deepEqual(f.options.tools, []);
  assert.deepEqual(f.options.mcpServers, {});
  assert.deepEqual(f.options.plugins, []);
  assert.deepEqual(f.options.hooks, {});
  assert.equal(f.options.settings.disableAllHooks, true);
  assert.equal(f.options.settings.fastMode, false);
  assert.equal(f.options.permissionMode, "dontAsk");
  assert.equal(f.options.persistSession, false);
  assert.deepEqual(f.options.outputFormat, {
    type: "json_schema",
    schema: REVIEW_SCHEMA,
  });
  assert.equal(
    (await f.options.canUseTool("Bash", { command: "must not run" })).behavior,
    "deny",
  );
  assert.equal(
    (await f.options.canUseTool("StructuredOutput", verdict)).behavior,
    "allow",
  );
  assert.equal(f.reads, 2);
  assert.equal(f.inputSeen, true);
  assert.equal(f.closed, true);
});

for (const problem of [
  "api",
  "quota",
  "paid",
  "unknown",
  "post-quota",
  "poll",
  "overage-event",
  "tool",
  "missing-output",
  "error",
])
  test(`Claude reviewer fails closed for ${problem}`, async () => {
    const f = fixture({ problem });
    await assert.rejects(f.run());
    assert.equal(f.closed, true);
    if (["api", "quota", "paid", "unknown"].includes(problem))
      assert.equal(f.inputSeen, false);
  });

test("cancelling a Claude review closes the SDK session without returning a verdict", async () => {
  const abort = new AbortController(),
    f = fixture({ problem: "cancel", signal: abort.signal }),
    run = f.run();
  while (!f.inputSeen) await new Promise((resolve) => setTimeout(resolve, 1));
  abort.abort();
  await assert.rejects(run);
  assert.equal(f.closed, true);
});
