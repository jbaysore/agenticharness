import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import {
  contextReporter,
  contextSampler,
  openAIUsage,
  claudeUsage,
  usageDelta,
} from "../src/core/context.mjs";
import {
  contextView,
  cacheReuse,
  mergeContextSnapshots,
} from "../src/ui/context.mjs";
import {
  promptDelivery,
  independentDeliveryEnabled,
} from "../src/core/history.mjs";
import { toolFingerprint } from "../src/core/host-tools.mjs";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { runClaude } from "../src/providers/claude.mjs";
import { runCursor } from "../src/providers/cursor.mjs";
import { EventEmitter } from "node:events";
import {
  openClaudeReviewer,
  openCodexReviewer,
} from "../src/providers/workers.mjs";

function fixture(prior) {
  const events = [],
    abort = new AbortController();
  let invalidations = 0;
  const reporter = contextReporter(
    {
      model: "m",
      context: prior,
      signal: abort.signal,
      emit: (type, value) => events.push({ type, value }),
      invalidatePromptDelivery: () => invalidations++,
    },
    "claude",
  );
  reporter.start("s");
  return {
    reporter,
    events,
    abort,
    get invalidations() {
      return invalidations;
    },
  };
}

test("input categories preserve provider semantics and reasoning is never counted twice", () => {
  const openai = openAIUsage({
    inputTokens: 1000,
    cachedInputTokens: 800,
    cacheWriteTokens: 100,
    outputTokens: 200,
    reasoningOutputTokens: 150,
  });
  assert.equal(openai.uncachedInputTokens, 100);
  assert.equal(openai.inputTokens, 1000);
  assert.equal(openai.outputTokens, 200);
  assert.equal(
    openAIUsage({ inputTokens: 1000, cachedInputTokens: 800 })
      .uncachedInputTokens,
    null,
  );
  const claude = claudeUsage({
    input_tokens: 100,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 100,
    output_tokens: 200,
  });
  assert.equal(claude.inputTokens, 1000);
  assert.equal(claude.outputTokens, 200);
  assert.equal(claudeUsage({ input_tokens: 100 }).inputTokens, null);
  const router = openAIUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
  });
  assert.equal(router.uncachedInputTokens, 100);
  assert.equal(
    openAIUsage({ inputTokens: "1000", cachedInputTokens: -1 }).inputTokens,
    null,
  );
});

test("cumulative totals replace earlier snapshots, with unknown baselines and resets explicit", () => {
  assert.equal(usageDelta(null, { inputTokens: 100 }), null);
  assert.deepEqual(
    usageDelta(
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 130, outputTokens: 25 },
    ),
    { inputTokens: 30, outputTokens: 5 },
  );
  assert.deepEqual(usageDelta({ inputTokens: 100 }, { inputTokens: 100 }), {
    inputTokens: 0,
  });
  assert.deepEqual(usageDelta({ inputTokens: 100 }, { inputTokens: 10 }), {
    inputTokens: null,
  });
  const f = fixture();
  f.reporter.totals(
    { m: { inputTokens: 100, outputTokens: 20 } },
    "query-including-native-children",
  );
  f.reporter.totals(
    { m: { inputTokens: 130, outputTokens: 25 } },
    "query-including-native-children",
  );
  assert.equal(f.reporter.snapshot.usageTotals.m.inputTokens, 130);
  assert.equal(f.reporter.snapshot.usageDeltas.m.inputTokens, 30);
});

test("summary reads are single-flight, throttled, and explicitly avoid token-count calls", async () => {
  const f = fixture(),
    pending = Promise.withResolvers();
  let calls = 0,
    time = 0;
  const sampler = contextSampler(
    {
      getContextUsage: async (opts) => {
        assert.deepEqual(opts, { detail: "summary" });
        calls++;
        return pending.promise;
      },
    },
    f.reporter,
    { now: () => time },
  );
  const first = sampler.sample();
  assert.equal(sampler.sample(), first);
  await tick();
  assert.equal(calls, 1);
  pending.resolve({
    model: "resolved-m",
    totalTokens: 84000,
    rawMaxTokens: 200000,
    categories: [
      { name: "Messages", tokens: 80000, kind: "used" },
      { name: "Reserve", tokens: 4000, kind: "buffer" },
      { name: "Deferred", tokens: 9000, kind: "deferred" },
    ],
  });
  await first;
  assert.equal(f.reporter.snapshot.usedTokens, 84000);
  assert.equal(f.reporter.snapshot.resolvedModel, "resolved-m");
  assert.equal(f.reporter.snapshot.categories.length, 2);
  await sampler.sample();
  assert.equal(calls, 1);
  time = 1000;
  await sampler.sample();
  assert.equal(calls, 2);
  sampler.dispose();
});

