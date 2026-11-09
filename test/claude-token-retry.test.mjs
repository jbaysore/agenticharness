import test from "node:test";
import assert from "node:assert/strict";
import { runClaude, claudeTokenRetryMs } from "../src/providers/claude.mjs";

const clash =
  "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again";

function run(rounds) {
  const prompts = [],
    work = [],
    texts = [];
  const result = runClaude(
    {
      project: { path: process.cwd() },
      mode: "default",
      text: "Done. The owner confirmed this is complete.",
      signal: new AbortController().signal,
      emit(type, payload) {
        if (type === "work") work.push(payload);
        if (type === "text") texts.push(payload.text);
      },
      saveSession() {},
    },
    {
      baseOptions: () => ({}),
      readAuth: async () => ({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "pro",
      }),
      readUsage: async () => ({
        rate_limits_available: true,
        rate_limits: {
          extra_usage: { is_enabled: false, user_disabled: true },
          limits: [{ kind: "five_hour", percent: 1 }],
        },
      }),
      queryFn: ({ prompt }) => ({
        interrupt: async () => {},
        close() {},
        async *[Symbol.asyncIterator]() {
          for (const round of rounds) {
            prompts.push((await prompt.next()).value);
            yield* round;
          }
        },
      }),
    },
  );
  return { result, prompts, work, texts };
}

const failed = [
  {
    type: "assistant",
    error: "authentication_failed",
    message: { id: "m1", content: [{ type: "text", text: clash }] },
  },
  { type: "result", is_error: true, result: clash, duration_api_ms: 0 },
];
const succeeded = [
  {
    type: "assistant",
    message: { id: "m2", content: [{ type: "text", text: "Continuing." }] },
  },
  { type: "result", is_error: false, result: "Continuing.", duration_api_ms: 5 },
];

test("a shared sign-in refresh clash is waited out and the message sent again", async () => {
  const saved = claudeTokenRetryMs.value;
  claudeTokenRetryMs.value = 5;
  try {
    const f = run([failed, succeeded]);
    const outcome = await f.result;
    assert.equal(outcome.status, "completed");
    assert.equal(f.prompts.length, 2);
    assert.deepEqual(f.prompts[1], f.prompts[0]);
    assert.ok(f.work.some((item) => item.kind === "provider-retry"));
    assert.deepEqual(f.texts, ["Continuing."]);
  } finally {
    claudeTokenRetryMs.value = saved;
  }
});

test("a repeated sign-in clash fails with the provider's message", async () => {
  const saved = claudeTokenRetryMs.value;
  claudeTokenRetryMs.value = 5;
  try {
    const f = run([failed, failed, failed]);
    const outcome = await f.result;
    assert.equal(outcome.status, "failed");
    assert.equal(f.prompts.length, 3);
    assert.match(outcome.error, /Failed to refresh OAuth token/);
  } finally {
    claudeTokenRetryMs.value = saved;
  }
});
