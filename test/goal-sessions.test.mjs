import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTick } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { AsyncQueue } from "../src/core/queue.mjs";
import { runCodex } from "../src/providers/codex.mjs";
import { runClaude } from "../src/providers/claude.mjs";
import { claudeContent } from "../src/providers/attachments.mjs";

const deferred = () => Promise.withResolvers();
const flush = async () => {
  await nextTick();
  await nextTick();
};

function codexFixture(extra = {}, savedGoal = "active") {
  const rpc = new EventEmitter(),
    calls = [],
    states = [],
    started = deferred();
  let closes = 0,
    settled = false;
  const notify = (method, params) =>
    rpc.emit("notification", {
      method,
      params: { threadId: "native-goal", ...params },
    });
  rpc.close = () => {
    if (rpc.closed) return;
    closes++;
    rpc.closed = true;
    rpc.emit("closed", new Error("fixture connection closed"));
  };
  rpc.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "account/read")
      return { account: { type: "chatgpt", planType: "pro" } };
    if (method === "account/rateLimits/read")
      return {
        ordinaryUsageAllowed: true,
        rateLimits: {
          primary: { usedPercent: 1 },
          credits: { hasCredits: false, unlimited: false, balance: "0" },
        },
      };
    if (method === "config/read")
      return { config: { model_provider: "openai" } };
    if (["thread/start", "thread/resume"].includes(method))
      return { thread: { id: "native-goal" } };
    if (method === "thread/goal/get") {
      if (savedGoal instanceof Error) throw savedGoal;
      return { goal: savedGoal ? { status: savedGoal } : null };
    }
    if (method === "thread/goal/set") {
      if (params.status === "active")
        setImmediate(() => {
          notify("turn/started", { turn: { id: "turn-1" } });
          started.resolve();
        });
      return { goal: { status: params.status } };
    }
    if (method === "turn/start") {
      started.resolve();
      return { turn: { id: "turn-1" } };
    }
    if (method === "turn/interrupt") return {};
    assert.fail("Unexpected RPC: " + method);
  };
  const abort = new AbortController();
  const run = runCodex(
    {
      project: { path: process.cwd() },
      model: "fixture",
      mode: "goal",
      continuing: true,
      session: { id: "native-goal" },
      text: "Finish the goal",
      signal: abort.signal,
      emit() {},
      saveSession() {},
      goalState: (status) => states.push(status),
      ...extra,
    },
    { open: async () => rpc },
  );
  run.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return {
    rpc,
    notify,
    calls,
    states,
    abort,
    run,
    started: started.promise,
    get closes() {
      return closes;
    },
    get settled() {
      return settled;
    },
  };
}

test("Codex keeps its Goal session open across long continuation gaps", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const f = codexFixture();
  try {
    await f.started;
    await flush();
    f.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    t.mock.timers.tick(15000);
    await flush();
    assert.equal(f.settled, false);
    assert.equal(f.closes, 0);
    assert.equal(
      f.calls.filter((c) => c.method === "thread/goal/set").length,
      1,
    );
    const resumed = f.calls.find((c) => c.method === "thread/goal/set");
    assert.equal(resumed.params.status, "active");
    assert.equal(Object.hasOwn(resumed.params, "objective"), false);
    assert.equal(
      f.calls.some((c) => c.method === "turn/start"),
      false,
    );
    assert.equal(
      f.calls.some((c) => c.method === "turn/interrupt"),
      false,
    );
    f.notify("turn/started", { turn: { id: "turn-2" } });
    f.notify("turn/completed", { turn: { id: "turn-2", status: "completed" } });
    f.notify("thread/goal/updated", { goal: { status: "complete" } });
    assert.equal((await f.run).status, "completed");
    assert.deepEqual(f.states, ["active", "complete"]);
    assert.equal(f.closes, 1);
  } finally {
    f.rpc.close();
    await f.run.catch(() => {});
  }
});

test("Codex context uses the root's last request and compaction, never cumulative or child usage", async () => {
  const readings = [];
  let invalidations = 0;
  const f = codexFixture({ emit: (type, value) => { if (type === "context-usage") readings.push(value); }, invalidatePromptDelivery: () => invalidations++ });
  try {
    await f.started;
    await flush();
    const usage = { last: { totalTokens: 84000, inputTokens: 80000, cachedInputTokens: 72000, outputTokens: 4000 }, total: { totalTokens: 900000, inputTokens: 850000, cachedInputTokens: 700000, outputTokens: 50000 }, modelContextWindow: 200000 };
    f.notify("thread/tokenUsage/updated", { tokenUsage: usage });
    assert.equal(readings.at(-1).usedTokens, 84000);
    assert.equal(readings.at(-1).cache.cacheReadTokens, 72000);
    const before = readings.length;
    f.notify("thread/tokenUsage/updated", { threadId: "child", tokenUsage: { ...usage, last: { ...usage.last, totalTokens: 199000 } } });
    assert.equal(readings.length, before);
    f.notify("item/started", { item: { id: "compact", type: "contextCompaction" } });
    assert.equal(invalidations, 1);
    assert.equal(readings.at(-1).state, "compacting");
    f.notify("item/completed", { item: { id: "compact", type: "contextCompaction" } });
    f.notify("thread/tokenUsage/updated", { tokenUsage: { ...usage, last: { ...usage.last, totalTokens: 20000 } } });
    assert.equal(readings.at(-1).usedTokens, 20000);
    assert.equal(readings.at(-1).generation, 1);
    f.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    f.notify("thread/goal/updated", { goal: { status: "complete" } });
    await f.run;
  } finally { f.rpc.close(); await f.run.catch(() => {}); }
});