test("timed-out summary reads do not pile up or publish late data", async () => {
  const f = fixture(),
    pending = Promise.withResolvers();
  let calls = 0;
  const sampler = contextSampler(
    {
      getContextUsage: () => {
        calls++;
        return pending.promise;
      },
    },
    f.reporter,
    { timeoutMs: 10 },
  );
  await sampler.sample();
  await sampler.sample(true);
  assert.equal(calls, 1);
  pending.resolve({ totalTokens: 80000, rawMaxTokens: 200000 });
  await tick();
  assert.equal(f.reporter.snapshot.usedTokens, null);
  sampler.dispose();
});

for (const change of ["compact", "session", "dispose", "abort"]) {
  test(`late summary cannot cross ${change}`, async () => {
    const f = fixture(),
      pending = Promise.withResolvers();
    const sampler = contextSampler(
      { getContextUsage: () => pending.promise },
      f.reporter,
    );
    const sample = sampler.sample();
    await tick();
    if (change === "compact") f.reporter.compact();
    if (change === "session") f.reporter.start("replacement");
    if (change === "dispose") sampler.dispose();
    if (change === "abort") f.abort.abort();
    pending.resolve({ totalTokens: 9999, rawMaxTokens: 200000 });
    await sample;
    assert.equal(f.reporter.snapshot.usedTokens, null);
    if (change === "compact") assert.equal(f.invalidations, 1);
    sampler.dispose();
  });
}

test("cache expiration does not reset context; compaction changes its generation", () => {
  const f = fixture();
  f.reporter.update({
    usedTokens: 80000,
    windowTokens: 200000,
    accuracy: "provider-reported",
    cache: { inputTokens: 80000, cacheReadTokens: 75000 },
  });
  f.reporter.finish();
  assert.equal(f.reporter.snapshot.usedTokens, 80000);
  assert.equal(contextView(f.reporter.snapshot, { model: "m" }).percent, 40);
  f.reporter.compact();
  assert.equal(contextView(f.reporter.snapshot, { model: "m" }).percent, null);
  assert.equal(f.reporter.snapshot.generation, 1);
});

test("context display distinguishes unknown, zero, high context, and another model", () => {
  assert.equal(contextView(null, { model: "m" }).percent, null);
  assert.equal(
    contextView(null, { model: "m", started: true }).label,
    "Context unavailable",
  );
  const reading = {
    model: "m",
    usedTokens: 0,
    windowTokens: 200000,
    accuracy: "provider-reported",
  };
  assert.equal(contextView(reading, { model: "m" }).percent, 0);
  const over = contextView({ ...reading, usedTokens: 220000 }, { model: "m" });
  assert.equal(Math.round(over.percent), 110);
  assert.equal(over.fill, 100);
  assert.equal(over.level, "high");
  assert.equal(contextView(reading, { model: "other" }).percent, null);
  assert.equal(
    contextView({ ...reading, windowTokens: null }, { model: "m" }).label,
    "Context · limit unavailable",
  );
  assert.equal(cacheReuse({ inputTokens: 1000, cacheReadTokens: 900 }), 90);
  assert.equal(cacheReuse({ inputTokens: 1000, cacheReadTokens: 1100 }), null);
});

test("older HTTP snapshots cannot overwrite newer context events, while real resets clear readings", () => {
  const newer = { codex: { eventId: 35, usedTokens: 84000 } };
  const older = { codex: { eventId: 10, usedTokens: 100 } };
  assert.equal(mergeContextSnapshots(newer, older, 20).codex.usedTokens, 84000);
  assert.deepEqual(mergeContextSnapshots(newer, {}, 40), {});
  const latest = { codex: { eventId: 50, usedTokens: 90000 } };
  assert.equal(
    mergeContextSnapshots(newer, latest, 50).codex.usedTokens,
    90000,
  );
});

