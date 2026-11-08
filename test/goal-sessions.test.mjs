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
import { runCodex, pauseCodexGoal } from "../src/providers/codex.mjs";
import { runClaude, pauseClaudeGoal } from "../src/providers/claude.mjs";
import { claudeContent, claudeGoalContext } from "../src/providers/attachments.mjs";
import { GOAL_INSTRUCTIONS } from "../src/core/modes.mjs";
import { WATCH_INSTRUCTIONS } from "../src/core/watch-tools.mjs";
import { goalPlanTracker } from "../src/core/goal-progress.mjs";

const deferred = () => Promise.withResolvers();
const flush = async () => {
  await nextTick();
  await nextTick();
};

test("Codex forwards only its root plan across native Goal turns", async () => {
  const reports = [], track = goalPlanTracker("codex");
  const f = codexFixture({ emit: (type, payload) => {
    if (type === "work") { const report = track(payload); if (report) reports.push(report); }
  } });
  try {
    await f.started;
    const plan = [{ step: "Finish the whole Goal", status: "inProgress" }];
    f.notify("turn/plan/updated", { threadId: "child", plan });
    f.notify("turn/plan/updated", { plan, explanation: "Starting implementation" });
    f.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    f.notify("turn/started", { turn: { id: "turn-2" } });
    f.notify("turn/plan/updated", { plan: [{ ...plan[0], status: "completed" }] });
    f.notify("turn/completed", { turn: { id: "turn-2", status: "completed" } });
    f.notify("thread/goal/updated", { goal: { status: "complete" } });
    await f.run;
    assert.equal(reports.length, 2);
    assert.equal(reports[0].phases[0].status, "in_progress");
    assert.equal(reports[1].phases[0].status, "completed");
  } finally { f.rpc.close(); await f.run.catch(() => {}); }
});

test("Claude forwards successful root todos and ignores child and failed updates", async () => {
  const reports = [], track = goalPlanTracker("claude");
  const f = claudeFixture({ emit: (type, payload) => {
    if (type === "work") { const report = track(payload); if (report) reports.push(report); }
  } });
  try {
    await f.started;
    for (const [id, marker, isError] of [
      ["child-agent", { agent_id: "child" }, false],
      ["child-tool", { parent_tool_use_id: "child" }, false],
      ["failed", {}, true],
      ["root", {}, false],
    ]) {
      f.events.push({ type: "assistant", ...marker, message: {
        id, content: [{ type: "tool_use", id, name: "TodoWrite", input: { todos: [{ content: "Verify the whole Goal", status: "in_progress", activeForm: "Verifying" }] } }],
      } });
      // SDK events need not include tool_use_result. The correlated result is sufficient.
      f.events.push({ type: "user", ...marker, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "Updated" }] } });
    }
    f.events.push({ type: "active_goal", value: null });
    f.events.push({ type: "result" });
    await f.run;
    assert.deepEqual(reports, [{ phases: [{ label: "Verify the whole Goal", status: "in_progress" }], explanation: "" }]);
  } finally { f.events.end(); await f.run.catch(() => {}); }
});

test("a user Codex pause interrupts promptly and waits beyond the old kill deadline for both acknowledgments", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let acknowledged = false;
  const f = codexFixture({ pauseConfirmed: () => { acknowledged = true; } });
  const pause = deferred();
  await f.started;
  await flush();
  const call = f.rpc.call;
  f.rpc.call = (method, params) => method === "thread/goal/set" && params.status === "paused" ? pause.promise : call(method, params);
  try {
    f.abort.abort({ kind: "user-pause" });
    await flush();
    assert.ok(f.calls.some((c) => c.method === "turn/interrupt"));
    t.mock.timers.tick(9000);
    assert.equal(f.closes, 0);
    f.notify("turn/completed", { turn: { id: "turn-1", status: "interrupted" } });
    await flush();
    assert.equal(f.settled, false);
    assert.equal(acknowledged, false);
    pause.resolve({ goal: { status: "paused" } });
    assert.equal((await f.run).status, "cancelled");
    assert.equal(acknowledged, true);
    assert.equal(f.calls.find((c) => c.method === "thread/resume").params.excludeTurns, true);
    assert.equal(f.calls.find((c) => c.method === "thread/resume").timeoutMs, 180000);
  } finally { f.rpc.close(); await f.run.catch(() => {}); }
});

