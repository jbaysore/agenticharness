import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { modeSuggestionTool } from "../src/core/modes.mjs";
import { claudeContent } from "../src/providers/attachments.mjs";
import { isHarnessTool, cursorAskRejection } from "../src/providers/cursor.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server.mjs";
import { runCodex } from "../src/providers/codex.mjs";
import { EventEmitter } from "node:events";

const objective = "All parser tests pass and the change is delivered.";
const suggestion = (mode) => ({
  mode,
  reason: "This mode better fits the remaining task.",
  ...(mode === "goal" && { objective }),
});
async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for fixture");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function fixture(
  t,
  { provider = "codex", mode = "default", permissions = "auto" } = {},
) {
  const store = new Store(":memory:"),
    controller = new Controller(store, {}),
    chat = store.createConversation({
      projectId: store.addProject("fixture", "C:\\mode-fixture").id,
      provider,
      mode,
      permissions,
    });
  controller.providers = [{ id: provider, models: [{ id: "m", efforts: [] }] }];
  // A suggestion must never invoke the automatic action reviewer.
  controller.workers.codex = controller.workers.claude = async () => {
    assert.fail("Mode suggestions must reach the user");
  };
  t.after(async () => {
    await controller.close();
    store.close();
  });
  const start = (runner) => {
    controller.runners[provider] = runner;
    const run = controller.send(chat.id, {
      actionId: "mode-suggestion-fixture",
      text: "Improve the parser",
      provider,
      model: "m",
    });
    return {
      run,
      task: controller.active.get(chat.id).task.then(() => {
        assert.notEqual(
          store.run(run.id).status,
          "failed",
          store.run(run.id).error,
        );
      }),
    };
  };
  return { store, controller, chat, start };
}

for (const permissions of ["auto", "manual", "override"])
  for (const provider of ["codex", "claude", "cursor"])
    test(`${provider}/${permissions}: approval is required before resuming the same task in Plan`, async (t) => {
      const { store, controller, chat, start } = fixture(t, {
        provider,
        permissions,
      });
      const contexts = [],
        results = [];
      const { run, task } = start(async (ctx) => {
        contexts.push(ctx);
        ctx.saveSession({ id: "same-session" });
        if (contexts.length === 1) {
          assert.ok(ctx.tools.some((tool) => tool.name === "suggest_mode"));
          results.push(await ctx.history("suggest_mode", suggestion("plan")));
        }
        return { status: "completed" };
      });
      await waitFor(() => store.pendingApprovals(chat.id).length === 1);
      const approval = store.pendingApprovals(chat.id)[0];
      assert.equal(approval.request.kind, "mode-change");
      assert.equal(approval.request.fromMode, "default");
      assert.equal(approval.request.mode, "plan");
      assert.equal(store.conversation(chat.id).mode, "default");
      assert.equal(contexts[0].signal.aborted, false);
      assert.equal(store.run(run.id).status, "waiting");
      controller.answer(approval.id, { allow: true });
      await task;
      assert.equal(store.conversation(chat.id).mode, "plan");
      assert.equal(contexts.length, 2);
      assert.equal(contexts[1].session.id, "same-session");
      assert.equal(contexts[1].mode, "plan");
      assert.equal(contexts[1].permissions, permissions);
      assert.match(contexts[1].text, /user approved changing the chat mode/);
      assert.match(contexts[1].text, /Original request:\nImprove the parser/);
      assert.equal(
        store.messages(chat.id).filter((m) => m.role === "user").length,
        1,
      );
      assert.equal(store.run(run.id).status, "completed");
      assert.deepEqual(results, [{ changed: true, mode: "plan" }]);
      assert.equal(controller.bridgeModes.size, 0);
      // A duplicate answer cannot change the mode or restart the run again.
      controller.answer(approval.id, { allow: false });
      assert.equal(contexts.length, 2);
    });

for (const [from, to] of [
  ["ask", "default"],
  ["plan", "goal"],
  ["goal", "ask"],
  ["goal", "default"],
  ["plan", "default"],
])
  test(`approved ${from} to ${to} suggestions apply the requested mode and goal objective`, async (t) => {
    const { store, controller, chat, start } = fixture(t, { mode: from });
    const contexts = [];
    const { task } = start(async (ctx) => {
      contexts.push(ctx);
      if (contexts.length === 1)
        await ctx.history("suggest_mode", suggestion(to));
      return { status: "completed" };
    });
    await waitFor(() => store.pendingApprovals(chat.id).length === 1);
    const approval = store.pendingApprovals(chat.id)[0];
    assert.equal(
      approval.request.objective,
      to === "goal" ? objective : undefined,
    );
    controller.answer(approval.id, { allow: true });
    await task;
    assert.equal(contexts[1].mode, to);
    assert.equal(contexts[1].startGoal, to === "goal");
    if (to === "goal") {
      assert.equal(contexts[1].goalObjective, objective);
      assert.equal(await claudeContent(contexts[1]), "/goal " + objective);
      assert.match(
        contexts[1].instructions,
        /Original request:\nImprove the parser/,
      );
    }
    if (to === "ask")
      assert.equal(
        contexts[1].tools.some((tool) => tool.name === "land_changes"),
        false,
      );
    assert.equal(store.conversation(chat.id).mode, to);
  });