test("context projection and event commit atomically, survive recovery, and follow native session identity", () => {
  const store = new Store(":memory:");
  try {
    const project = store.addProject("fixture", process.cwd());
    const chat = store.createConversation({ projectId: project.id });
    store.updateConversation(chat.id, { sessions: { codex: { id: "s" } } });
    const sample = {
      provider: "codex",
      sessionId: "s",
      model: "m",
      usedTokens: 84000,
      windowTokens: 200000,
      state: "ready",
    };
    const event = store.appendEvent(chat.id, null, "context-usage", sample);
    assert.equal(
      store.conversationSnapshot(chat.id).contextByProvider.codex.usedTokens,
      84000,
    );
    assert.equal(store.events(event.id - 1).length, 1);
    const before = store.latestEventId();
    assert.throws(
      () => store.appendEvent("missing", null, "context-usage", sample),
      /FOREIGN KEY/,
    );
    assert.equal(store.latestEventId(), before);
    store.recover();
    assert.equal(store.contextByProvider(chat.id).codex.state, "outdated");
    store.updateConversation(chat.id, { sessions: { codex: { id: "new" } } });
    assert.deepEqual(store.contextByProvider(chat.id), {});
    store.moveConversation(chat.id, project.id);
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM conversation_context").get()
        .n,
      0,
    );
  } finally {
    store.close();
  }
});

test("independent addenda retain the full stable reference without copying it when a notice changes", () => {
  const blocks = [
    { key: "skill", text: "Required evidence. ".repeat(10000) },
    { key: "notice", text: "One peer", clear: "No peers" },
  ];
  const call = (session, next = blocks) =>
    promptDelivery({
      provider: "codex",
      session,
      prefix: "Standing policies",
      addendum: next.map((b) => b.text).join("\n\n"),
      blocks: next,
      independent: true,
    });
  const first = call({});
  const saved = {
    id: "s",
    blockHashes: first.blockHashes,
    acceptedGeneration: 0,
  };
  const changed = call(saved, [blocks[0], { ...blocks[1], text: "Two peers" }]);
  assert.equal(changed.instructions, first.instructions);
  assert.equal(changed.addendum, "Two peers");
  assert.deepEqual(changed.deliveredBlocks, ["notice"]);
  assert.equal(first.addendum.includes(blocks[0].text), true);
  assert.equal(
    call(saved, [{ ...blocks[0], repeat: true }, blocks[1]]).addendum,
    blocks[0].text,
  );
  assert.equal(
    call(saved, [blocks[0], { ...blocks[1], text: "" }]).addendum,
    "No peers",
  );
  assert.equal(call(saved).addendum, "");
});

test("legacy hashes migrate without a thread reset, and compaction re-delivers required context", () => {
  const options = {
    provider: "cursor",
    prefix: "Policy",
    addendum: "Evidence",
    blocks: [{ key: "log", text: "Evidence" }],
    independent: true,
  };
  const first = promptDelivery(options);
  const saved = {
    id: "same-session",
    promptHash: first.promptHash,
    addendumHash: first.addendumHash,
  };
  assert.equal(promptDelivery({ ...options, session: saved }).addendum, "");
  const compacted = promptDelivery({
    ...options,
    session: { ...saved, deliveryGeneration: 1 },
  });
  assert.equal(compacted.instructions, "Policy");
  assert.equal(compacted.addendum, "Evidence");
  assert.equal(
    promptDelivery({ ...options, session: saved, independent: false }).addendum,
    "",
  );
});

test("native verification gates independent delivery per provider, and rollback preserves legacy delivery", () => {
  assert.equal(independentDeliveryEnabled("codex", null), true);
  for (const provider of ["claude", "cursor", "openrouter"])
    assert.equal(independentDeliveryEnabled(provider, null), false);
  assert.equal(independentDeliveryEnabled("codex", false), false);
  assert.equal(independentDeliveryEnabled("claude", { claude: true }), true);
  assert.equal(independentDeliveryEnabled("codex", { claude: true }), false);
});

test("full tool fingerprints catch schema changes without mutating tool order", () => {
  const tools = [
    {
      name: "b",
      inputSchema: { type: "object", properties: { a: { type: "string" } } },
    },
    { name: "a" },
  ];
  const before = JSON.stringify(tools);
  assert.notEqual(
    toolFingerprint(tools),
    toolFingerprint([...tools].reverse()),
  );
  assert.notEqual(
    toolFingerprint(tools),
    toolFingerprint([{ ...tools[0], description: "new" }, tools[1]]),
  );
  assert.equal(before, JSON.stringify(tools));
});

