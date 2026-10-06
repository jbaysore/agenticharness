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
