import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.mjs";
import { runClaude } from "../src/providers/claude.mjs";
import {
  claudeContextReading,
  codexContextReading,
  contextMeterView,
  cursorContextReading,
  formatContextTokens,
  mergeContext,
  unreportedReading,
} from "../src/core/context-usage.mjs";

const at = "2026-10-23T12:00:00.000Z";

test("Codex occupancy is the latest call, not the lifetime total", () => {
  const reading = codexContextReading({
    model: "gpt-5.6",
    measuredAt: at,
    tokenUsage: {
      last: {
        cachedInputTokens: 90000,
        inputTokens: 80000,
        outputTokens: 4120,
        reasoningOutputTokens: 3000,
        totalTokens: 84120,
      },
      total: {
        inputTokens: 900000,
        outputTokens: 80000,
        totalTokens: 980000,
      },
      modelContextWindow: 200000,
    },
  });
  assert.deepEqual(reading, {
    provider: "codex",
    model: "gpt-5.6",
    used: 84120,
    window: 200000,
    percentage: 42,
    status: "measured",
    measuredAt: at,
  });
  assert.equal(codexContextReading({ tokenUsage: { total: { totalTokens: 10 } } }), null);
  const open = codexContextReading({
    model: "gpt-5.6",
    measuredAt: at,
    tokenUsage: {
      last: { totalTokens: 5000 },
      modelContextWindow: null,
    },
  });
  assert.equal(open.used, 5000);
  assert.equal(open.window, null);
  assert.equal(open.percentage, null);
});

test("compaction keeps the last Codex numbers and marks them stale", () => {
  const measured = codexContextReading({
    model: "gpt-5.6",
    measuredAt: at,
    tokenUsage: {
      last: { totalTokens: 180000 },
      modelContextWindow: 200000,
    },
  });
  const compacting = mergeContext(measured, {
    kind: "compacting",
    provider: "codex",
    model: "gpt-5.6",
  });
  assert.equal(compacting.status, "compacting");
  assert.equal(compacting.used, 180000);
  assert.equal(compacting.percentage, 90);
  const view = contextMeterView({
    reading: compacting,
    provider: "codex",
    model: "gpt-5.6",
  });
  assert.equal(view.dimmed, true);
  assert.match(view.title, /Compacting/);
  assert.match(view.text, /90%/);
});

test("Claude uses the context API window and ignores cumulative totals", () => {
  const reading = claudeContextReading({
    requestedModel: "sonnet",
    measuredAt: at,
    usage: {
      totalTokens: 1200,
      rawMaxTokens: 200000,
      maxTokens: 1000000,
      percentage: 0.6,
      model: "claude-sonnet-4-6",
    },
  });
  assert.equal(reading.used, 1200);
  assert.equal(reading.window, 200000);
  assert.equal(reading.percentage, 1);
  assert.equal(reading.model, "claude-sonnet-4-6");
  assert.equal(reading.status, "measured");
  const missing = claudeContextReading({ requestedModel: "sonnet", usage: null });
  assert.equal(missing.status, "unreported");
  assert.equal(missing.used, null);
  const over = claudeContextReading({
    requestedModel: "sonnet",
    usage: { totalTokens: 210000, rawMaxTokens: 200000, percentage: 105, model: "sonnet" },
  });
  assert.equal(over.percentage, 105);
  assert.equal(over.model, "sonnet");
});

test("a Claude compaction token count keeps the previous window", () => {
  const previous = claudeContextReading({
    requestedModel: "sonnet",
    measuredAt: at,
    usage: { totalTokens: 180000, rawMaxTokens: 200000, percentage: 90, model: "sonnet" },
  });
  const next = mergeContext(previous, {
    kind: "used",
    provider: "claude",
    model: "sonnet",
    used: 4000,
    measuredAt: at,
  });
  assert.equal(next.used, 4000);
  assert.equal(next.window, 200000);
  assert.equal(next.percentage, 2);
  assert.equal(next.status, "measured");
});

test("Cursor accepts used and size together and drops cost", () => {
  const reading = cursorContextReading({
    model: "composer-2.5",
    measuredAt: at,
    update: {
      sessionUpdate: "usage_update",
      used: 53000,
      size: 200000,
      cost: { amount: 1.25, currency: "USD" },
    },
  });
  assert.deepEqual(reading, {
    provider: "cursor",
    model: "composer-2.5",
    used: 53000,
    window: 200000,
    percentage: 27,
    status: "measured",
    measuredAt: at,
  });
  assert.equal(
    cursorContextReading({
      update: { sessionUpdate: "usage_update", used: 10, cost: { amount: 1, currency: "USD" } },
    }),
    null,
  );
  assert.equal(cursorContextReading({ update: { sessionUpdate: "tool_call" } }), null);
});

