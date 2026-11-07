import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { AsyncQueue } from "../src/core/queue.mjs";
import { runClaude } from "../src/providers/claude.mjs";

const phases = [{ label: "Verify the full objective", status: "in_progress" }];
const auth = async () => ({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" });
const usage = async () => ({ rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: false, user_disabled: true }, limits: [{ kind: "five_hour", percent: 1 }] } });
const options = { baseOptions: () => ({}), readAuth: auth, readUsage: usage };

function fixture(t, provider = "claude") {
  const store = new Store(":memory:"), controller = new Controller(store, {});
  controller.providers = ["claude", "codex"].map((id) => ({ id, models: [{ id: "fixture", efforts: [] }] }));
  const chat = store.createConversation({ projectId: store.addProject("Runtime", process.cwd(), { scratch: true }).id, mode: "goal", provider });
  const send = (text, extra = {}) => controller.send(chat.id, { actionId: crypto.randomUUID(), provider, model: "fixture", text, ...extra });
  t.after(async () => { await controller.close(); store.close(); });
  return { store, controller, chat, send };
}

for (const provider of ["claude", "codex"]) {
  test(`${provider}: follow-ups preserve objective and phases; explicit replacement resets both`, async (t) => {
    const f = fixture(t, provider), seen = [];
    f.controller.runners[provider] = async (ctx) => {
      seen.push(ctx);
      ctx.saveSession({ id: "saved" });
      if (seen.length === 1) await ctx.history("update_goal_progress", { phases });
      ctx.goalState("active", "A native short condition must not replace the full objective");
      ctx.goalState("paused");
      return { status: "completed" };
    };
    f.send("Ship and verify the entire release");
    await f.controller.active.get(f.chat.id).task;
    const first = f.store.conversation(f.chat.id).goalProgress;
    f.send("How will I know when it is done?");
    await f.controller.active.get(f.chat.id).task;
    const followup = f.store.conversation(f.chat.id);
    assert.equal(followup.goalProgress.goalId, first.goalId);
    assert.equal(followup.goalProgress.objective, "Ship and verify the entire release");
    assert.equal(followup.sessions[provider].goal.objective, first.objective);
    assert.deepEqual(followup.goalProgress.phases, phases);
    assert.equal(seen[1].resumeGoal, true);
    assert.equal(seen[1].text, "How will I know when it is done?");
    f.send("/goal Ship a different release");
    await f.controller.active.get(f.chat.id).task;
    assert.notEqual(f.store.conversation(f.chat.id).goalProgress.goalId, first.goalId);
    assert.equal(f.store.conversation(f.chat.id).goalProgress.objective, "Ship a different release");
    assert.deepEqual(f.store.conversation(f.chat.id).goalProgress.phases, []);
    assert.ok((await seen[0].history("update_goal_progress", { phases })).error);
  });
}

test("queued explicit Goal replacements survive persistence and release", async (t) => {
  const f = fixture(t), gate = Promise.withResolvers(), started = Promise.withResolvers(), seen = [];
  f.controller.runners.claude = async (ctx) => {
    seen.push(ctx);
    if (seen.length === 1) { started.resolve(); await gate.promise; }
    ctx.goalState("paused");
    return { status: "completed" };
  };
  f.send("First full objective");
  const firstTask = f.controller.active.get(f.chat.id).task;
  await started.promise;
  const row = f.send("/goal Replacement objective");
  assert.equal(row.goal_replacement, 1);
  gate.resolve();
  await firstTask;
  await f.controller.active.get(f.chat.id)?.task;
  assert.equal(seen[1].goalObjective, "Replacement objective");
  assert.equal(f.store.conversation(f.chat.id).goalProgress.objective, "Replacement objective");
});

