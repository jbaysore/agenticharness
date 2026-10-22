import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { GOAL_QUESTION_TIMEOUT } from "../src/core/modes.mjs";

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
  assert.equal(beside.handoff, "");
  assert.match(beside.addendum, /another chat is working in this repository/);
  assert.match(beside.addendum, /"First" \(codex.*Refactor the parser/);
  assert.match(beside.addendum, /never with git add -A/);
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

test("the chat's permission mode reaches the agent, and override answers permissions but not questions", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.providers = [{ id: "codex", models: [{ id: "m", efforts: [] }] }];
  const chat = store.createConversation({
    projectId: store.addProject("fixture", "C:\permissions-fixture").id,
  });
  assert.equal(chat.permissions, "auto");
  assert.throws(
    () =>
      controller.send(chat.id, {
        actionId: "permissions-invalid-check",
        text: "hi",
        provider: "codex",
        model: "m",
        permissions: "yolo",
      }),
    /auto-review, manual review or override/,
  );
  const events = [];
  controller.on("event", (e) => {
    events.push(e);
    if (e.type === "approval")
      controller.answer(e.payload.id, { allow: false });
  });
  const turn = async (actionId, permissions) => {
    let seen;
    controller.runners.codex = async (ctx) => {
      seen = {
        permissions: ctx.permissions,
        permission: await ctx.approve({ kind: "permission", title: "rm x" }),
        question: await ctx.approve({ kind: "question", title: "Which?" }),
      };
      return { status: "completed" };
    };
    controller.send(chat.id, {
      actionId,
      text: "Clean up",
      provider: "codex",
      model: "m",
      permissions,
    });
    await controller.active.get(chat.id).task;
    return seen;
  };
  const override = await turn("permissions-override-check", "override");
  assert.equal(override.permissions, "override");
  assert.equal(override.permission.allow, true);
  assert.equal(override.question.allow, false);
  assert.equal(store.conversation(chat.id).permissions, "override");
  assert.ok(
    events.some(
      (e) =>
        e.payload.kind === "auto-approved" && /rm x/.test(e.payload.item.title),
    ),
  );
  // A turn without a mode keeps the chat's last one.
  assert.equal((await turn("permissions-kept-check")).permissions, "override");
  const manual = await turn("permissions-manual-check", "manual");
  assert.equal(manual.permission.allow, false);
  assert.equal(store.conversation(chat.id).permissions, "manual");
  store.close();
});