test("Claude's empty cancellation result is never retried or followed by context sampling", async () => {
  let acknowledged = false;
  const f = claudeFixture({ pauseConfirmed: () => { acknowledged = true; } },
    { type: "result", duration_api_ms: 0, queued_turn_count: 2 });
  await f.started;
  f.abort.abort({ kind: "user-pause" });
  assert.equal((await f.run).status, "cancelled");
  assert.equal(acknowledged, true);
  assert.equal(f.closes, 1);
});

test("a user pause arriving before turn/start returns still interrupts that turn and waits for its end", async () => {
  let acknowledged = false;
  const f = codexFixture({ session: undefined, startGoal: true, continuing: false, pauseConfirmed: () => { acknowledged = true; } });
  const start = deferred(), requested = deferred();
  const call = f.rpc.call;
  f.rpc.call = (method, params) => {
    if (method === "turn/start") { requested.resolve(); return start.promise; }
    return call(method, params);
  };
  try {
    await requested.promise;
    f.abort.abort({ kind: "user-pause" });
    await flush();
    assert.equal(f.settled, false);
    start.resolve({ turn: { id: "late-start" } });
    await flush();
    assert.ok(f.calls.some((c) => c.method === "turn/interrupt" && c.params.turnId === "late-start"));
    assert.equal(acknowledged, false);
    f.notify("turn/completed", { turn: { id: "late-start", status: "interrupted" } });
    assert.equal((await f.run).status, "cancelled");
    assert.equal(acknowledged, true);
  } finally { f.rpc.close(); await f.run.catch(() => {}); }
});

test("Claude acknowledges a pause between Goal turns without waiting for a nonexistent result", async () => {
  let acknowledged = false;
  const f = claudeFixture({ pauseConfirmed: () => { acknowledged = true; } }, null);
  await f.started;
  f.events.push({ type: "active_goal", value: { condition: "Ship it", iterations: 1 } });
  f.events.push({ type: "result", result: "Checkpoint", duration_api_ms: 10 });
  await flush();
  assert.equal(f.settled, false);
  f.abort.abort({ kind: "user-pause" });
  assert.equal((await f.run).status, "cancelled");
  assert.equal(acknowledged, true);
  assert.equal(f.closes, 1);
});

test("rechecking a disconnected Goal waits for native confirmation and rejects new work meanwhile", async () => {
  const store = new Store(":memory:"), controller = new Controller(store, {});
  const chat = store.createConversation({ projectId: store.addProject("Fixture", process.cwd()).id, mode: "goal" });
  const run = store.createRun({ conversationId: chat.id, actionId: "disconnected-goal-fixture", provider: "codex", model: "m", text: "Ship it" });
  store.setRun(run.id, "failed");
  store.setGoalState(chat.id, "codex", run.id, "unknown", "Ship it");
  store.updateConversation(chat.id, { sessions: { codex: { ...store.conversation(chat.id).sessions.codex, id: "native" } } });
  const confirmation = deferred();
  let checks = 0;
  controller.pauseRunners.codex = async () => { checks++; return confirmation.promise; };
  try {
    controller.cancel(chat.id);
    controller.cancel(chat.id);
    await flush();
    assert.equal(checks, 1);
    assert.equal(store.conversationSnapshot(chat.id).pause.state, "requested");
    assert.equal(store.restartBlockingGoals().length, 1);
    assert.throws(() => controller.prepareSend(chat.id, { actionId: "new-work-during-pause", provider: "codex", model: "m", text: "More work" }), /confirm the Goal pause/);
    confirmation.resolve("paused");
    await controller.pauseChecks.get(chat.id).task;
    assert.equal(store.restartBlockingGoals().length, 0);
    assert.equal(store.conversationSnapshot(chat.id).pause.state, "confirmed");
  } finally { confirmation.resolve("paused"); await controller.close(); store.close(); }
});