test("Claude's real MCP progress and completion tools work without TodoWrite or native Goal events", async (t) => {
  const f = fixture(t), prompts = [];
  f.controller.runners.claude = (ctx) => runClaude(ctx, { ...options, queryFn: ({ prompt, options: sdk }) => ({
    interrupt: async () => {}, close() {},
    async *[Symbol.asyncIterator]() {
      prompts.push((await prompt.next()).value.message.content);
      assert.match(sdk.systemPrompt.append, /Full Harness Goal \(binding objective\):\nVerify the release/);
      assert.match(sdk.systemPrompt.append, /complete_goal/);
      const hook = sdk.hooks.PreToolUse.at(-1).hooks[0];
      assert.equal((await hook({ agent_id: "child" })).hookSpecificOutput.permissionDecision, "deny");
      const client = new Client({ name: "goal-test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const server = sdk.mcpServers.harness.instance;
      try {
        await server.connect(b); await client.connect(a);
        const tools = (await client.listTools()).tools;
        assert.ok(tools.some((x) => x.name === "update_goal_progress"));
        assert.ok(tools.some((x) => x.name === "complete_goal"));
        const result = await client.callTool({ name: "update_goal_progress", arguments: { phases } });
        assert.equal(result.isError, false);
        assert.deepEqual(f.store.conversation(f.chat.id).goalProgress.phases, phases);
        yield { type: "assistant", message: { id: "checkpoint", content: [{ type: "text", text: "Discovery is done; verification remains." }] } };
        yield { type: "result", is_error: false, result: "Checkpoint" };
        prompts.push((await prompt.next()).value.message.content);
        assert.match(prompts[1], /Continue the full Harness Goal/);
        const complete = await client.callTool({ name: "complete_goal", arguments: { evidence: "Verified the full release using the acceptance fixture." } });
        assert.equal(JSON.parse(complete.content[0].text).complete, true);
        yield { type: "assistant", message: { id: "final", content: [{ type: "text", text: "Release verified." }] } };
        yield { type: "result", is_error: false, result: "Release verified." };
      } finally { await client.close(); await server.close(); }
    },
  }) });
  const run = f.send("Verify the release");
  await f.controller.active.get(f.chat.id).task;
  assert.equal(f.store.run(run.id).status, "completed");
  assert.equal(prompts.length, 2);
  assert.equal(f.store.conversation(f.chat.id).goalProgress.status, "complete");
  assert.ok(f.store.conversation(f.chat.id).goalProgress.phases.every((p) => p.status === "completed"));
});

test("Goal reporting rejects non-Goal modes, malformed reports, and missing completion evidence", async (t) => {
  const f = fixture(t);
  f.controller.runners.claude = async (ctx) => {
    assert.ok((await ctx.history("update_goal_progress", { phases: [] })).error);
    assert.ok((await ctx.history("complete_goal", { evidence: " " })).error);
    assert.equal(f.store.conversation(f.chat.id).goalProgress.status, "starting");
    ctx.goalState("paused");
    return { status: "completed" };
  };
  f.send("Verify release"); await f.controller.active.get(f.chat.id).task;
  f.controller.runners.claude = async (ctx) => {
    assert.ok((await ctx.history("update_goal_progress", { phases })).error);
    assert.ok((await ctx.history("complete_goal", { evidence: "Verified" })).error);
    return { status: "completed" };
  };
  f.send("A regular question", { mode: "default" }); await f.controller.active.get(f.chat.id).task;
});

test("telemetry-only silence after a result gets one recovery and then a bounded failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = new AsyncQueue(), inputReady = Promise.withResolvers(), work = [], prompts = [];
  let input;
  const run = runClaude({ project: { path: process.cwd() }, mode: "goal", text: "Verify release", signal: new AbortController().signal, saveSession() {}, emit: (type, p) => work.push({ type, p }) }, {
    ...options, goalIdleTimeoutMs: 1000, queryFn: ({ prompt }) => {
      input = prompt;
      return { interrupt: async () => {}, close: () => events.end(), async *[Symbol.asyncIterator]() {
        prompts.push((await prompt.next()).value); inputReady.resolve(); yield* events;
      } };
    },
  });
  const failure = assert.rejects(run, /did not continue or confirm its Goal/);
  await inputReady.promise;
  events.push({ type: "result", result: "Checkpoint", is_error: false });
  await tick(); await tick();
  prompts.push((await input.next()).value);
  events.push({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  await tick();
  t.mock.timers.tick(1001); await tick();
  prompts.push((await input.next()).value);
  assert.equal(work.filter((x) => x.p.kind === "goal-recovery").length, 1);
  t.mock.timers.tick(1001); await failure;
  assert.equal(prompts.length, 3);
});

test("a root tool starting after a result cancels the idle deadline until that turn ends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = new AsyncQueue(), started = Promise.withResolvers(), abort = new AbortController();
  let closes = 0, recoveries = 0;
  const run = runClaude({ project: { path: process.cwd() }, mode: "goal", text: "Verify release", signal: abort.signal, saveSession() {},
    emit: (type, work) => { if (work.kind === "goal-recovery") recoveries++; } }, {
    ...options, goalIdleTimeoutMs: 1000, queryFn: ({ prompt }) => ({
      interrupt: async () => { events.push({ type: "result" }); },
      close: () => { closes++; events.end(); },
      async *[Symbol.asyncIterator]() { await prompt.next(); started.resolve(); yield* events; },
    }),
  });
  await started.promise;
  events.push({ type: "result", is_error: false, result: "Checkpoint" });
  await tick(); await tick();
  events.push({ type: "assistant", message: { id: "long-command", content: [{ type: "tool_use", id: "command", name: "Bash", input: { command: "long running verification" } }] } });
  await tick();
  t.mock.timers.tick(10000); await tick();
  assert.equal(closes, 0);
  assert.equal(recoveries, 0);
  abort.abort({ kind: "user-pause" });
  assert.equal((await run).status, "cancelled");
});

test("Claude yields at a completed result for newer queued user input", async () => {
  const run = runClaude({ project: { path: process.cwd() }, mode: "goal", text: "Verify release", shouldYieldForInput: () => true, signal: new AbortController().signal, saveSession() {}, emit() {} }, {
    ...options, queryFn: ({ prompt }) => ({ interrupt: async () => {}, close() {}, async *[Symbol.asyncIterator]() {
      await prompt.next(); yield { type: "result", result: "Checkpoint", is_error: false };
      assert.fail("Queued user input must be handled before any automatic continuation");
    } }),
  });
  assert.equal((await run).status, "completed");
});