const waitFor = async (condition) => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(
      Date.now() < deadline,
      "Timed out waiting for the simulated agent",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

for (const provider of ["codex", "claude", "cursor"])
  test(`${provider}: permission changes resume the same active run and session with the latest mode`, async () => {
    const store = new Store(":memory:"),
      controller = new Controller(store, {}),
      project = store.addProject("fixture", "C:\\permissions-fixture"),
      chat = store.createConversation({ projectId: project.id, provider }),
      other = store.createConversation({ projectId: project.id }),
      contexts = [],
      answers = [];
    controller.providers = [
      { id: provider, models: [{ id: "m", efforts: [] }] },
    ];
    controller.runners[provider] = async (ctx) => {
      contexts.push(ctx);
      ctx.saveSession({ id: "same-native-session" });
      ctx.emit("text", {
        nativeId: "message-" + contexts.length,
        text: "Progress",
      });
      answers.push(
        await ctx.approve({ kind: "permission", title: "Change a file" }),
      );
      if (ctx.signal.aborted) return { status: "cancelled" };
      answers.push(
        await ctx.approve({ kind: "question", title: "Which file?" }),
      );
      return { status: ctx.signal.aborted ? "cancelled" : "completed" };
    };
    try {
      const run = controller.send(chat.id, {
          actionId: "live-permissions-" + provider,
          text: "Update a file",
          provider,
          model: "m",
        }),
        task = controller.active.get(chat.id).task;
      await waitFor(() => store.pendingApprovals(chat.id).length === 1);
      const expired = store.pendingApprovals(chat.id)[0].id;
      assert.equal(contexts[0].permissions, "auto");
      assert.throws(
        () => controller.setPermissions(chat.id, "bad"),
        /Choose auto-review/,
      );
      assert.equal(contexts[0].signal.aborted, false);
      controller.setPermissions(chat.id, "manual");
      // A second choice during the pause wins without starting an obsolete mode.
      controller.setPermissions(chat.id, "override");
      await waitFor(
        () =>
          contexts.length === 2 && store.pendingApprovals(chat.id).length === 1,
      );
      const question = store.pendingApprovals(chat.id)[0];
      assert.equal(contexts[0].signal.aborted, true);
      assert.equal(contexts[1].permissions, "override");
      assert.equal(contexts[1].session.id, "same-native-session");
      assert.match(contexts[1].text, /Do not repeat completed actions/);
      assert.match(contexts[1].text, /Original request:\nUpdate a file/);
      assert.equal(question.request.kind, "question");
      assert.deepEqual(
        answers.map((a) => a.allow),
        [false, true],
      );
      assert.equal(store.approval(expired).status, "expired");
      assert.throws(
        () => controller.answer(expired, { allow: true }),
        /expired/,
      );
      assert.equal(store.activeRun(chat.id).id, run.id);
      assert.equal(store.run(run.id).ended_at, null);
      assert.equal(store.conversation(other.id).permissions, "auto");
      assert.equal(
        store.messages(chat.id).filter((m) => m.role === "user").length,
        1,
      );

      controller.setPermissions(chat.id, "auto");
      await waitFor(
        () =>
          contexts.length === 3 && store.pendingApprovals(chat.id).length === 1,
      );
      assert.equal(contexts[2].permissions, "auto");
      assert.equal(contexts[2].session.id, "same-native-session");
      assert.equal(
        (
          await contexts[1].approve({
            kind: "permission",
            title: "Late request",
          })
        ).allow,
        false,
      );
      assert.equal(
        store.pendingApprovals(chat.id)[0].request.kind,
        "permission",
      );
      // Selecting the same mode does not interrupt the agent again.
      controller.setPermissions(chat.id, "auto");
      assert.equal(contexts[2].signal.aborted, false);
      controller.answer(store.pendingApprovals(chat.id)[0].id, { allow: true });
      await waitFor(() => store.pendingApprovals(chat.id).length === 1);
      controller.answer(store.pendingApprovals(chat.id)[0].id, { allow: true });
      await task;
      assert.equal(store.run(run.id).status, "completed");
      assert.equal(controller.active.size, 0);
      assert.equal(controller.approvalWaiters.size, 0);
      const endings = store
        .events()
        .filter(
          (e) =>
            e.type === "run" &&
            ["completed", "cancelled", "failed"].includes(e.payload.status),
        );
      assert.deepEqual(
        endings.map((e) => e.payload.status),
        ["completed"],
      );
    } finally {
      await controller.close();
      store.close();
    }
  });

for (const stop of ["cancel", "close"])
  test(`${stop} during a permission change prevents automatic continuation`, async () => {
    const store = new Store(":memory:"),
      controller = new Controller(store, {}),
      chat = store.createConversation({
        projectId: store.addProject("fixture", "C:\\permissions-stop-fixture")
          .id,
      });
    let starts = 0;
    controller.providers = [
      { id: "codex", models: [{ id: "m", efforts: [] }] },
    ];
    controller.runners.codex = async (ctx) => {
      starts++;
      await ctx.approve({ kind: "permission", title: "Wait for approval" });
      return { status: "cancelled" };
    };
    try {
      const run = controller.send(chat.id, {
          actionId: "permissions-stop-" + stop,
          text: "Do some work",
          provider: "codex",
          model: "m",
        }),
        task = controller.active.get(chat.id).task;
      await waitFor(() => store.pendingApprovals(chat.id).length === 1);
      controller.setPermissions(chat.id, "override");
      if (stop === "cancel") controller.cancel(chat.id);
      else await controller.close();
      await task;
      assert.equal(starts, 1);
      assert.equal(store.run(run.id).status, "cancelled");
      assert.equal(controller.active.size, 0);
    } finally {
      await controller.close();
      store.close();
    }
  });

test("a follow-up queues until the turn ends, and /steer redirects that turn", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.providers = [{ id: "codex", models: [{ id: "m", efforts: [] }] }];
  const { createSkill } = await import("../src/core/skills.mjs");
  createSkill(store, {
    name: "Review notes",
    instructions: "Write the decision down.",
  });
  const project = store.addProject("fixture", "C:\\queue-steer"),
    chat = store.createConversation({
      projectId: project.id,
      provider: "codex",
      model: "m",
    });
  const steered = [];
  let holds = 0,
    release;
  controller.runners.codex = async (ctx) => {
    holds += 1;
    ctx.attachSteer?.((item) => steered.push(item.text));
    if (holds === 1)
      await new Promise((resolve) => {
        release = resolve;
      });
    return { status: "completed" };
  };
  try {
    controller.send(chat.id, {
      actionId: "queue-steer-first-message",
      text: "Do the first thing",
      provider: "codex",
      model: "m",
    });
    while (!release) await new Promise((r) => setTimeout(r, 5));
    const queued = controller.send(chat.id, {
      actionId: "queue-steer-second-message",
      text: "Then do the second thing",
      provider: "codex",
      model: "m",
    });
    assert.equal(queued.queued, true);
    assert.equal(queued.text, "Then do the second thing");
    assert.equal(
      controller.send(chat.id, {
        actionId: "queue-steer-second-message",
        text: "Then do the second thing",
        provider: "codex",
        model: "m",
      }).duplicate,
      true,
    );
    const explicit = controller.send(chat.id, {
      actionId: "queue-steer-explicit-queue",
      text: "/queue /ask Look only",
      provider: "codex",
      model: "m",
    });
    assert.equal(explicit.text, "Look only");
    assert.equal(explicit.mode, "ask");
    assert.equal(store.conversation(chat.id).mode, "default");
    controller.removeQueued(chat.id, explicit.id);
    assert.equal(store.queuedInputs(chat.id).length, 1);
    const redirected = controller.send(chat.id, {
      actionId: "queue-steer-redirect-now",
      text: "/steer /review-notes Focus on the parser",
      provider: "codex",
      model: "m",
    });
    assert.equal(redirected.steered, true);
    assert.equal(steered.length, 1);
    assert.match(steered[0], /Focus on the parser/);
    assert.match(steered[0], /Skill: Review notes/);
    assert.equal(
      store
        .messages(chat.id)
        .filter((message) => message.role === "user")
        .at(-1).content,
      "/review-notes Focus on the parser",
    );
    assert.equal(
      controller.send(chat.id, {
        actionId: "queue-steer-redirect-now",
        text: "/steer Again",
        provider: "codex",
        model: "m",
      }).duplicate,
      true,
    );
    assert.equal(steered.length, 1);
    const firstTask = controller.active.get(chat.id).task;
    release();
    await firstTask;
    const second = controller.active.get(chat.id);
    assert.equal(
      store
        .messages(chat.id)
        .find((message) => message.run_id === second.run.id).content,
      "Then do the second thing",
    );
    await second.task;
    assert.equal(store.queuedInputs(chat.id).length, 0);
    const idle = controller.send(chat.id, {
      actionId: "queue-steer-idle-steer",
      text: "/steer Just send this",
      provider: "codex",
      model: "m",
    });
    assert.notEqual(idle.queued, true);
    assert.notEqual(idle.steered, true);
    await controller.active.get(chat.id).task;
    assert.equal(
      store.messages(chat.id).find((message) => message.run_id === idle.id)
        .content,
      "Just send this",
    );
    assert.throws(
      () =>
        controller.send(chat.id, {
          actionId: "queue-steer-empty-command",
          text: "/queue",
          provider: "codex",
          model: "m",
        }),
      /Enter a message/,
    );
  } finally {
    await controller.close();
    store.close();
  }
});