test("failed prompt delivery remains pending, acceptance is durable, and stale callbacks cannot publish", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {}),
    contexts = [];
  try {
    controller.providers = [
      { id: "cursor", models: [{ id: "m", efforts: [] }] },
    ];
    const chat = store.createConversation({
      projectId: store.addProject("fixture", process.cwd()).id,
      provider: "cursor",
      title: "Delivery fixture",
    });
    controller.runners.cursor = async (ctx) => {
      contexts.push(ctx);
      ctx.saveSession({ id: "native" });
      if (contexts.length === 1) throw new Error("input not accepted");
      ctx.promptAccepted();
      ctx.emit("context-usage", {
        provider: "cursor",
        sessionId: "native",
        model: "m",
        usedTokens: 100,
        windowTokens: 1000,
        state: "ready",
      });
      return { status: "completed" };
    };
    const send = async () => {
      controller.send(chat.id, {
        actionId: `context-action-${contexts.length}`,
        text: "Continue",
        provider: "cursor",
        model: "m",
      });
      await controller.active.get(chat.id).task;
    };
    await send();
    assert.equal(
      store.conversation(chat.id).sessions.cursor.promptHash,
      undefined,
    );
    await send();
    assert.equal(contexts[1].instructions, contexts[0].instructions);
    await send();
    assert.equal(contexts[2].instructions, "");
    const before = store.latestEventId();
    contexts[0].emit("context-usage", { sessionId: "native", usedTokens: 999 });
    contexts[0].invalidatePromptDelivery();
    contexts[0].saveSession({ id: "late-native-session" });
    assert.equal(store.latestEventId(), before);
    assert.equal(store.contextByProvider(chat.id).cursor.usedTokens, 100);
    assert.equal(store.conversation(chat.id).sessions.cursor.id, "native");
  } finally {
    store.close();
  }
});

test("Claude reads root context through summary mode and cannot adopt a child session", async () => {
  const events = [],
    saved = [],
    reads = [];
  let accepted = 0;
  const result = await runClaude(
    {
      project: { path: process.cwd() },
      model: "m",
      mode: "default",
      text: "Keep evidence",
      signal: new AbortController().signal,
      emit: (type, value) => events.push({ type, value }),
      saveSession: (s) => saved.push(s.id),
      promptAccepted: () => accepted++,
    },
    {
      baseOptions: () => ({}),
      readAuth: async () => ({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "pro",
      }),
      usageForAccount: () => ({
        read: async () => ({ usage: {}, reason: null }),
      }),
      queryFn: ({ prompt }) => ({
        close() {},
        interrupt: async () => {},
        getContextUsage: async (opts) => {
          reads.push(opts);
          return {
            totalTokens: 84000,
            rawMaxTokens: 200000,
            model: "resolved-m",
            categories: [],
          };
        },
        async *[Symbol.asyncIterator]() {
          await prompt.next();
          yield { type: "system", subtype: "init", session_id: "root" };
          yield {
            type: "assistant",
            session_id: "root",
            message: {
              id: "one",
              content: [],
              usage: {
                input_tokens: 8000,
                cache_read_input_tokens: 72000,
                cache_creation_input_tokens: 0,
                output_tokens: 4000,
              },
            },
          };
          yield {
            type: "assistant",
            session_id: "child",
            parent_tool_use_id: "task",
            message: {
              id: "child-reply",
              content: [],
              usage: { input_tokens: 999999 },
            },
          };
          yield {
            type: "result",
            session_id: "root",
            is_error: false,
            modelUsage: {
              "resolved-m": {
                inputTokens: 8000,
                cacheReadInputTokens: 72000,
                cacheCreationInputTokens: 0,
                outputTokens: 4000,
              },
            },
          };
        },
      }),
    },
  );
  assert.equal(result.status, "completed");
  assert.equal(accepted, 1);
  assert.equal(saved.includes("child"), false);
  assert.ok(reads.length > 0);
  assert.ok(reads.every((opts) => opts.detail === "summary"));
  const reading = events.filter((e) => e.type === "context-usage").at(-1).value;
  assert.equal(reading.usedTokens, 84000);
  assert.equal(reading.cache.cacheReadTokens, 72000);
  assert.equal(reading.usageTotals["resolved-m"].inputTokens, 80000);
});