test("Codex saved-Goal pause checks never submit a turn and wait for an interrupted native turn", async () => {
  const rpc = new EventEmitter(), interrupted = deferred();
  const calls = [];
  rpc.close = () => {};
  rpc.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume") return { thread: { id: "native" } };
    if (method === "thread/goal/set") return { goal: { status: "paused" } };
    if (method === "thread/turns/list") return { data: [{ id: "turn", status: "inProgress" }] };
    if (method === "turn/interrupt") { interrupted.resolve(); return {}; }
    assert.fail(method);
  };
  let settled = false;
  const pause = pauseCodexGoal(process.cwd(), { id: "native" }, {}, { open: async () => rpc });
  pause.then(() => { settled = true; });
  await interrupted.promise;
  await flush();
  assert.equal(settled, false);
  rpc.emit("notification", { method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: "interrupted" } } });
  assert.equal(await pause, "paused");
  assert.ok(calls.every((c) => !["turn/start", "thread/start"].includes(c.method)));
});

test("Claude saved-Goal pause checks use control requests without enqueuing a prompt", async () => {
  let input, closed = false;
  assert.equal(await pauseClaudeGoal(process.cwd(), { id: "native" }, {}, {
    baseOptions: () => ({}), queryFn: ({ prompt, options }) => {
      input = prompt;
      assert.equal(options.resume, "native");
      return { interrupt: async () => {}, close: () => { closed = true; } };
    },
  }), "paused");
  assert.equal(closed, true);
  assert.equal((await input.next()).done, true);
});

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
  rpc.call = async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
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

test("fresh and resumed Codex Goals deliver background limits in the native developer instructions", async () => {
  for (const resumed of [false, true]) {
    const f = codexFixture(
      {
        continuing: false,
        resumeGoal: resumed,
        session: resumed ? { id: "native-goal" } : undefined,
        goalObjective: "Inspect study results",
        instructions: `${WATCH_INSTRUCTIONS}\n\n${GOAL_INSTRUCTIONS}`,
      },
      resumed ? "paused" : null,
    );
    try {
      await f.started;
      const start = f.calls.find(
        (call) => call.method === (resumed ? "thread/resume" : "thread/start"),
      );
      assert.ok(start.params.developerInstructions.includes(WATCH_INSTRUCTIONS));
      assert.ok(start.params.developerInstructions.includes(GOAL_INSTRUCTIONS));
    } finally {
      f.abort.abort();
      f.rpc.close();
      await f.run.catch(() => {});
    }
  }
});

test("Codex confirms watcher suspension only after the native Goal pauses and the turn ends", async () => {
  for (const pauseWorks of [true, false]) {
    let confirmed = false;
    const f = codexFixture({ watchParked: () => { confirmed = true; } });
    await f.started;
    if (!pauseWorks) {
      const call = f.rpc.call;
      f.rpc.call = async (method, params) => {
        if (method === "thread/goal/set" && params.status === "paused") throw new Error("Pause failed");
        return call(method, params);
      };
    }
    f.abort.abort({ kind: "watch-yield" });
    await flush();
    assert.equal(confirmed, false);
    f.notify("turn/completed", { turn: { id: "turn-1", status: "cancelled" } });
    await f.run;
    assert.equal(confirmed, pauseWorks);
    assert.equal(f.closes, 1);
  }
});

test("Codex confirms an owner pause only after the native Goal pauses and the turn ends", async () => {
  for (const pauseWorks of [true, false]) {
    let confirmed = false;
    const f = codexFixture({ ownerParked: () => { confirmed = true; } });
    await f.started;
    if (!pauseWorks) {
      const call = f.rpc.call;
      f.rpc.call = async (method, params) => {
        if (method === "thread/goal/set" && params.status === "paused") throw new Error("Pause failed");
        return call(method, params);
      };
    }
    f.abort.abort({ kind: "owner-pause" });
    await flush();
    assert.equal(confirmed, false);
    f.notify("turn/completed", { turn: { id: "turn-1", status: "cancelled" } });
    await f.run;
    assert.equal(confirmed, pauseWorks);
    assert.equal(f.closes, 1);
  }
});