test("a model change keeps the old numbers without presenting them as current", () => {
  const previous = cursorContextReading({
    model: "composer-2.5",
    measuredAt: at,
    update: { sessionUpdate: "usage_update", used: 53000, size: 200000 },
  });
  const moved = mergeContext(previous, {
    kind: "retarget",
    provider: "cursor",
    model: "grok-4",
  });
  assert.equal(moved.used, 53000);
  assert.equal(moved.model, "grok-4");
  assert.equal(moved.status, "unmeasured");
  const view = contextMeterView({
    reading: moved,
    provider: "cursor",
    model: "composer-2.5",
  });
  assert.equal(view.text, "Context not measured");
  assert.equal(view.title, "Not measured for this model.");
  assert.equal(view.percentage, null);
});

test("the footer distinguishes missing readings from unreported providers", () => {
  assert.equal(
    contextMeterView({ provider: "codex", model: "gpt" }).text,
    "Context not measured",
  );
  assert.equal(
    contextMeterView({ provider: "cursor", model: "composer" }).text,
    "Context not reported",
  );
  const reading = codexContextReading({
    model: "gpt",
    measuredAt: at,
    tokenUsage: { last: { totalTokens: 84120 }, modelContextWindow: 200000 },
  });
  const wide = contextMeterView({ reading, provider: "codex", model: "gpt" });
  assert.equal(wide.text, "42% · 84.1k/200k");
  assert.match(wide.title, /84,120 of 200,000 context tokens/);
  assert.match(wide.title, /Latest model call/);
  const narrow = contextMeterView({
    reading,
    provider: "codex",
    model: "gpt",
    compact: true,
  });
  assert.equal(narrow.text, "42%");
  assert.match(narrow.aria, /84,120 of 200,000/);
  assert.equal(
    contextMeterView({ provider: "codex", model: "gpt", compact: true }).text,
    "Not measured",
  );
  const claude = contextMeterView({
    reading: claudeContextReading({
      requestedModel: "sonnet",
      usage: { totalTokens: 10, rawMaxTokens: 200000, percentage: 0, model: "claude-sonnet-4-6" },
    }),
    provider: "claude",
    model: "sonnet",
    resolvedModel: "claude-sonnet-4-6",
  });
  assert.match(claude.title, /compaction limit/);
  assert.equal(formatContextTokens(1500), "1500");
  assert.equal(formatContextTokens(1_500_000), "1.5m");
  assert.equal(unreportedReading("claude", "sonnet").percentage, null);
});

test("a saved reading survives reload and does not reorder the chat", () => {
  const db = new Store(":memory:");
  const project = db.addProject("Project", "C:\\example"),
    chat = db.createConversation({
      projectId: project.id,
      provider: "codex",
      model: "gpt",
    });
  const reading = codexContextReading({
    model: "gpt",
    measuredAt: at,
    tokenUsage: { last: { totalTokens: 84120 }, modelContextWindow: 200000 },
  });
  const saved = db.setContextUsage(chat.id, reading);
  assert.equal(saved.updated_at, chat.updated_at);
  assert.deepEqual(db.conversation(chat.id).context_usage, reading);
  const stale = db.setContextUsage(chat.id, {
    kind: "compacting",
    provider: "codex",
    model: "gpt",
  });
  assert.equal(stale.context_usage.status, "compacting");
  assert.equal(stale.context_usage.used, 84120);
  db.close();
});

test("Claude asks only for a summary context reading", async () => {
  const events = [],
    calls = [];
  const result = await runClaude(
    {
      project: { path: process.cwd() },
      model: "sonnet",
      text: "Check context",
      permissions: "manual",
      signal: new AbortController().signal,
      saveSession() {},
      emit(type, payload) {
        events.push({ type, payload });
      },
      history: async () => ({}),
      approve: async () => ({ allow: true }),
    },
    {
      baseOptions: () => ({}),
      pollIntervalMs: 60_000,
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
          limits: [],
        },
      }),
      queryFn: ({ prompt }) => ({
        interrupt: async () => {},
        close() {},
        getContextUsage: async (opts) => {
          calls.push(opts);
          return {
            totalTokens: 1200,
            rawMaxTokens: 200000,
            maxTokens: 1000000,
            percentage: 1,
            model: "sonnet",
          };
        },
        async *[Symbol.asyncIterator]() {
          await prompt[Symbol.asyncIterator]().next();
          yield {
            type: "assistant",
            message: {
              id: "m1",
              content: [{ type: "text", text: "ok" }],
              stop_reason: "tool_use",
            },
          };
          yield {
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 180000, post_tokens: 4000 },
          };
          yield {
            type: "result",
            is_error: false,
            modelUsage: {
              sonnet: { inputTokens: 999999, outputTokens: 10, contextWindow: 1000000 },
            },
            total_cost_usd: 4,
          };
        },
      }),
    },
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, [
    { detail: "summary" },
    { detail: "summary" },
    { detail: "summary" },
  ]);
  const contexts = events.filter((event) => event.type === "context");
  assert.equal(contexts[0].payload.used, 1200);
  assert.deepEqual(contexts[1].payload, {
    kind: "used",
    provider: "claude",
    model: "sonnet",
    used: 4000,
  });
  assert.ok(contexts.every((event) => event.payload.used !== 999999));
  assert.equal(contexts.at(-1).payload.window, 200000);
  assert.equal(
    events.some((event) => event.payload?.estimatedCostUsd === 4),
    true,
  );
});