test("Codex handles terminal Goal events on either side of turn completion", async (t) => {
  for (const status of [
    "complete",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "cleared",
  ]) {
    for (const before of [false, true])
      await t.test(`${status}, before=${before}`, async () => {
        const f = codexFixture();
        try {
          await f.started;
          await flush();
          f.notify("thread/goal/updated", { goal: { status: "active" } });
          const terminal = () =>
            f.notify(
              status === "cleared"
                ? "thread/goal/cleared"
                : "thread/goal/updated",
              { goal: { status } },
            );
          if (before) {
            terminal();
            await flush();
            assert.equal(f.settled, false);
          }
          f.notify("turn/completed", {
            turn: { id: "turn-1", status: "completed" },
          });
          if (!before) {
            await flush();
            assert.equal(f.settled, false);
            terminal();
          }
          assert.equal((await f.run).status, "completed");
          assert.equal(f.states.at(-1), status);
        } finally {
          f.rpc.close();
          await f.run.catch(() => {});
        }
      });
  }
});

test("unknown Codex Goal state and subagent completion never end the session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const f = codexFixture();
  try {
    await f.started;
    await flush();
    f.notify("thread/goal/updated", {
      goal: { status: "unrecognized-native-state" },
    });
    f.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    f.notify("thread/goal/updated", {
      threadId: "another-native-thread",
      goal: { status: "complete" },
    });
    t.mock.timers.tick(15000);
    await flush();
    assert.equal(f.settled, false);
    f.rpc.close();
    await assert.rejects(f.run, /connection closed/);
    assert.equal(f.states.includes("complete"), false);
  } finally {
    f.rpc.close();
    await f.run.catch(() => {});
  }
});

test("an explicit Stop can pause Codex between Goal turns", async () => {
  const f = codexFixture();
  try {
    await f.started;
    await flush();
    f.notify("thread/goal/updated", { goal: { status: "active" } });
    f.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    f.abort.abort();
    await f.run;
    assert.equal(f.states.at(-1), "paused");
    assert.equal(
      f.calls.some((c) => c.method === "turn/interrupt"),
      false,
    );
  } finally {
    f.rpc.close();
    await f.run.catch(() => {});
  }
});

test("resuming a saved session verifies Goal state before allowing its hold to clear", async (t) => {
  for (const saved of ["paused", null, new Error("Goal lookup unavailable")])
    await t.test(String(saved), async () => {
      const f = codexFixture(
        {
          mode: "default",
          session: { id: "native-goal", goal: { status: "unknown" } },
        },
        saved,
      );
      try {
        await f.started;
        await flush();
        f.notify("turn/completed", {
          turn: { id: "turn-1", status: "completed" },
        });
        assert.equal((await f.run).status, "completed");
        assert.equal(
          f.states.at(-1),
          saved instanceof Error ? "unknown" : (saved ?? "cleared"),
        );
        assert.equal(
          f.calls.some((c) => c.method === "thread/goal/set"),
          false,
        );
      } finally {
        f.rpc.close();
        await f.run.catch(() => {});
      }
    });
});

function claudeFixture() {
  const events = new AsyncQueue(),
    states = [],
    started = deferred();
  let closes = 0,
    settled = false;
  const abort = new AbortController();
  const run = runClaude(
    {
      project: { path: process.cwd() },
      mode: "goal",
      text: "Finish the goal",
      signal: abort.signal,
      emit() {},
      saveSession() {},
      goalState: (status) => states.push(status),
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
        interrupt: async () => {
          events.push({ type: "result" });
        },
        close() {
          closes++;
          events.end();
        },
        async *[Symbol.asyncIterator]() {
          await prompt.next();
          started.resolve();
          yield* events;
        },
      }),
    },
  );
  run.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return {
    events,
    states,
    abort,
    run,
    started: started.promise,
    get closes() {
      return closes;
    },
    get settled() {
      return settled;
    },
  };
}