test("a saved queue waits through a restart until the next submit, oldest first", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.providers = [{ id: "codex", models: [{ id: "m", efforts: [] }] }];
  const chat = store.createConversation({
    projectId: store.addProject("fixture", "C:\\queue-restart").id,
    provider: "codex",
    model: "m",
  });
  store.enqueueInput({
    conversationId: chat.id,
    actionId: "saved-queue-older-message",
    text: "Older",
    provider: "codex",
    model: "m",
    permissions: "auto",
    mode: "default",
  });
  assert.equal(controller.active.size, 0);
  const seen = [];
  controller.runners.codex = async (ctx) => {
    seen.push(ctx.text);
    return { status: "completed" };
  };
  try {
    const queued = controller.send(chat.id, {
      actionId: "saved-queue-newer-message",
      text: "Newer",
      provider: "codex",
      model: "m",
    });
    assert.equal(queued.queued, true);
    assert.equal(queued.text, "Newer");
    const deadline = Date.now() + 2000;
    while (seen.length < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(seen, ["Older", "Newer"]);
  } finally {
    await controller.close();
    store.close();
  }
});

const question = (text) => ({
  kind: "question",
  title: text,
  questions: [{ id: "q", question: text, options: [{ label: "Yes" }] }],
});

test("goal decides permissions and plans without a card and does not leave goal", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-goal-")),
    store = new Store(":memory:"),
    controller = new Controller(store, {}),
    events = [];
  controller.providers = [
    {
      id: "codex",
      name: "Codex",
      connected: true,
      models: [{ id: "m", name: "M", isDefault: true, efforts: [] }],
    },
  ];
  controller.workers.codex = async () => ({
    text: JSON.stringify({
      decision: "ask",
      reason: "This would publish the release.",
    }),
  });
  controller.on("event", (e) => events.push(e));
  const chat = store.createConversation({
    projectId: store.addProject("fixture", root).id,
  });
  let seen;
  const turn = (actionId, permissions, run) => {
    controller.runners.codex = run;
    controller.send(chat.id, {
      actionId,
      text: "Ship the parser",
      provider: "codex",
      model: "m",
      permissions,
      mode: "goal",
    });
    return controller.active.get(chat.id).task;
  };
  try {
    await turn("goal-manual-check", "manual", async (ctx) => {
      seen = {
        instructions: ctx.instructions,
        tools: ctx.tools.map((tool) => tool.name),
        permission: await ctx.approve({
          kind: "permission",
          title: "git push",
          details: { command: "git push" },
        }),
        plan: await ctx.approve({
          kind: "plan",
          title: "Review the plan",
          plan: "Ship it",
        }),
        mode: await ctx.history("suggest_mode", {
          mode: "plan",
          reason: "Plan first",
        }),
      };
      return { status: "completed" };
    });
    assert.equal(seen.permission.allow, false);
    assert.match(seen.permission.reason, /publish the release/);
    assert.match(seen.permission.reason, /Goal mode declined this/);
    assert.equal(seen.plan.allow, true);
    assert.equal(seen.mode.changed, false);
    assert.match(seen.mode.reason, /stays on until the objective is met/);
    assert.equal(seen.tools.includes("suggest_mode"), false);
    assert.match(seen.instructions, /stay in Goal until the objective is met/);
    assert.doesNotMatch(seen.instructions, /You may call suggest_mode/);
    assert.equal(store.conversation(chat.id).mode, "goal");
    assert.equal(store.conversation(chat.id).permissions, "manual");
    assert.equal(store.pendingApprovals(chat.id).length, 0);
    assert.ok(events.some((e) => e.payload.kind === "goal-declined"));

    let reviewed = 0;
    controller.workers.codex = async () => {
      reviewed++;
      return { text: "{}" };
    };
    await turn("goal-override-check", "override", async (ctx) => {
      seen = await ctx.approve({
        kind: "permission",
        title: "git push",
        details: { command: "git push" },
      });
      return { status: "completed" };
    });
    assert.equal(seen.allow, true);
    assert.equal(reviewed, 0);
    assert.equal(store.conversation(chat.id).mode, "goal");
    assert.equal(store.pendingApprovals(chat.id).length, 0);
  } finally {
    await controller.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a goal question waits briefly, then the agent chooses, and repeats do not wait", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.goalQuestionTimeoutMs = 40;
  controller.providers = [{ id: "codex", models: [{ id: "m", efforts: [] }] }];
  const chat = store.createConversation({
    projectId: store.addProject("fixture", "C:\\goal-questions").id,
    mode: "goal",
  });
  const results = [];
  controller.runners.codex = async (ctx) => {
    results.push(await ctx.approve(question("Which approach?")));
    results.push(await ctx.approve(question("Which approach?")));
    results.push(await ctx.approve(question("Which name?")));
    results.push(await ctx.approve(question("Which file?")));
    results.push(await ctx.approve(question("Which test?")));
    return { status: "completed" };
  };
  const events = [];
  controller.on("event", (e) => {
    if (e.type === "approval") events.push(e.payload);
  });
  try {
    controller.send(chat.id, {
      actionId: "goal-question-timeout",
      text: "Finish the parser",
      provider: "codex",
      model: "m",
    });
    await controller.active.get(chat.id).task;
    assert.equal(events.length, 3);
    assert.ok(events[0].request.deadline > Date.now() - 1000);
    for (const result of results) {
      assert.equal(result.timedOut, true);
      assert.equal(result.answers.q, GOAL_QUESTION_TIMEOUT);
    }
    assert.equal(store.pendingApprovals(chat.id).length, 0);
    assert.equal(store.conversation(chat.id).mode, "goal");
  } finally {
    await controller.close();
    store.close();
  }
});

