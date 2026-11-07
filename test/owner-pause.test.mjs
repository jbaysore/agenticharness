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
import { runClaude } from "../src/providers/claude.mjs";

const STATEMENT = "Merge the pull request.";

function harness(provider = "codex") {
  const store = new Store(":memory:"),
    controller = new Controller(store, {}),
    seen = [],
    prompts = [], systems = [];
  controller.providers = [
    { id: provider, models: [{ id: "m", efforts: [] }] },
  ];
  controller.runners[provider] = async (ctx) => {
    seen.push(ctx);
    if (ctx.text.startsWith("Ship the release")) {
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
    if (provider === "claude")
      return runClaude(ctx, {
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
        queryFn: ({ prompt, options }) => ({
          interrupt: async () => {},
          close() {},
          async *[Symbol.asyncIterator]() {
            prompts.push((await prompt.next()).value.message.content);
            systems.push(options.systemPrompt.append);
            yield { type: "active_goal", value: null };
            yield { type: "result", is_error: false };
          },
        }),
      });
    ctx.goalState("complete");
    return { status: "completed" };
  };
  const project = store.addProject("fixture", "C:\\owner-pause-fixture");
  const chat = store.createConversation({
    projectId: project.id,
    provider,
    model: "m",
    mode: "goal",
  });
  // These messages steer an established release Goal; the provider cannot
  // substitute its own condition for the user's original objective.
  store.setGoalState(chat.id, provider, "original-release-goal", "paused", "Ship the release");
  return { store, controller, seen, prompts, systems, chat };
}

const send = async (controller, chat, actionId, text, extra = {}) => {
  const run = controller.send(chat.id, {
    actionId,
    text,
    provider: chat.provider,
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
  assert.throws(() => checkOwnerPause({ statement: "x".repeat(601) }));
  assert.equal(checkOwnerAnswer("done", "").choice, "done");
  assert.throws(() => checkOwnerAnswer("deny", "  "));
  assert.throws(() => checkOwnerAnswer("other", ""));
  assert.equal(checkOwnerAnswer("other", " Use the other branch. ").reason, "Use the other branch.");
  assert.match(ownerAnswerPrompt("Merge it.", { choice: "deny", reason: "Not yet." }), /Denied/);
});

test("a confirmed owner pause waits without a resume box, then each answer resumes the Goal", async () => {
  const { store, controller, seen, chat } = harness();
  try {
    await send(controller, chat, "owner-pause-block-01", "Ship the release");
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
    await send(controller, chat, "owner-pause-reason-01", "Ship the release");
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

    await send(controller, chat, "owner-pause-again-01", "Ship the release");
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

for (const answer of [
  { choice: "done", expected: "Done. The owner confirmed this is complete." },
  {
    choice: "deny",
    reason: "Do not promote yet.",
    expected: "Denied.\nDo not promote yet.",
  },
  {
    choice: "other",
    reason: "Use the release branch instead.",
    expected: "Other.\nUse the release branch instead.",
  },
  {
    choice: "typed",
    expected:
      "1) The command failed with a syntax error.\n2) Done.\n3) Update the branch to main",
  },
]) {
  test(`Claude receives ${answer.choice} owner feedback in its SDK prompt`, async () => {
    const { store, controller, seen, prompts, systems, chat } = harness("claude");
    try {
      await send(controller, chat, "claude-owner-pause-01", "Ship the release");
      if (answer.choice === "typed")
        await send(controller, chat, "claude-owner-answer-01", answer.expected);
      else {
        controller.answerOwnerPause(chat.id, {
          actionId: "claude-owner-answer-01",
          choice: answer.choice,
          reason: answer.reason,
        });
        await controller.active.get(chat.id).task;
      }
      assert.equal(prompts.length, 1);
      const prompt = prompts[0];
      assert.ok(
        prompt.includes(seen.at(-1).text),
        "The complete owner response must reach Claude",
      );
      assert.equal(prompt.split(answer.expected).length - 1, 1);
      assert.match(prompt, /You asked the owner to:\n\nMerge the pull request/);
      assert.match(systems[0], /Full Harness Goal \(binding objective\):\nShip the release/);
      const saved = store.conversation(chat.id);
      assert.equal(saved.sessions.claude.goal.objective, "Ship the release");
      assert.equal(saved.sessions.claude.goal.status, "complete");
      assert.equal(saved.owner_pause, false);
      assert.equal(store.conversationSnapshot(chat.id).runs[0].status, "completed");
    } finally {
      await controller.close();
      store.close();
    }
  });
}

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
    await send(controller, chat, "owner-stop-request-1", "Ship the release");
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
