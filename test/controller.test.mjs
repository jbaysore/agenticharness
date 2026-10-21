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