for (const kind of ["owner-pause", "watch-yield"])
  test(`Codex still confirms a ${kind} when the turn ends before the native pause reply`, async () => {
    let confirmed = false;
    const f = codexFixture(
      kind === "owner-pause"
        ? { ownerParked: () => { confirmed = true; } }
        : { watchParked: () => { confirmed = true; } },
    );
    await f.started;
    const reply = deferred(),
      call = f.rpc.call;
    f.rpc.call = async (method, params, timeoutMs) => {
      if (method === "thread/goal/set" && params.status === "paused") {
        await reply.promise;
        return call(method, params, timeoutMs);
      }
      return call(method, params, timeoutMs);
    };
    f.abort.abort({ kind });
    await flush();
    f.notify("turn/completed", { turn: { id: "turn-1", status: "interrupted" } });
    await flush();
    assert.equal(confirmed, false);
    reply.resolve();
    await f.run;
    assert.equal(confirmed, true);
  });

test("a quota read cut off by a park is not a billing stop", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const work = [];
  let confirmed = false;
  const f = codexFixture({
    emit: (type, payload) => { if (type === "work") work.push(payload); },
    ownerParked: () => { confirmed = true; },
  });
  await f.started;
  const read = deferred(),
    call = f.rpc.call;
  f.rpc.call = async (method, params, timeoutMs) =>
    method === "account/rateLimits/read" ? read.promise : call(method, params, timeoutMs);
  t.mock.timers.tick(20000);
  await flush();
  f.abort.abort({ kind: "owner-pause" });
  await flush();
  f.notify("turn/completed", { turn: { id: "turn-1", status: "interrupted" } });
  read.reject(new Error("Codex connection closed"));
  await f.run;
  await flush();
  assert.equal(confirmed, true);
  assert.equal(work.some((item) => item.kind === "billing-stop"), false);
});

test("Codex receives a host tool's error text instead of a generic failure", async () => {
  const f = codexFixture({
    history: async () => {
      throw new Error("Yield only to watchers from the current user request.");
    },
  });
  await f.started;
  const responses = [];
  f.rpc.respond = (id, result) => responses.push({ id, result });
  f.rpc.reject = (id, message) => responses.push({ id, rejected: message });
  f.rpc.emit("request", {
    id: "tool-1",
    method: "item/tool/call",
    params: { tool: "yield_to_watch", arguments: {} },
  });
  await flush();
  assert.equal(responses.length, 1);
  assert.equal(responses[0].result.success, false);
  assert.match(responses[0].result.contentItems[0].text, /current user request/);
  f.rpc.close();
  await f.run.catch(() => {});
});

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

