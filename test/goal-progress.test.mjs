import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { GOAL_PROGRESS_INSTRUCTIONS, goalPlanTracker } from "../src/core/goal-progress.mjs";
import { hostToolsKey } from "../src/core/host-tools.mjs";

const plan = [
  { step: "Inspect the parser", status: "completed" },
  { step: "Implement the fix", status: "inProgress" },
  { step: "Verify and deliver", status: "pending" },
];
const normalized = plan.map(({ step, status }) => ({ label: step, status: status === "inProgress" ? "in_progress" : status }));
const report = { phases: normalized, explanation: "Parser investigation is complete." };
const codexPlan = () => ({ kind: "plan", plan, explanation: report.explanation });
const todo = (id = "todo-1") => ({
  kind: "tool", provider: "claude",
  item: { id, name: "TodoWrite", input: { todos: normalized.map(({ label, status }) => ({ content: label, status, activeForm: label })) } },
});
const result = (id = "todo-1", isError = false) => ({ kind: "tool-result", provider: "claude", toolUseId: id, isError });

test("native plans normalize aliases, reject malformed data and ignore child updates", () => {
  const track = goalPlanTracker("codex");
  assert.deepEqual(track(codexPlan()), report);
  assert.equal(track({ ...codexPlan(), parentId: "child" }), null);
  assert.equal(track({ ...codexPlan(), agentId: "child" }), null);
  assert.equal(track({ ...codexPlan(), kind: "native-subagent" }), null);
  for (const items of [[], null, [{ step: "", status: "pending" }], [{ step: "Wrong", status: "failed" }]])
    assert.equal(track({ kind: "plan", plan: items }), null);
  assert.equal(goalPlanTracker("cursor")(codexPlan()), null);
});

test("Claude todos become phases only on a successful root tool result", () => {
  const track = goalPlanTracker("claude");
  assert.equal(track(todo()), null);
  assert.equal(track(result("unrelated")), null);
  assert.equal(track(result("todo-1", true)), null);
  assert.equal(track(result()), null);
  for (const marker of [{ parentId: "child" }, { agentId: "child" }]) {
    track({ ...todo(), ...marker });
    assert.equal(track(result()), null);
  }
  track(todo());
  assert.equal(track({ ...result(), agentId: "child" }), null);
  assert.deepEqual(track(result()), { phases: normalized, explanation: "" });
  assert.equal(track(result()), null);
  track(todo("older"));
  track(todo("newer"));
  assert.ok(track(result("newer")));
  assert.equal(track(result("older")), null);
});

