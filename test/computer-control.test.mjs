import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { codexServerArgs } from "../src/providers/codex.mjs";
import { hostTools } from "../src/core/host-tools.mjs";
import { toolBridgeTimeoutMs } from "../src/core/tool-bridge.mjs";
import { REVIEW_PROMPT } from "../src/core/review-policy.mjs";
import {
  checkComputerControl,
  CODEX_COMPUTER_CONTROL_OVERRIDES,
} from "../src/core/computer-control.mjs";

const request = {
  reason: "Check the installed app's title bar, which the sidebar cannot show.",
  apps: ["Game Clipper"],
};

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for fixture");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture(t, { provider = "codex", mode = "default", permissions = "override" } = {}) {
  const store = new Store(":memory:"),
    controller = new Controller(store, {}),
    chat = store.createConversation({
      projectId: store.addProject("fixture", "C:\\computer-control-fixture").id,
      provider,
      mode,
      permissions,
    });
  controller.providers = [{ id: provider, models: [{ id: "m", efforts: [] }] }];
  // Only the user may answer; the automatic reviewer must never be asked.
  controller.workers.codex = controller.workers.claude = async () => {
    assert.fail("Computer control must reach the user");
  };
  t.after(async () => {
    await controller.close();
    store.close();
  });
  const start = (runner, text = "Verify the title bar") => {
    controller.runners[provider] = runner;
    const run = controller.send(chat.id, {
      actionId: `computer-control-${Math.random().toString(36).slice(2, 12)}`,
      text,
      provider,
      model: "m",
    });
    return { run, task: controller.active.get(chat.id).task };
  };
  return { store, controller, chat, start };
}

test("Codex launches with desktop control and the Chrome-backed browser off", () => {
  for (const platform of ["win32", "linux"]) {
    const args = codexServerArgs(platform);
    for (const value of CODEX_COMPUTER_CONTROL_OVERRIDES)
      assert.ok(args.includes(value), value);
    // Codex keeps quotes in a -c key literally, which would not disable anything.
    assert.equal(args.some((arg) => arg.includes('"computer-use')), false);
    const granted = codexServerArgs(platform, { computerControl: true });
    for (const value of CODEX_COMPUTER_CONTROL_OVERRIDES)
      assert.equal(granted.includes(value), false);
  }
});

test("the request tool is offered everywhere and waits on the user without a bridge deadline", () => {
  assert.ok(hostTools.some((tool) => tool.name === "request_computer_control"));
  assert.equal(toolBridgeTimeoutMs("request_computer_control"), null);
  assert.deepEqual(checkComputerControl({ reason: "  x  " }), { reason: "x", apps: [] });
  assert.throws(() => checkComputerControl({ reason: " " }));
  assert.throws(() => checkComputerControl({ reason: "x", apps: "Chrome" }));
});

test("the reviewer denies taking over the computer without a grant", () => {
  assert.match(REVIEW_PROMPT, /computerControlApproved/);
  assert.match(REVIEW_PROMPT, /separate from the user's own browser session/);
  assert.doesNotMatch(REVIEW_PROMPT, /shared Chrome on the user's machine/);
});

for (const provider of ["codex", "claude", "cursor"])
  for (const permissions of ["auto", "override"])
    test(`${provider}/${permissions}: an approval grants computer control for the rest of this task only`, async (t) => {
      const { store, controller, chat, start } = fixture(t, { provider, permissions });
      const contexts = [],
        results = [];
      const { run, task } = start(async (ctx) => {
        contexts.push(ctx);
        assert.match(ctx.instructions, /Never open, drive or read the user's own browser/);
        if (contexts.length === 1) {
          assert.equal(ctx.computerControl, false);
          results.push(await ctx.history("request_computer_control", request));
        }
        return { status: "completed" };
      });
      await waitFor(() => store.pendingApprovals(chat.id).length === 1);
      const approval = store.pendingApprovals(chat.id)[0];
      assert.equal(approval.request.kind, "computer-control");
      assert.equal(approval.request.reason, request.reason);
      assert.deepEqual(approval.request.apps, request.apps);
      controller.answer(approval.id, { allow: true });
      await task;
      assert.equal(results[0].approved, true);
      assert.equal(contexts.length, 2);
      assert.equal(contexts[1].computerControl, true);
      assert.match(contexts[1].text, /user approved computer control/);
      assert.match(contexts[1].text, /Original request:\nVerify the title bar/);
      assert.match(contexts[1].instructions, /Computer control is approved for this task only/);
      assert.equal(store.run(run.id).status, "completed");
      assert.equal(controller.bridgeComputerControl.size, 0);

      // The next task starts without the grant.
      const next = [];
      await start(async (ctx) => {
        next.push(ctx);
        return { status: "completed" };
      }, "Another task").task;
      assert.equal(next.length, 1);
      assert.equal(next[0].computerControl, false);
      assert.doesNotMatch(next[0].instructions, /Computer control is approved/);
    });

test("a declined request leaves the task running without computer control", async (t) => {
  const { store, controller, chat, start } = fixture(t);
  const contexts = [],
    results = [];
  const { task } = start(async (ctx) => {
    contexts.push(ctx);
    results.push(await ctx.history("request_computer_control", request));
    return { status: "completed" };
  });
  await waitFor(() => store.pendingApprovals(chat.id).length === 1);
  controller.answer(store.pendingApprovals(chat.id)[0].id, { allow: false });
  await task;
  assert.equal(contexts.length, 1);
  assert.equal(results[0].approved, false);
  assert.match(results[0].instruction, /sidebar browser/);
});

test("an unanswered Goal request declines instead of granting", async (t) => {
  const { store, chat, start } = fixture(t, { mode: "goal" });
  const contexts = [],
    results = [];
  const realTimeout = globalThis.setTimeout;
  // Shorten only the 60-second approval deadline.
  globalThis.setTimeout = (fn, ms, ...rest) =>
    realTimeout(fn, ms === 60_000 ? 10 : ms, ...rest);
  t.after(() => (globalThis.setTimeout = realTimeout));
  const { task } = start(async (ctx) => {
    contexts.push(ctx);
    results.push(await ctx.history("request_computer_control", request));
    return { status: "completed" };
  });
  await waitFor(() => results.length === 1);
  globalThis.setTimeout = realTimeout;
  assert.equal(results[0].approved, false);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].computerControl, false);
  assert.equal(store.pendingApprovals(chat.id).length, 0);
  await Promise.race([task, new Promise((r) => realTimeout(r, 500))]);
});

test("Ask mode cannot request computer control", async (t) => {
  const { store, chat, start } = fixture(t, { mode: "ask" });
  const results = [];
  const { task } = start(async (ctx) => {
    results.push(await ctx.history("request_computer_control", request));
    return { status: "completed" };
  });
  await task;
  assert.ok(results[0].error);
  assert.equal(store.pendingApprovals(chat.id).length, 0);
});