function claudeFixture(extra = {}, interruptResult = { type: "result" }, interruptAck) {
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
      ...extra,
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
          await interruptAck;
          if (interruptResult) events.push(interruptResult);
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

test("Claude acknowledges watcher suspension on an interrupted result and closes the native query", async () => {
  let confirmed = false;
  const f = claudeFixture({ watchParked: () => { confirmed = true; } });
  await f.started;
  f.events.push({ type: "active_goal", value: { condition: "Ship passing CI", iterations: 1 } });
  f.abort.abort({ kind: "watch-yield" });
  assert.equal((await f.run).status, "cancelled");
  assert.equal(confirmed, true);
  assert.equal(f.closes, 1);
});

for (const kind of ["watch-yield", "owner-pause"])
  test(`Claude confirms ${kind} after an acknowledged interrupt without a final result`, async () => {
    const confirmed = [], ack = deferred();
    const f = claudeFixture({
      watchParked: () => confirmed.push("watch-yield"),
      ownerParked: () => confirmed.push("owner-pause"),
    }, null, ack.promise);
    try {
      await f.started;
      f.abort.abort({ kind });
      await flush();
      assert.equal(f.settled, false);
      assert.equal(f.closes, 0);
      assert.deepEqual(confirmed, []);
      ack.resolve();
      await flush();
      assert.equal(f.closes, 1);
      assert.equal((await f.run).status, "cancelled");
      assert.deepEqual(confirmed, [kind]);
    } finally {
      ack.resolve();
      f.events.end();
      await f.run.catch(() => {});
    }
  });

test("Claude never confirms a watcher yield when the interrupt fails", async () => {
  let confirmed = false;
  const ack = deferred();
  const f = claudeFixture({ watchParked: () => { confirmed = true; } }, null, ack.promise);
  await f.started;
  f.abort.abort({ kind: "watch-yield" });
  ack.reject(new Error("Interrupt disconnected"));
  await assert.rejects(f.run, /without a final result|Interrupt disconnected/);
  assert.equal(confirmed, false);
  assert.equal(f.closes, 1);
});

test("Claude never confirms a watcher yield when the interrupt times out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let confirmed = false;
  const ack = deferred();
  const f = claudeFixture({ watchParked: () => { confirmed = true; } }, null, ack.promise);
  try {
    await f.started;
    f.abort.abort({ kind: "watch-yield" });
    t.mock.timers.tick(8000);
    await assert.rejects(f.run, /without a final result/);
    // Even a late acknowledgement cannot park an already-ended run.
    ack.resolve();
    await flush();
    assert.equal(confirmed, false);
    assert.equal(f.closes, 1);
  } finally {
    ack.resolve();
    f.events.end();
    await f.run.catch(() => {});
  }
});

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
        assert.equal(f.states.at(-1), "complete");
        assert.ok(f.states.includes("active"));
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
    controller.pauseRunners.codex = async () => "paused";
    assert.deepEqual(controller.cancel(chat.id), { requested: true });
    await controller.pauseChecks.get(chat.id).task;
    assert.equal(store.restartBlockingGoals().length, 0);
    assert.equal(store.conversation(chat.id).sessions.codex.id, "legacy");
    assert.deepEqual(controller.cancel(chat.id), { requested: false });
    await controller.close();
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
    turns[0].pauseConfirmed();
    assert.equal(store.restartBlockingGoals().length, 1);
    turns[1].pauseConfirmed();
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
        controller.pauseRunners.codex = async () => "paused";
        controller.cancel(chat.id);
        await controller.pauseChecks.get(chat.id).task;
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
    ctx.pauseConfirmed();
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

test("Claude resumes a paused Goal with feedback and the saved objective separately", async () => {
  assert.match(
    await claudeContent({
      mode: "goal",
      resumeGoal: true,
      continuing: false,
      goalObjective: "Saved objective",
      text: "Resume the paused goal.",
    }),
    /Latest message for this Goal:\nResume the paused goal\./,
  );
  assert.match(claudeGoalContext({mode: "goal", goalObjective: "Saved objective", text: "Resume the paused goal."}), /Full Harness Goal \(binding objective\):\nSaved objective/);
});

test("Codex carries long Goals intact outside its bounded native field", async () => {
  const objective = 'Full requirement. '.repeat(600);
  const states = [];
  const f = codexFixture({continuing: false, session: undefined, goalObjective: objective, handoff: 'Earlier progress', goalState: (status, text) => states.push(text)});
  try {
    await f.started;
    const native = f.calls.find(c => c.method === 'thread/goal/set').params.objective;
    assert.ok(native.length <= 4000);
    const start = f.calls.find(c => c.method === 'thread/start');
    assert.ok(start.params.developerInstructions.includes(objective));
    assert.ok(start.params.developerInstructions.includes('Earlier progress'));
    f.notify('thread/goal/updated', {goal: {status: 'active', objective: native}});
    assert.ok(states.includes(objective));
  } finally {
    f.abort.abort(); f.rpc.close(); await f.run.catch(() => {});
  }
});

test("Codex replaces only a thread with a confirmed missing rollout", async () => {
  let handoff = false;
  const f = codexFixture({resumeGoal: true, goalObjective: 'Original goal', ensureHandoff: () => {handoff = true;}});
  const call = f.rpc.call;
  f.rpc.call = async (method, params) => {
    if (method === 'thread/resume') throw new Error('no rollout found for thread id native-goal');
    return call(method, params);
  };
  try {
    await f.started;
    assert.ok(handoff);
    assert.ok(f.calls.some(c => c.method === 'thread/start'));
    assert.equal(f.calls.find(c => c.method === 'thread/goal/set').params.objective, 'Original goal');
  } finally {
    f.abort.abort(); f.rpc.close(); await f.run.catch(() => {});
  }
});