test("Claude intermediate results keep an active Goal alive until confirmed met", async (t) => {
  for (const before of [false, true])
    await t.test(`clear before final result=${before}`, async () => {
      const f = claudeFixture();
      try {
        await f.started;
        f.events.push({
          type: "active_goal",
          value: { condition: "Finish", iterations: 1 },
        });
        f.events.push({ type: "result" });
        await flush();
        assert.equal(f.settled, false);
        assert.equal(f.closes, 0);
        if (before) {
          f.events.push({
            type: "assistant",
            message: { id: "turn-2", content: [] },
          });
          f.events.push({ type: "active_goal", value: null });
          await flush();
          assert.equal(f.settled, false);
          f.events.push({ type: "result" });
        } else f.events.push({ type: "active_goal", value: null });
        assert.equal((await f.run).status, "completed");
        assert.deepEqual(f.states, ["active", "complete"]);
        assert.equal(f.closes, 1);
      } finally {
        f.events.end();
        await f.run.catch(() => {});
      }
    });
});

test("Claude cannot finish an unconfirmed Goal from a result alone", async () => {
  const f = claudeFixture();
  try {
    await f.started;
    f.events.push({ type: "result" });
    await flush();
    assert.equal(f.settled, false);
    f.events.end();
    await assert.rejects(f.run, /without a final result/);
    assert.equal(f.states.includes("complete"), false);
  } finally {
    f.events.end();
    await f.run.catch(() => {});
  }
});

test("legacy Goal holds persist across mode/provider changes, archiving and reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-goal-state-"));
  let store = new Store(join(dir, "workspace.sqlite"));
  try {
    const chat = store.createConversation({
      projectId: store.addProject("Fixture", dir).id,
      mode: "goal",
    });
    // Simulate a database written by the previous version.
    store.db
      .prepare("UPDATE conversations SET sessions=? WHERE id=?")
      .run(JSON.stringify({ codex: { id: "legacy" } }), chat.id);
    const updatedAt = store.conversation(chat.id).updated_at;
    store.close();
    store = new Store(join(dir, "workspace.sqlite"));
    assert.equal(store.conversation(chat.id).updated_at, updatedAt);
    store.updateConversation(chat.id, { mode: "default", provider: "claude" });
    store.setArchived(chat.id, true);
    assert.equal(store.restartBlockingGoals()[0].status, "unknown");
    const controller = new Controller(store, {});
    assert.deepEqual(controller.cancel(chat.id), { requested: true });
    assert.equal(store.restartBlockingGoals().length, 0);
    assert.equal(store.conversation(chat.id).sessions.codex.id, "legacy");
    assert.deepEqual(controller.cancel(chat.id), { requested: false });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("permission continuations and stale callbacks cannot release a Goal hold", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  const chat = store.createConversation({
    projectId: store.addProject("Fixture", process.cwd()).id,
    mode: "goal",
  });
  controller.providers = [
    { id: "codex", models: [{ id: "fixture", efforts: [] }] },
  ];
  const turns = [],
    ready = [deferred(), deferred()],
    finish = [deferred(), deferred()];
  controller.runners.codex = async (ctx) => {
    const i = turns.push(ctx) - 1;
    ctx.saveSession({ id: "saved-goal" });
    ctx.goalState("active");
    ready[i].resolve();
    await finish[i].promise;
    return { status: "completed" };
  };
  try {
    controller.send(chat.id, {
      actionId: "goal-permission-continuation",
      text: "Finish the goal",
      provider: "codex",
      model: "fixture",
    });
    const task = controller.active.get(chat.id).task;
    await ready[0].promise;
    controller.setPermissions(chat.id, "override");
    turns[0].goalState("paused");
    assert.equal(store.restartBlockingGoals().length, 1);
    finish[0].resolve();
    await ready[1].promise;
    turns[0].goalState("complete");
    assert.equal(store.restartBlockingGoals().length, 1);
    controller.cancel(chat.id);
    assert.equal(store.restartBlockingGoals().length, 1);
    finish[1].resolve();
    await task;
    assert.equal(store.restartBlockingGoals().length, 0);
    turns[1].goalState("active");
    assert.equal(store.restartBlockingGoals().length, 0);
  } finally {
    finish.forEach((f) => f.resolve());
    await controller.close();
    store.close();
  }
});