for (const outcome of [
  "decline",
  "cancel",
  "manual-change",
  "stop-after-approval",
])
  test(`${outcome} prevents a pending suggestion from changing the mode`, async (t) => {
    const { store, controller, chat, start } = fixture(t, {
      permissions: "override",
    });
    const contexts = [],
      results = [];
    const { task } = start(async (ctx) => {
      contexts.push(ctx);
      results.push(await ctx.history("suggest_mode", suggestion("plan")));
      return { status: "completed" };
    });
    await waitFor(() => store.pendingApprovals(chat.id).length === 1);
    const approval = store.pendingApprovals(chat.id)[0];
    if (outcome === "cancel") controller.cancel(chat.id);
    else {
      if (outcome === "manual-change") controller.setMode(chat.id, "ask");
      if (outcome === "stop-after-approval")
        controller.on("event", (e) => {
          if (e.type === "approval-resolved") controller.cancel(chat.id);
        });
      controller.answer(approval.id, { allow: outcome !== "decline" });
    }
    await task;
    assert.equal(results[0].changed, false);
    assert.equal(
      store.conversation(chat.id).mode,
      outcome === "manual-change" ? "ask" : "default",
    );
    assert.equal(contexts.length, 1);
    assert.equal(controller.approvalWaiters.size, 0);
    if (outcome === "cancel")
      assert.throws(
        () => controller.answer(approval.id, { allow: true }),
        /expired/,
      );
  });

test("invalid, redundant and concurrent suggestions cannot change the mode or bypass approval", async (t) => {
  const { store, controller, chat, start } = fixture(t, {
    provider: "cursor",
    mode: "ask",
  });
  const { task } = start(async (ctx) => {
    for (const input of [
      { mode: "bad", reason: "Why" },
      { mode: "plan", reason: " " },
      suggestion("goal"),
    ])
      await assert.rejects(ctx.history("suggest_mode", input));
    assert.equal(
      (await ctx.history("suggest_mode", suggestion("ask"))).changed,
      false,
    );
    const pending = ctx.history("suggest_mode", suggestion("plan"));
    const duplicate = await ctx.history("suggest_mode", suggestion("default"));
    assert.equal(duplicate.changed, false);
    assert.equal(store.pendingApprovals(chat.id).length, 1);
    controller.answer(store.pendingApprovals(chat.id)[0].id, { allow: false });
    await pending;
    return { status: "completed" };
  });
  await task;
  assert.equal(store.conversation(chat.id).mode, "ask");
});

test("Goal suggestions need a nonempty objective before reaching the user", async (t) => {
  const { store, chat, start } = fixture(t);
  const { task } = start(async (ctx) => {
    for (const input of [
      { mode: "goal", reason: "Persist" },
      { mode: "goal", reason: "Persist", objective: " " },
    ])
      await assert.rejects(
        ctx.history("suggest_mode", input),
        /concrete Goal objective/,
      );
    return { status: "completed" };
  });
  await task;
  assert.equal(store.pendingApprovals(chat.id).length, 0);
  assert.equal(store.conversation(chat.id).mode, "default");
});

test("Claude can suggest another mode after the user has approved its plan", async (t) => {
  const { store, controller, chat, start } = fixture(t, {
    provider: "claude",
    mode: "plan",
  });
  let calls = 0;
  const { task } = start(async (ctx) => {
    calls++;
    if (calls === 1) {
      ctx.planApproved();
      await ctx.history("suggest_mode", suggestion("goal"));
    }
    return { status: "completed" };
  });
  await waitFor(() => store.pendingApprovals(chat.id).length === 1);
  const approval = store.pendingApprovals(chat.id)[0];
  assert.equal(approval.request.fromMode, "default");
  controller.answer(approval.id, { allow: true });
  await task;
  assert.equal(calls, 2);
  assert.equal(store.conversation(chat.id).mode, "goal");
});