test("answering a goal question before the deadline uses that answer", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.goalQuestionTimeoutMs = 2000;
  controller.providers = [{ id: "codex", models: [{ id: "m", efforts: [] }] }];
  const chat = store.createConversation({
    projectId: store.addProject("fixture", "C:\\goal-answer").id,
    mode: "goal",
  });
  let outcome;
  controller.runners.codex = async (ctx) => {
    outcome = await ctx.approve(question("Which approach?"));
    return { status: "completed" };
  };
  try {
    controller.send(chat.id, {
      actionId: "goal-question-answer",
      text: "Finish the parser",
      provider: "codex",
      model: "m",
    });
    const deadline = Date.now() + 3000;
    while (!store.pendingApprovals(chat.id).length) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const pending = store.pendingApprovals(chat.id)[0];
    assert.ok(pending.request.deadline > Date.now());
    controller.answer(pending.id, {
      allow: true,
      answers: { q: "Keep the cache" },
    });
    await controller.active.get(chat.id).task;
    assert.equal(outcome.timedOut, undefined);
    assert.equal(outcome.answers.q, "Keep the cache");
    assert.equal(store.conversation(chat.id).mode, "goal");
  } finally {
    await controller.close();
    store.close();
  }
});

test("stopping a goal expires its open question", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.goalQuestionTimeoutMs = 5000;
  controller.providers = [{ id: "codex", models: [{ id: "m", efforts: [] }] }];
  const chat = store.createConversation({
    projectId: store.addProject("fixture", "C:\\goal-stop").id,
    mode: "goal",
  });
  let outcome;
  controller.runners.codex = async (ctx) => {
    outcome = await ctx.approve(question("Which approach?"));
    return { status: "completed" };
  };
  try {
    controller.send(chat.id, {
      actionId: "goal-question-stop",
      text: "Finish the parser",
      provider: "codex",
      model: "m",
    });
    const deadline = Date.now() + 3000;
    while (!store.pendingApprovals(chat.id).length) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.cancel(chat.id);
    await controller.active.get(chat.id).task;
    assert.equal(outcome.allow, false);
    assert.equal(store.pendingApprovals(chat.id).length, 0);
  } finally {
    await controller.close();
    store.close();
  }
});