test("a runner ending without confirming its Goal leaves a durable unknown hold", async (t) => {
  for (const failure of [false, true])
    await t.test(`provider failure=${failure}`, async () => {
      const store = new Store(":memory:"),
        controller = new Controller(store, {});
      const chat = store.createConversation({
        projectId: store.addProject("Fixture", process.cwd()).id,
        mode: "goal",
      });
      controller.providers = [
        { id: "codex", models: [{ id: "fixture", efforts: [] }] },
      ];
      let callback;
      controller.runners.codex = async (ctx) => {
        callback = ctx.goalState;
        ctx.saveSession({ id: "unknown-native-goal" });
        ctx.goalState("active");
        if (failure) throw new Error("Provider disconnected");
        return { status: "completed" };
      };
      try {
        controller.send(chat.id, {
          actionId: "goal-ended-unconfirmed-" + failure,
          text: "Finish the goal",
          provider: "codex",
          model: "fixture",
        });
        await controller.active.get(chat.id).task;
        assert.equal(controller.active.size, 0);
        assert.equal(store.activeRuns().length, 0);
        assert.equal(store.restartBlockingGoals()[0].status, "unknown");
        store.recover();
        callback("complete");
        assert.equal(store.restartBlockingGoals().length, 1);
        controller.cancel(chat.id);
        assert.equal(store.restartBlockingGoals().length, 0);
      } finally {
        await controller.close();
        store.close();
      }
    });
});

test("a stopped Goal pauses with its objective and resumes without retyping it", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  const chat = store.createConversation({
    projectId: store.addProject("Fixture", process.cwd()).id,
    mode: "goal",
  });
  controller.providers = [
    { id: "codex", models: [{ id: "fixture", efforts: [] }] },
  ];
  const turns = [],
    ready = [deferred(), deferred()];
  controller.runners.codex = async (ctx) => {
    const i = turns.push(ctx) - 1;
    ctx.saveSession({ id: "pausable-goal" });
    ctx.goalState("active");
    ready[i].resolve();
    await new Promise((resolve) =>
      ctx.signal.addEventListener("abort", resolve, { once: true }),
    );
    return { status: "cancelled" };
  };
  const goal = () => store.conversation(chat.id).sessions.codex.goal;
  try {
    assert.throws(
      () =>
        controller.send(chat.id, {
          actionId: "goal-resume-before-any-goal",
          provider: "codex",
          model: "fixture",
          resumeGoal: true,
        }),
      /no paused Goal/,
    );
    controller.send(chat.id, {
      actionId: "goal-to-pause-fixture",
      text: "Ship the release notes",
      provider: "codex",
      model: "fixture",
    });
    let task = controller.active.get(chat.id).task;
    await ready[0].promise;
    controller.cancel(chat.id);
    await task;
    assert.equal(goal().status, "paused");
    assert.equal(goal().objective, "Ship the release notes");
    assert.equal(store.restartBlockingGoals().length, 0);

    // The paused Goal survives a mode change and resumes in Goal mode.
    controller.setMode(chat.id, "default");
    controller.send(chat.id, {
      actionId: "goal-resume-fixture",
      provider: "codex",
      model: "fixture",
      resumeGoal: true,
    });
    task = controller.active.get(chat.id).task;
    await ready[1].promise;
    assert.equal(store.conversation(chat.id).mode, "goal");
    assert.equal(turns[1].mode, "goal");
    assert.equal(turns[1].resumeGoal, true);
    assert.equal(turns[1].continuing, false);
    assert.equal(turns[1].goalObjective, "Ship the release notes");
    assert.match(turns[1].text, /Resume the paused goal/);
    assert.equal(goal().objective, "Ship the release notes");
    assert.throws(
      () =>
        controller.send(chat.id, {
          actionId: "goal-resume-while-running",
          provider: "codex",
          model: "fixture",
          resumeGoal: true,
        }),
      /no paused Goal/,
    );
    controller.cancel(chat.id);
    await task;
    assert.equal(goal().status, "paused");
    assert.equal(goal().objective, "Ship the release notes");
  } finally {
    await controller.close();
    store.close();
  }
});

test("Codex resumes a paused native Goal without replacing its objective", async () => {
  const f = codexFixture(
    { continuing: false, resumeGoal: true, goalObjective: "Saved objective" },
    "paused",
  );
  try {
    await f.started;
    const set = f.calls.find((c) => c.method === "thread/goal/set");
    assert.equal(set.params.status, "active");
    assert.equal(Object.hasOwn(set.params, "objective"), false);
  } finally {
    f.abort.abort();
    f.rpc.close();
    await f.run.catch(() => {});
  }
});

test("Codex sets a resumed Goal again when its native copy is gone", async () => {
  const f = codexFixture(
    { continuing: false, resumeGoal: true, goalObjective: "Saved objective" },
    null,
  );
  try {
    await f.started;
    const set = f.calls.find((c) => c.method === "thread/goal/set");
    assert.equal(set.params.objective, "Saved objective");
  } finally {
    f.abort.abort();
    f.rpc.close();
    await f.run.catch(() => {});
  }
});

test("Claude resumes a paused Goal by setting its saved objective again", async () => {
  assert.equal(
    await claudeContent({
      mode: "goal",
      resumeGoal: true,
      continuing: false,
      goalObjective: "Saved objective",
      text: "Resume the paused goal.",
    }),
    "/goal Saved objective",
  );
});
