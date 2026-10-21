import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { runClaude } from "../src/providers/claude.mjs";

const auth = async () => ({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "pro",
});
const usage = async () => ({
  rate_limits_available: true,
  rate_limits: {
    extra_usage: { is_enabled: false, user_disabled: true },
    limits: [{ kind: "five_hour", percent: 10 }],
  },
});

// A stand-in Claude session: it records its options and first message, lets
// the test call canUseTool, then finishes the turn.
function fakeClaude(ctx, during = async () => {}) {
  const seen = {};
  const run = runClaude(
    {
      project: { path: process.cwd() },
      signal: new AbortController().signal,
      emit() {},
      saveSession() {},
      ...ctx,
    },
    {
      readAuth: auth,
      readUsage: usage,
      baseOptions: () => ({}),
      pollIntervalMs: 60000,
      queryFn: ({ prompt, options }) => {
        seen.options = options;
        return {
          interrupt: async () => {},
          close() {},
          async *[Symbol.asyncIterator]() {
            const first = await prompt[Symbol.asyncIterator]().next();
            seen.message = first.value.message.content;
            await during(options);
            yield { type: "result", is_error: false };
          },
        };
      },
    },
  );
  return { run, seen };
}

test("a chat's mode is saved, reaches the agent, and goal is refused for Cursor", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.providers = [
    { id: "codex", models: [{ id: "m", efforts: [] }] },
    { id: "cursor", models: [{ id: "m", efforts: [] }] },
  ];
  let seen;
  controller.runners.codex = async (ctx) => {
    seen = ctx;
    ctx.planApproved();
    return { status: "completed" };
  };
  const chat = store.createConversation({
    projectId: store.addProject("fixture", "C:\\fixture").id,
    mode: "plan",
  });
  assert.equal(chat.mode, "plan");
  controller.send(chat.id, {
    actionId: "mode-reaches-agent",
    text: "Plan the parser",
    provider: "codex",
    model: "m",
  });
  await controller.active.get(chat.id).task;
  assert.equal(seen.mode, "plan");
  // Approving the plan leaves plan mode so the chat goes on to build it.
  assert.equal(store.conversation(chat.id).mode, "default");
  assert.equal(controller.setMode(chat.id, "goal").mode, "goal");
  assert.throws(() => controller.setMode(chat.id, "ship-it"), /plan or goal/);
  assert.throws(
    () =>
      controller.send(chat.id, {
        actionId: "cursor-has-no-goal",
        text: "Keep going",
        provider: "cursor",
        model: "m",
      }),
    /Cursor has no goal mode/,
  );
  store.close();
});

test("Claude plans in its plan mode, and an approved plan resumes the chat's permission mode", async () => {
  const requests = [];
  let approved = 0,
    decision;
  const { run, seen } = fakeClaude(
    {
      text: "Add caching",
      mode: "plan",
      permissions: "manual",
      approve: async (request) => {
        requests.push(request);
        return { allow: true };
      },
      planApproved: () => approved++,
    },
    async (options) => {
      decision = await options.canUseTool("ExitPlanMode", {
        plan: "1. Add a cache",
      });
    },
  );
  assert.equal((await run).status, "completed");
  assert.equal(seen.options.permissionMode, "plan");
  assert.equal(requests[0].kind, "plan");
  assert.equal(requests[0].plan, "1. Add a cache");
  assert.equal(approved, 1);
  assert.deepEqual(decision.updatedPermissions, [
    { type: "setMode", mode: "default", destination: "session" },
  ]);
});

test("a Claude goal is set with /goal, and its hand-off moves to the system prompt", async () => {
  const { run, seen } = fakeClaude({
    text: "All tests in test/auth pass",
    mode: "goal",
    handoff: "Earlier work from Codex",
    approve: async () => ({ allow: true }),
  });
  await run;
  assert.equal(seen.message, "/goal All tests in test/auth pass");
  assert.match(seen.options.systemPrompt.append, /Earlier work from Codex/);
  assert.equal(seen.options.permissionMode, "auto");
});