test("goal question timeouts survive a permission change in the same run", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.goalQuestionTimeoutMs = 40;
  controller.providers = [{ id: "codex", models: [{ id: "m", efforts: [] }] }];
  const chat = store.createConversation({
    projectId: store.addProject("fixture", "C:\\goal-restart").id,
    mode: "goal",
    permissions: "manual",
  });
  const results = [];
  let calls = 0;
  controller.runners.codex = async (ctx) => {
    calls++;
    if (calls === 1) {
      results.push(await ctx.approve(question("Which approach?")));
      results.push(await ctx.approve(question("Which name?")));
      return { status: "completed" };
    }
    results.push(await ctx.approve(question("Which approach?")));
    return { status: "completed" };
  };
  try {
    controller.send(chat.id, {
      actionId: "goal-question-restart",
      text: "Finish the parser",
      provider: "codex",
      model: "m",
    });
    const task = controller.active.get(chat.id).task;
    const deadline = Date.now() + 3000;
    while (results.length < 1) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    while (!store.pendingApprovals(chat.id).length) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.setPermissions(chat.id, "override");
    await task;
    assert.equal(results[0].timedOut, true);
    assert.equal(results[1].allow, false);
    assert.equal(results[2].timedOut, true);
    assert.equal(calls, 2);
    assert.equal(store.conversation(chat.id).mode, "goal");
    assert.equal(store.conversation(chat.id).permissions, "override");
  } finally {
    await controller.close();
    store.close();
  }
});

