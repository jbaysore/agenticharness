import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { runClaude } from "../src/providers/claude.mjs";
import {
  CLAUDE_ASK_TOOLS,
  hostToolsForMode,
  modeSuggestionTool,
} from "../src/core/modes.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  codexAskBlocksApproval,
  codexCollaboration,
  codexExecutionPolicy,
} from "../src/providers/codex.mjs";
import { cursorAskRejection, cursorModeId } from "../src/providers/cursor.mjs";

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
  assert.throws(
    () => controller.setMode(chat.id, "ship-it"),
    /ask, plan or goal/,
  );
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

test("an approved Claude switch to Goal starts the concrete objective while resuming its session", async () => {
  const { run, seen } = fakeClaude({
    text: "Continue the current task without repeating completed actions",
    mode: "goal",
    continuing: true,
    startGoal: true,
    goalObjective: "The parser tests pass",
    session: { id: "saved-session" },
    approve: async () => ({ allow: true }),
  });
  await run;
  assert.equal(seen.message, "/goal The parser tests pass");
  assert.equal(seen.options.resume, "saved-session");
});

test("Claude exposes the suggestion as an MCP tool that reaches Harness even in Ask mode", async () => {
  const calls = [];
  const { run } = fakeClaude(
    {
      text: "How does the parser work?",
      mode: "ask",
      tools: [modeSuggestionTool],
      history: async (name, args) => {
        calls.push({ name, args });
        return { changed: false };
      },
      approve: async () => ({ allow: true }),
    },
    async (options) => {
      assert.equal(
        (await options.canUseTool("mcp__harness__suggest_mode", {})).behavior,
        "allow",
      );
      const client = new Client({ name: "mode-test", version: "1.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const server = options.mcpServers.harness.instance;
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const { tools } = await client.listTools();
        assert.ok(tools.some((tool) => tool.name === "suggest_mode"));
        const result = await client.callTool({
          name: "suggest_mode",
          arguments: { mode: "plan", reason: "Map the parser changes first" },
        });
        assert.deepEqual(JSON.parse(result.content[0].text), {
          changed: false,
        });
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
  assert.equal((await run).status, "completed");
  assert.deepEqual(calls, [
    {
      name: "suggest_mode",
      args: { mode: "plan", reason: "Map the parser changes first" },
    },
  ]);
});

test("ask mode stays on after a turn and reaches Cursor", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.providers = [{ id: "cursor", models: [{ id: "m", efforts: [] }] }];
  let seen;
  controller.runners.cursor = async (ctx) => {
    seen = ctx;
    return { status: "completed" };
  };
  const chat = store.createConversation({
    projectId: store.addProject("fixture", "C:\\fixture").id,
    provider: "cursor",
    mode: "ask",
  });
  controller.send(chat.id, {
    actionId: "ask-reaches-cursor",
    text: "How does the queue work?",
    provider: "cursor",
    model: "m",
  });
  await controller.active.get(chat.id).task;
  assert.equal(seen.mode, "ask");
  assert.match(seen.instructions, /Ask mode/);
  assert.equal(
    seen.tools.some((tool) => tool.name === "land_changes"),
    false,
  );
  assert.equal(
    seen.tools.some((tool) => tool.name === "history_search"),
    true,
  );
  // Answering a question leaves the chat in ask mode.
  assert.equal(store.conversation(chat.id).mode, "ask");
  store.close();
});

test("ask mode offers read tools and withholds anything that can change the project", () => {
  const tools = hostToolsForMode("ask", [
    { name: "history_search" },
    { name: "rename_chat" },
    { name: "delegate_read" },
    { name: "delegate_locate" },
    { name: "delegate_edit" },
    { name: "delegate_run" },
    { name: "delegate_draft" },
    { name: "land_changes" },
  ]);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["history_search", "rename_chat", "delegate_read", "delegate_locate"],
  );
  assert.equal(hostToolsForMode("plan", [{ name: "land_changes" }]).length, 1);
});

test("Claude ask mode can read and cannot edit, run commands, or leave the mode", async () => {
  const decisions = {};
  const { run, seen } = fakeClaude(
    {
      text: "How does the queue work?",
      mode: "ask",
      permissions: "override",
      tools: [
        { name: "history_search" },
        { name: "browser_snapshot" },
        { name: "suggest_mode" },
      ],
      approve: async () => ({ allow: true }),
    },
    async (options) => {
      for (const name of [
        "Read",
        "Edit",
        "Bash",
        "ExitPlanMode",
        "mcp__harness__history_search",
        "mcp__harness__suggest_mode",
        "mcp__harness__land_changes",
        "mcp__harness__browser_snapshot",
        "mcp__harness__browser_click",
      ])
        decisions[name] = await options.canUseTool(name, {});
    },
  );
  assert.equal((await run).status, "completed");
  assert.equal(seen.options.permissionMode, "bypassPermissions");
  assert.deepEqual(seen.options.tools, CLAUDE_ASK_TOOLS);
  assert.equal(decisions.Read.behavior, "allow");
  assert.equal(decisions["mcp__harness__history_search"].behavior, "allow");
  assert.equal(decisions["mcp__harness__suggest_mode"].behavior, "allow");
  assert.equal(decisions["mcp__harness__browser_snapshot"].behavior, "allow");
  for (const name of [
    "Edit",
    "Bash",
    "ExitPlanMode",
    "mcp__harness__land_changes",
    "mcp__harness__browser_click",
  ])
    assert.equal(decisions[name].behavior, "deny", name);
});

test("Codex ask mode is a read-only sandbox and is not plan mode", () => {
  assert.deepEqual(codexExecutionPolicy("ask", "override"), {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "read-only",
  });
  assert.equal(
    codexExecutionPolicy("default", "override").sandbox,
    "danger-full-access",
  );
  assert.equal(codexCollaboration("ask"), "default");
  assert.equal(codexCollaboration("plan"), "plan");
  assert.equal(
    codexAskBlocksApproval("ask", "item/fileChange/requestApproval"),
    true,
  );
  assert.equal(
    codexAskBlocksApproval("ask", "item/commandExecution/requestApproval"),
    true,
  );
  assert.equal(
    codexAskBlocksApproval("plan", "item/fileChange/requestApproval"),
    false,
  );
});

test("Cursor ask mode uses the native ask id and declines other permissions", () => {
  assert.equal(cursorModeId("ask"), "ask");
  assert.equal(cursorModeId("plan"), "plan");
  assert.equal(cursorModeId("default"), "agent");
  assert.equal(cursorAskRejection("plan", { kind: "edit" }, [], []), null);
  assert.deepEqual(
    cursorAskRejection(
      "ask",
      { kind: "edit", title: "Edit file" },
      [],
      [{ kind: "reject_once", optionId: "no" }],
    ),
    { outcome: "selected", optionId: "no" },
  );
  assert.equal(
    cursorAskRejection(
      "ask",
      {
        kind: "other",
        title: "harness-history-history_search: history_search",
      },
      [{ name: "history_search" }],
      [{ kind: "reject_once", optionId: "no" }],
    ),
    null,
  );
});
