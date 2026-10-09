import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";

test("an approval can be answered synchronously and retries never answer twice", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  const p = store.addProject("fixture", "C:\\fixture"),
    chat = store.createConversation({ projectId: p.id });
  const run = store.createRun({
    conversationId: chat.id,
    actionId: "approval-race-check",
    provider: "codex",
    model: "test",
    text: "fixture",
  });
  let id;
  controller.on("event", (e) => {
    if (e.type === "approval") {
      id = e.payload.id;
      controller.answer(id, { allow: true });
    }
  });
  const answer = await controller.waitApproval(
    run,
    { kind: "permission" },
    new AbortController().signal,
  );
  assert.equal(answer.allow, true);
  assert.equal(controller.answer(id, { allow: false }).response.allow, true);
  assert.equal(controller.approvalWaiters.size, 0);
  store.close();
});

test("a chat starting beside another in the same folder is told about it; an unrelated project is not", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.providers = [{ id: "codex", models: [{ id: "m", efforts: [] }] }];
  const seen = {},
    finish = {},
    events = [];
  controller.runners.codex = async (ctx) => {
    seen[ctx.chat.id] = ctx;
    await new Promise((resolve) => (finish[ctx.chat.id] = resolve));
    return { status: "completed" };
  };
  controller.on("event", (e) => events.push(e));
  const chat = (name, path) =>
    store.createConversation({
      projectId: store.addProject(name, path).id,
      title: name,
    });
  const first = chat("First", "C:\\harness-fixture\\shared"),
    second = chat("Second", "C:\\harness-fixture\\shared\\packages\\app"),
    third = chat("Third", "C:\\harness-fixture\\elsewhere");
  const start = async (target, text) => {
    controller.send(target.id, {
      actionId: "workspace-notice-" + target.title,
      text,
      provider: "codex",
      model: "m",
    });
    while (!seen[target.id]) await new Promise((r) => setTimeout(r, 5));
    return seen[target.id];
  };
  const alone = await start(first, "Refactor the parser"),
    beside = await start(second, "Add a regression test"),
    apart = await start(third, "Something unrelated");
  assert.equal(alone.handoff, "");
  assert.equal(apart.handoff, "");
  assert.match(beside.handoff, /another chat is working in this repository/);
  assert.match(beside.handoff, /"First" \(codex.*Refactor the parser/);
  assert.match(beside.handoff, /never with git add -A/);
  assert.match(
    beside.instructions,
    /call workspace_activity before you commit/,
  );
  assert.equal(store.messages(second.id)[0].content, "Add a regression test");
  const notices = events.filter((e) => e.payload.kind === "workspace-notice");
  assert.deepEqual(
    notices.map((e) => e.conversationId),
    [second.id],
  );
  // The chat that started first learns of its neighbour when it asks.
  const peers = await alone.history("workspace_activity", {});
  assert.deepEqual(
    peers.map((p) => p.title),
    ["Second"],
  );
  assert.deepEqual(await apart.history("workspace_activity", {}), []);
  for (const done of Object.values(finish)) done();
  await controller.close();
  assert.equal(controller.active.size, 0);
  assert.deepEqual(await alone.history("workspace_activity", {}), []);
  store.close();
});

test("cancelling pending approval expires it and unblocks the provider", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {}),
    abort = new AbortController();
  const p = store.addProject("fixture", "C:\\fixture"),
    chat = store.createConversation({ projectId: p.id });
  const run = store.createRun({
    conversationId: chat.id,
    actionId: "cancel-approval-check",
    provider: "claude",
    model: "test",
    text: "fixture",
  });
  const response = controller.waitApproval(
      run,
      { kind: "permission" },
      abort.signal,
    ),
    id = store.pendingApprovals(chat.id)[0].id;
  abort.abort();
  assert.equal((await response).allow, false);
  assert.throws(() => controller.answer(id, { allow: true }), /expired/);
  store.close();
});