test("Cursor accepts native usage updates for its own session only", async () => {
  const rpc = new EventEmitter(),
    events = [];
  rpc.close = () => {
    rpc.closed = true;
  };
  rpc.notify = () => {};
  rpc.call = async (method) => {
    if (method === "session/new")
      return {
        sessionId: "root",
        models: { availableModels: [{ modelId: "m", name: "Model" }] },
        configOptions: [{ id: "model", currentValue: "m" }],
      };
    if (method === "session/prompt") {
      rpc.emit("notification", {
        method: "session/update",
        params: {
          sessionId: "root",
          update: { sessionUpdate: "usage_update", used: 84000, size: 200000 },
        },
      });
      rpc.emit("notification", {
        method: "session/update",
        params: {
          sessionId: "child",
          update: { sessionUpdate: "usage_update", used: 190000, size: 200000 },
        },
      });
      return { stopReason: "end_turn" };
    }
    return {};
  };
  const result = await runCursor(
    {
      project: { path: process.cwd() },
      model: "m",
      mode: "default",
      text: "Keep evidence",
      signal: new AbortController().signal,
      emit: (type, value) => events.push({ type, value }),
      saveSession() {},
      billingConfirmation: { fingerprint: "fixture", disabled: true },
    },
    {
      openCursor: async () => rpc,
      cursorAuth: async () => ({ connected: true, fingerprint: "fixture" }),
    },
  );
  assert.equal(result.status, "completed");
  const reading = events.filter((e) => e.type === "context-usage").at(-1).value;
  assert.equal(reading.usedTokens, 84000);
  assert.equal(reading.windowTokens, 200000);
  assert.equal(reading.accuracy, "provider-reported");
});

test("persistent Claude reviewers report each request's delta without re-counting native totals", async () => {
  let turn = 0;
  const reviewer = await openClaudeReviewer(
    { cwd: process.cwd(), model: "m", signal: new AbortController().signal },
    {
      baseOptions: () => ({}),
      readAuth: async () => ({}),
      usageForAccount: () => ({ read: async () => ({ reason: null }) }),
      queryFn: ({ prompt }) => ({
        close() {},
        interrupt: async () => {},
        async *[Symbol.asyncIterator]() {
          for await (const input of prompt) {
            assert.equal(input.type, "user");
            turn++;
            yield {
              type: "result",
              structured_output: { decision: "allow", reason: "Fixture" },
              modelUsage: {
                m: {
                  inputTokens: turn === 1 ? 10 : 30,
                  cacheReadInputTokens: turn === 1 ? 80 : 140,
                  cacheCreationInputTokens: 20,
                  outputTokens: turn === 1 ? 3 : 9,
                },
              },
            };
          }
        },
      }),
    },
  );
  try {
    assert.deepEqual((await reviewer.ask("First")).usage, {
      input: 110,
      output: 3,
    });
    assert.deepEqual((await reviewer.ask("Second")).usage, {
      input: 80,
      output: 6,
    });
  } finally {
    await reviewer.close();
  }
});

test("persistent Codex reviewers report deltas rather than counting earlier reviews again", async () => {
  const rpc = new EventEmitter();
  let turn = 0;
  rpc.close = () => {
    rpc.closed = true;
  };
  rpc.call = async (method) => {
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "account/rateLimits/read")
      return {
        ordinaryUsageAllowed: true,
        rateLimits: {
          primary: { usedPercent: 1 },
          credits: { hasCredits: false, unlimited: false },
        },
      };
    if (method === "config/read")
      return { config: { model_provider: "openai" } };
    if (method === "thread/start") return { thread: { id: "review" } };
    if (method === "turn/start") {
      const n = ++turn;
      queueMicrotask(() => {
        rpc.emit("notification", {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "review",
            tokenUsage: {
              total: {
                inputTokens: n === 1 ? 110 : 190,
                outputTokens: n === 1 ? 3 : 9,
              },
            },
          },
        });
        rpc.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "review",
            item: {
              type: "agentMessage",
              text: '{"decision":"allow","reason":"Fixture"}',
            },
          },
        });
        rpc.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "review",
            turn: { id: `t-${n}`, status: "completed" },
          },
        });
      });
      return { turn: { id: `t-${n}` } };
    }
    return {};
  };
  const reviewer = await openCodexReviewer(
    { cwd: process.cwd(), model: "m", signal: new AbortController().signal },
    { open: async () => rpc },
  );
  try {
    assert.deepEqual((await reviewer.ask("First")).usage, {
      input: 110,
      output: 3,
    });
    assert.deepEqual((await reviewer.ask("Second")).usage, {
      input: 80,
      output: 6,
    });
  } finally {
    await reviewer.close();
  }
});