test("Codex leaves native Plan before activating the approved Goal in the saved session", async () => {
  const rpc = new EventEmitter(),
    calls = [];
  rpc.close = () => {
    rpc.closed = true;
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
    if (method === "thread/resume") return { thread: { id: "saved-plan" } };
    if (method === "turn/start") return { turn: { id: "goal-turn" } };
    if (method === "thread/goal/set") {
      setImmediate(() => {
        rpc.emit("notification", {
          method: "thread/goal/updated",
          params: { goal: { status: "complete", objective } },
        });
        rpc.emit("notification", {
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        });
      });
      return { goal: { status: "active" } };
    }
    assert.fail("Unexpected RPC method " + method);
  };
  const result = await runCodex(
    {
      project: { path: process.cwd() },
      session: { id: "saved-plan" },
      model: "fixture",
      mode: "goal",
      continuing: true,
      startGoal: true,
      goalObjective: objective,
      text: "Continue the approved task",
      tools: [modeSuggestionTool],
      signal: new AbortController().signal,
      emit() {},
      saveSession() {},
    },
    { open: async () => rpc },
  );
  assert.equal(result.status, "completed");
  const turnAt = calls.findIndex((call) => call.method === "turn/start");
  const goalAt = calls.findIndex((call) => call.method === "thread/goal/set");
  assert.ok(turnAt < goalAt);
  assert.equal(calls[turnAt].params.collaborationMode.mode, "default");
  assert.equal(calls[goalAt].params.objective, objective);
  assert.equal(calls[goalAt].params.origin, "user");
  assert.equal(calls[goalAt].params.threadId, "saved-plan");
  const resume = calls.find((call) => call.method === "thread/resume");
  assert.ok(
    resume.params.dynamicTools.some((tool) => tool.name === "suggest_mode"),
  );
});

test("Cursor lets the suggestion reach Harness's manual approval even in Ask mode", () => {
  const tools = [modeSuggestionTool],
    call = {
      kind: "other",
      title: "harness-history-suggest_mode: suggest_mode",
    };
  assert.equal(isHarnessTool(call, tools), true);
  assert.equal(cursorAskRejection("ask", call, tools), null);
  assert.equal(isHarnessTool(call, []), false);
});

test("the Cursor MCP bridge offers mode suggestions, waits for manual approval and expires its capability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-mode-suggestions-"));
  const app = await createHarness({
    dataDir: dir,
    port: 0,
    startProviders: false,
  });
  try {
    const { store, controller } = app;
    const chat = store.createConversation({
      projectId: store.addProject("Modes", dir).id,
      provider: "cursor",
      mode: "ask",
      permissions: "override",
    });
    controller.providers = [
      { id: "cursor", models: [{ id: "m", efforts: [] }] },
    ];
    let calls = 0;
    controller.runners.cursor = async (ctx) => {
      calls++;
      if (calls === 1)
        await new Promise((resolve) =>
          ctx.signal.addEventListener("abort", resolve, { once: true }),
        );
      return { status: "completed" };
    };
    controller.send(chat.id, {
      actionId: "mode-bridge-test-fixture",
      text: "Improve the parser",
      provider: "cursor",
      model: "m",
    });
    const task = controller.active.get(chat.id).task;
    await waitFor(() => controller.bridgeModes.size === 1);
    const [token] = controller.bridgeModes.keys();
    const headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    };
    const list = await fetch(app.runtime.origin + "/internal/tools", {
      headers,
    });
    assert.ok(
      (await list.json()).tools.some((tool) => tool.name === "suggest_mode"),
    );
    const result = fetch(app.runtime.origin + "/internal/history", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "suggest_mode",
        arguments: suggestion("plan"),
      }),
    });
    await waitFor(() => store.pendingApprovals(chat.id).length === 1);
    assert.equal(store.conversation(chat.id).mode, "ask");
    const approval = store.pendingApprovals(chat.id)[0];
    const answer = await fetch(
      app.runtime.origin + "/api/approvals/" + approval.id,
      {
        method: "POST",
        headers: {
          "X-Harness-Client": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ allow: true }),
      },
    );
    assert.equal(answer.status, 200);
    assert.deepEqual(await (await result).json(), {
      changed: true,
      mode: "plan",
    });
    await task;
    assert.equal(calls, 2);
    assert.equal(store.conversation(chat.id).mode, "plan");
    assert.equal(
      (await fetch(app.runtime.origin + "/internal/tools", { headers })).status,
      401,
    );
    assert.equal(
      (
        await fetch(app.runtime.origin + "/internal/history", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "suggest_mode",
            arguments: suggestion("default"),
          }),
        })
      ).status,
      401,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