test("progress persists independently of sessions, guards ownership, and resets by Goal identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-goal-progress-")), path = join(dir, "workspace.sqlite");
  let store = new Store(path);
  try {
    const project = store.addProject("Progress", dir);
    const chat = store.createConversation({ projectId: project.id, mode: "goal" });
    assert.equal(chat.goalProgress, null);
    store.beginGoalProgress(chat.id, "codex", "run-1", true);
    store.setGoalState(chat.id, "codex", "run-1", "active", "Fix the parser");
    store.updateGoalProgress(chat.id, "codex", "run-1", report);
    assert.equal(store.updateGoalProgress(chat.id, "codex", "run-1", report), null);
    for (const status of ["paused", "waiting", "owner", "blocked", "usageLimited", "budgetLimited", "unknown"]) {
      store.setGoalState(chat.id, "codex", "run-1", status);
      assert.deepEqual(store.conversationSnapshot(chat.id).goalProgress.phases, normalized);
      assert.equal(store.conversation(chat.id).goalProgress.status, status);
    }
    const saved = store.conversation(chat.id).goalProgress;
    store.close();
    store = new Store(path);
    assert.deepEqual(store.conversation(chat.id).goalProgress, saved);
    const destination = store.addProject("Destination", join(dir, "destination"));
    store.moveConversation(chat.id, destination.id);
    assert.deepEqual(store.conversation(chat.id).goalProgress, saved);
    store.beginGoalProgress(chat.id, "claude", "run-2");
    assert.equal(store.conversation(chat.id).goalProgress.goalId, "run-1");
    assert.equal(store.updateGoalProgress(chat.id, "codex", "run-1", { phases: [], explanation: "stale" }), null);
    store.setGoalState(chat.id, "codex", "run-1", "complete");
    assert.equal(store.conversation(chat.id).goalProgress.status, "starting");
    store.setGoalState(chat.id, "claude", "run-2", "complete", "Fix the parser");
    const completed = store.conversation(chat.id).goalProgress;
    assert.ok(completed.phases.every((phase) => phase.status === "completed"));
    assert.equal(store.updateGoalProgress(chat.id, "claude", "run-2", report), null);
    store.beginGoalProgress(chat.id, "claude", "run-3", true);
    store.setGoalState(chat.id, "claude", "run-3", "active", "Fix the parser");
    assert.equal(store.conversation(chat.id).goalProgress.goalId, "run-3");
    assert.deepEqual(store.conversation(chat.id).goalProgress.phases, []);
    store.updateConversation(chat.id, { mode: "default" });
    assert.equal(store.updateGoalProgress(chat.id, "claude", "run-3", report), null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function fixture(t, provider = "codex", mode = "goal") {
  const store = new Store(":memory:"), controller = new Controller(store, {}), seen = [], events = [];
  controller.providers = ["codex", "claude"].map((id) => ({ id, models: [{ id: "fixture", efforts: [] }] }));
  const chat = store.createConversation({ projectId: store.addProject("Progress", process.cwd(), { scratch: true }).id, mode, provider });
  controller.on("event", (event) => events.push(event));
  t.after(async () => { await controller.close(); store.close(); });
  const send = async (extra = {}) => {
    const run = controller.send(chat.id, { actionId: crypto.randomUUID(), text: "Fix the parser", provider, model: "fixture", ...extra });
    await controller.active.get(chat.id).task;
    return run;
  };
  return { store, controller, chat, seen, events, send };
}

for (const provider of ["codex", "claude"]) {
  test(`${provider}: phases survive resume in an existing native session, and late events cannot overwrite them`, async (t) => {
    const f = fixture(t, provider);
    f.controller.runners[provider] = async (ctx) => {
      f.seen.push(ctx);
      ctx.saveSession({ id: "existing-native", tools: hostToolsKey });
      ctx.promptAccepted();
      ctx.goalState("active", "Fix the parser");
      if (f.seen.length === 1) {
        if (provider === "codex") {
          ctx.emit("work", codexPlan());
          ctx.emit("work", codexPlan());
        } else {
          ctx.emit("work", todo());
          ctx.emit("work", result());
          ctx.emit("work", todo("duplicate"));
          ctx.emit("work", result("duplicate"));
          ctx.emit("work", { ...todo("failed"), item: { ...todo("failed").item, input: { todos: [{ content: "Bad plan", status: "pending" }] } } });
          ctx.emit("work", result("failed", true));
        }
        ctx.goalState("paused");
      } else if (f.seen.length === 2) {
        f.seen[0].emit("work", { kind: "plan", plan: [{ step: "Stale", status: "pending" }] });
        assert.deepEqual(f.store.conversation(f.chat.id).goalProgress.phases, normalized);
        ctx.goalState("complete");
      } else ctx.goalState("complete");
      return { status: "completed" };
    };
    const first = await f.send();
    assert.deepEqual(f.store.conversation(f.chat.id).goalProgress.phases, normalized);
    assert.equal(f.events.filter((e) => e.type === "goal-progress" && e.payload.phases.length).length, 1);
    await f.send({ resumeGoal: true });
    const progress = f.store.conversationSnapshot(f.chat.id).goalProgress;
    assert.equal(progress.goalId, first.id);
    assert.equal(progress.status, "complete");
    assert.ok(progress.phases.every((phase) => phase.status === "completed"));
    assert.equal(f.seen[1].session.id, "existing-native");
    assert.ok(f.seen[1].instructions.includes(GOAL_PROGRESS_INSTRUCTIONS));
    assert.match(f.seen[1].addendum, /Saved Goal phases.*\n- \[completed\] Inspect the parser/s);
    assert.match(f.seen[1].addendum, /\[pending\] Verify and deliver/);
    await f.send();
    assert.notEqual(f.store.conversation(f.chat.id).goalProgress.goalId, first.id);
    assert.deepEqual(f.store.conversation(f.chat.id).goalProgress.phases, []);
  });
}

test("usage handoff preserves the phase list and sends it to the next provider", async (t) => {
  const f = fixture(t);
  f.controller.runners.codex = async (ctx) => {
    ctx.goalState("active", "Fix the parser");
    ctx.emit("work", codexPlan());
    ctx.goalState("usageLimited");
    return { status: "completed" };
  };
  f.controller.runners.claude = async (ctx) => {
    assert.match(ctx.addendum, /\[completed\] Inspect the parser/);
    assert.deepEqual(f.store.conversation(f.chat.id).goalProgress.phases, normalized);
    ctx.goalState("complete");
    return { status: "completed" };
  };
  const first = await f.send();
  await f.send({ provider: "claude", continueAfterUsage: true });
  const progress = f.store.conversation(f.chat.id).goalProgress;
  assert.equal(progress.goalId, first.id);
  assert.equal(progress.provider, "claude");
  assert.equal(progress.status, "complete");
});

for (const mode of ["default", "plan", "ask"]) {
  test(`${mode} does not collect Goal phases or receive Goal progress instructions`, async (t) => {
    const f = fixture(t, "codex", mode);
    f.controller.runners.codex = async (ctx) => {
      assert.ok(!ctx.instructions.includes(GOAL_PROGRESS_INSTRUCTIONS));
      ctx.emit("work", codexPlan());
      return { status: "completed" };
    };
    await f.send();
    assert.equal(f.store.conversation(f.chat.id).goalProgress, null);
  });
}
