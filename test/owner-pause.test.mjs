import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import {
  checkOwnerAnswer,
  checkOwnerPause,
  ownerAnswerPrompt,
} from "../src/core/owner-pause.mjs";
import { ownerPauses } from "../src/core/goals.mjs";

const STATEMENT = "Merge the pull request.";

function harness() {
  const store = new Store(":memory:"),
    controller = new Controller(store, {}),
    seen = [];
  controller.providers = [
    { id: "codex", name: "Codex", models: [{ id: "m", efforts: [] }] },
  ];
  controller.runners.codex = async (ctx) => {
    seen.push(ctx);
    if (ctx.text.startsWith("Block on the owner")) {
      ctx.goalState("active", "Ship the release");
      const paused = await ctx.history("pause_for_owner", {
        statement: STATEMENT,
      });
      assert.equal(paused.parked, true);
      await new Promise((resolve) =>
        ctx.signal.addEventListener("abort", resolve, { once: true }),
      );
      ctx.ownerParked();
      return { status: "cancelled" };
    }
    if (ctx.text.startsWith("Leave without confirming")) {
      ctx.goalState("active", "Ship the release");
      await ctx.history("pause_for_owner", { statement: STATEMENT });
      return { status: "completed" };
    }
    ctx.goalState("complete");
    return { status: "completed" };
  };
  const project = store.addProject("fixture", "C:\\owner-pause-fixture");
  const chat = store.createConversation({
    projectId: project.id,
    provider: "codex",
    model: "m",
    mode: "goal",
  });
  return { store, controller, seen, chat };
}

const send = async (controller, chat, actionId, text, extra = {}) => {
  const run = controller.send(chat.id, {
    actionId,
    text,
    provider: "codex",
    model: "m",
    mode: "goal",
    ...extra,
  });
  await controller.active.get(chat.id)?.task;
  return run;
};

test("an owner pause needs a statement, and deny or other needs a reason", () => {
  assert.equal(checkOwnerPause({ statement: "  Merge it.  " }).statement, "Merge it.");
  assert.throws(() => checkOwnerPause({ statement: "   " }));
  assert.equal(checkOwnerAnswer("done", "").choice, "done");
  assert.throws(() => checkOwnerAnswer("deny", "  "));
  assert.throws(() => checkOwnerAnswer("other", ""));
  assert.equal(checkOwnerAnswer("other", " Use the other branch. ").reason, "Use the other branch.");
  assert.match(ownerAnswerPrompt("Merge it.", { choice: "deny", reason: "Not yet." }), /Denied/);
});

test("a confirmed owner pause waits without a resume box, then each answer resumes the Goal", async () => {
  const { store, controller, seen, chat } = harness();
  try {
    await send(controller, chat, "owner-pause-block-01", "Block on the owner");
    const saved = store.conversation(chat.id);
    assert.equal(saved.sessions.codex.goal.status, "owner");
    assert.equal(saved.sessions.codex.goal.objective, "Ship the release");
    assert.equal(saved.sessions.codex.goal.ownerPause.statement, STATEMENT);
    assert.equal(saved.owner_pause, true);
    assert.equal(saved.runs, undefined);
    const snapshot = store.conversationSnapshot(chat.id);
    assert.equal(ownerPauses(snapshot).length, 1);
    assert.equal(snapshot.runs[0].status, "completed");

    assert.throws(
      () => controller.answerOwnerPause(chat.id, { actionId: "owner-deny-empty-01", choice: "deny" }),
      /reason/,
    );

    controller.answerOwnerPause(chat.id, {
      actionId: "owner-done-answer-01",
      choice: "done",
    });
    await controller.active.get(chat.id).task;
    assert.match(seen.at(-1).text, /Merge the pull request/);
    assert.match(seen.at(-1).text, /confirmed this is complete/);
    assert.equal(seen.at(-1).resumeGoal, true);
    assert.equal(
      store.messages(chat.id).filter((m) => m.role === "user").at(-1).content,
      "Done. The owner confirmed this is complete.",
    );
    assert.equal(store.conversation(chat.id).sessions.codex.goal.status, "complete");
    assert.equal(store.conversation(chat.id).sessions.codex.goal.objective, "Ship the release");
    assert.equal(store.conversation(chat.id).owner_pause, false);
  } finally {
    await controller.close();
    store.close();
  }
});

test("deny and other resume with the reason, and a typed message does too", async () => {
  const { store, controller, seen, chat } = harness();
  try {
    await send(controller, chat, "owner-pause-reason-01", "Block on the owner");
    controller.answerOwnerPause(chat.id, {
      actionId: "owner-other-answer-01",
      choice: "other",
      reason: "Land it on the release branch instead.",
    });
    await controller.active.get(chat.id).task;
    assert.match(seen.at(-1).text, /Other/);
    assert.match(seen.at(-1).text, /release branch/);
    assert.equal(
      store.messages(chat.id).filter((m) => m.role === "user").at(-1).content,
      "Land it on the release branch instead.",
    );

    await send(controller, chat, "owner-pause-again-01", "Block on the owner");
    await send(controller, chat, "owner-typed-message-1", "I merged it.");
    assert.match(seen.at(-1).text, /The owner wrote/);
    assert.match(seen.at(-1).text, /I merged it/);
    assert.equal(seen.at(-1).resumeGoal, true);
    assert.equal(
      store.messages(chat.id).filter((m) => m.role === "user").at(-1).content,
      "I merged it.",
    );
    assert.equal(store.conversation(chat.id).sessions.codex.goal.objective, "Ship the release");
  } finally {
    await controller.close();
    store.close();
  }
});

test("a pause the agent does not confirm does not stay waiting", async () => {
  const { store, controller, chat } = harness();
  try {
    await send(controller, chat, "owner-unconfirmed-01", "Leave without confirming");
    const saved = store.conversation(chat.id);
    assert.notEqual(saved.sessions.codex.goal.status, "owner");
    assert.equal(saved.owner_pause, false);
    assert.equal(store.conversationSnapshot(chat.id).runs[0].status, "failed");
  } finally {
    await controller.close();
    store.close();
  }
});

test("stop work leaves an owner pause as an ordinary paused Goal", async () => {
  const { store, controller, chat } = harness();
  try {
    await send(controller, chat, "owner-stop-request-1", "Block on the owner");
    controller.cancel(chat.id);
    const saved = store.conversation(chat.id);
    assert.equal(saved.sessions.codex.goal.status, "paused");
    assert.equal(saved.sessions.codex.goal.ownerPause, undefined);
    assert.equal(saved.owner_pause, false);
    assert.equal(saved.sessions.codex.goal.objective, "Ship the release");
  } finally {
    await controller.close();
    store.close();
  }
});

test("default mode cannot pause a Goal for the owner", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.providers = [
    { id: "codex", models: [{ id: "m", efforts: [] }] },
  ];
  let paused = null;
  controller.runners.codex = async (ctx) => {
    paused = await ctx.history("pause_for_owner", { statement: STATEMENT });
    return { status: "completed" };
  };
  const chat = store.createConversation({
    projectId: store.addProject("fixture", "C:\\owner-pause-default").id,
    provider: "codex",
    model: "m",
  });
  try {
    controller.send(chat.id, {
      actionId: "owner-default-mode-01",
      text: "Try to pause",
      provider: "codex",
      model: "m",
    });
    await controller.active.get(chat.id).task;
    assert.equal(paused.parked, undefined);
    assert.match(paused.error, /Goal mode/);
    assert.equal(controller.active.has(chat.id), false);
  } finally {
    await controller.close();
    store.close();
  }
});