test("a mid-turn usage stop flags the chat until a later turn is working", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {}),
    project = store.addProject("fixture", "C:\\usage-flag"),
    chat = store.createConversation({ projectId: project.id, provider: "codex" });
  controller.providers = [{ id: "codex", models: [{ id: "m", efforts: [] }] }];
  let mode = "lost";
  controller.runners.codex = async (ctx) => {
    if (mode === "prestart")
      throw new Error(
        "Included Codex usage is exhausted. Wait for the provider to restore it.",
      );
    if (mode === "goal") {
      ctx.goalState("usageLimited");
      return { status: "completed" };
    }
    if (mode === "paid") {
      ctx.emit("text", { nativeId: "paid", text: "Partial" });
      ctx.emit("work", {
        kind: "billing-stop",
        reason: "Paid Claude extra usage is enabled. Disable it before continuing.",
      });
      ctx.goalState("usageLimited");
      return {
        status: "failed",
        error: "Paid Claude extra usage is enabled. Disable it before continuing.",
      };
    }
    ctx.emit("text", { nativeId: mode, text: "Partial" });
    if (mode === "stop") {
      ctx.emit("work", {
        kind: "billing-stop",
        reason: "Included Codex quota is exhausted.",
      });
      return { status: "interrupted" };
    }
    if (mode === "lost") {
      ctx.emit("work", {
        kind: "billing-stop",
        reason: "Lost authoritative quota information",
      });
      return { status: "interrupted" };
    }
    if (mode === "cancel") {
      ctx.emit("text", { nativeId: "cancel", text: "Stopping" });
      ctx.emit("work", {
        kind: "billing-stop",
        reason: "Included Codex quota is exhausted.",
      });
      await new Promise((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener("abort", resolve, { once: true });
      });
      return { status: "cancelled" };
    }
    return { status: "completed" };
  };
  const turn = (actionId) => {
    const run = controller.send(chat.id, {
      actionId,
      text: "Continue the task",
      provider: "codex",
      model: "m",
    });
    return { run, task: controller.active.get(chat.id).task };
  };
  try {
    const lost = turn("usage-flag-lost-quota");
    await lost.task;
    assert.equal(store.run(lost.run.id).status, "interrupted");
    assert.equal(store.conversation(chat.id).usage_stopped_at, null);

    mode = "stop";
    const stopped = turn("usage-flag-mid-turn");
    await stopped.task;
    assert.equal(store.run(stopped.run.id).status, "failed");
    assert.equal(
      store.run(stopped.run.id).error,
      "Included Codex quota is exhausted.",
    );
    assert.ok(store.conversation(chat.id).usage_stopped_at);
    assert.equal(
      store.conversation(chat.id).usage_stopped_reason,
      "Included Codex quota is exhausted.",
    );

    mode = "prestart";
    const blocked = turn("usage-flag-prestart");
    await blocked.task;
    assert.equal(store.run(blocked.run.id).status, "failed");
    assert.ok(store.conversation(chat.id).usage_stopped_at);

    mode = "continue";
    const continued = turn("usage-flag-continue");
    await continued.task;
    assert.equal(store.run(continued.run.id).status, "completed");
    assert.equal(store.conversation(chat.id).usage_stopped_at, null);

    mode = "cancel";
    const cancelled = turn("usage-flag-user-stop");
    await waitFor(() =>
      store.messages(chat.id).some((m) => m.content === "Stopping"),
    );
    controller.cancel(chat.id);
    await cancelled.task;
    assert.equal(store.run(cancelled.run.id).status, "cancelled");
    assert.equal(store.conversation(chat.id).usage_stopped_at, null);

    mode = "goal";
    const limited = turn("usage-flag-goal-limit");
    await limited.task;
    assert.equal(store.run(limited.run.id).status, "failed");
    assert.match(
      store.conversation(chat.id).usage_stopped_reason,
      /usage limit has been reached/,
    );

    store.clearUsageStop(chat.id);
    mode = "paid";
    const paid = turn("usage-flag-paid-extra");
    await paid.task;
    assert.equal(store.run(paid.run.id).status, "failed");
    assert.match(store.run(paid.run.id).error, /extra usage/);
    assert.equal(store.conversation(chat.id).usage_stopped_at, null);
  } finally {
    await controller.close();
    store.close();
  }
});
