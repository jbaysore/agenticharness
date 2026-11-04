import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { runClaude } from "../src/providers/claude.mjs";
import {
  ASK_DENY,
  CLAUDE_ASK_TOOLS,
  askHostAllowed,
  modeSuggestionTool,
} from "../src/core/modes.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { askUserTool } from "../src/core/questions.mjs";
import { planRevisionRequest } from "../src/core/plans.mjs";
import { commandTool } from "../src/core/command-tool.mjs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  codexAskBlocksApproval,
  codexCollaboration,
  codexExecutionPolicy,
} from "../src/providers/codex.mjs";
import {
  cursorAskRejection,
  cursorModeId,
  runCursor,
} from "../src/providers/cursor.mjs";

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
            if (ctx.mode === "goal") yield { type: "active_goal", value: null };
            yield { type: "result", is_error: false };
          },
        };
      },
    },
  );
  return { run, seen };
}

test("Claude exposes explicit command shells through its real MCP tool schema", async () => {
  const { run } = fakeClaude(
    {
      tools: [commandTool],
      history: async (name, input) => {
        assert.equal(name, "run_command");
        assert.equal(input.shell, "cmd");
        assert.equal(input.isolateDependencies, true);
        return { exitCode: 7, output: "real failure retained" };
      },
    },
    async (options) => {
      const client = new Client({ name: "command-test", version: "1.0.0" }),
        [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair(),
        server = options.mcpServers.harness.instance;
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const tools = (await client.listTools()).tools;
        assert.ok(tools.some((tool) => tool.name === "run_command"));
        const result = await client.callTool({
          name: "run_command",
          arguments: {
            command: "echo fixture",
            shell: "cmd",
            isolateDependencies: true,
          },
        });
        assert.equal(JSON.parse(result.content[0].text).exitCode, 7);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
  await run;
});

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

test("Claude receives plan feedback while remaining in plan mode", async () => {
  let decision;
  const { run } = fakeClaude(
    {
      text: "Add caching",
      mode: "plan",
      approve: async () => ({
        allow: false,
        reason: "Include cache invalidation.\nTest expiry.",
      }),
      planApproved: () => assert.fail("The plan was not approved"),
    },
    async (options) => {
      decision = await options.canUseTool("ExitPlanMode", {
        plan: "Add caching",
      });
    },
  );
  assert.equal((await run).status, "completed");
  assert.equal(decision.behavior, "deny");
  assert.match(decision.message, /Stay in plan mode\. Revise the plan/);
  assert.match(decision.message, /say briefly what you changed/);
  assert.match(decision.message, /Include cache invalidation\.\nTest expiry\./);
  assert.equal(decision.updatedPermissions, undefined);
});

test("Claude exposes Harness multiple selection through its real MCP server", async () => {
  const selections = ["Desktop, Windows", "Mobile"];
  const { run } = fakeClaude(
    {
      mode: "ask",
      text: "Choose environments",
      tools: [askUserTool],
      approve: async () => ({
        allow: true,
        answers: { environments: selections },
      }),
      history: async (name, args) => {
        assert.equal(name, "ask_user");
        assert.equal(args.questions[0].multiSelect, true);
        return { allow: true, answers: { environments: selections } };
      },
    },
    async (options) => {
      const client = new Client({ name: "question-test", version: "1.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const server = options.mcpServers.harness.instance;
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const tools = (await client.listTools()).tools;
        assert.ok(tools.some((t) => t.name === "ask_user"));
        const result = await client.callTool({
          name: "ask_user",
          arguments: {
            questions: [
              {
                id: "environments",
                question: "Which environments?",
                multiSelect: true,
                options: selections.map((label) => ({
                  label,
                  description: "Test " + label,
                })),
              },
            ],
          },
        });
        assert.deepEqual(
          JSON.parse(result.content[0].text).answers.environments,
          selections,
        );
        const native = await options.canUseTool("AskUserQuestion", {
          questions: [],
        });
        assert.deepEqual(native.updatedInput.answers, {
          environments: "Desktop, Windows, Mobile",
        });
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
  await run;
});

test("Claude's ExitPlanMode without plan text reads this session's proposal", async (t) => {
  await mkdir(".local", { recursive: true });
  const dataDir = await mkdtemp(resolve(".local/sdk-plan-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const requests = [];
  let approved = 0;
  const { run } = fakeClaude(
    {
      mode: "plan",
      text: "Propose the change",
      dataDir,
      chat: { id: "plan-fixture" },
      approve: async (request) => {
        requests.push(request);
        return { allow: true };
      },
      planApproved: () => approved++,
    },
    async (options) => {
      assert.equal(
        options.settings.plansDirectory,
        join(dataDir, "plans", "claude", "plan-fixture"),
      );
      await writeFile(
        join(options.settings.plansDirectory, "proposal.md"),
        "# The complete proposal\n\nBuild and verify it.",
      );
      const decision = await options.canUseTool("ExitPlanMode", {});
      assert.equal(decision.behavior, "allow");
    },
  );
  await run;
  assert.equal(approved, 1);
  assert.match(requests[0].plan, /The complete proposal/);
});

test("a Claude goal leaves plan mode without leaving Goal", async () => {
  let approved = 0,
    decision;
  const { run } = fakeClaude(
    {
      text: "All tests pass",
      mode: "goal",
      permissions: "auto",
      approve: async () => ({ allow: true }),
      planApproved: () => approved++,
    },
    async (options) => {
      decision = await options.canUseTool("ExitPlanMode", {
        plan: "1. Add a cache",
      });
    },
  );
  assert.equal((await run).status, "completed");
  assert.equal(approved, 0);
  assert.equal(decision.behavior, "allow");
  assert.deepEqual(decision.updatedPermissions, [
    { type: "setMode", mode: "auto", destination: "session" },
  ]);
});

test("Claude includes a Goal decline reason with the instruction not to retry", async () => {
  let decision;
  const { run } = fakeClaude(
    {
      text: "Keep going",
      mode: "goal",
      approve: async () => ({
        allow: false,
        reason:
          "Goal mode declined this because it needs you. Continue without it.",
      }),
    },
    async (options) => {
      decision = await options.canUseTool("Bash", { command: "git push" });
    },
  );
  await run;
  assert.equal(decision.behavior, "deny");
  assert.match(decision.message, /Goal mode declined this/);
  assert.match(decision.message, /Do not retry this action/);
});

test("a Claude goal is set with /goal, and its hand-off stays in the user message", async () => {
  const { run, seen } = fakeClaude({
    text: "All tests in test/auth pass",
    mode: "goal",
    handoff: "Earlier work from Codex",
    approve: async () => ({ allow: true }),
  });
  await run;
  assert.match(seen.message, /Earlier work from Codex/);
  assert.match(seen.message, /\/goal All tests in test\/auth pass/);
  assert.doesNotMatch(
    seen.options.systemPrompt.append,
    /Earlier work from Codex/,
  );
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
  assert.equal(
    seen.message,
    "Latest message for this Goal:\nContinue the current task without repeating completed actions\n\n/goal The parser tests pass",
  );
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
  // Every tool is offered; Ask refuses a change when it is called.
  for (const name of ["land_changes", "run_command", "history_search"])
    assert.equal(
      seen.tools.some((tool) => tool.name === name),
      true,
    );
  assert.deepEqual(await seen.history("run_command", { command: "echo" }), {
    error: ASK_DENY,
  });
  assert.deepEqual(await seen.history("land_changes", {}), {
    error: ASK_DENY,
  });
  // Answering a question leaves the chat in ask mode.
  assert.equal(store.conversation(chat.id).mode, "ask");
  store.close();
});

test("ask mode allows read tools and refuses anything that can change the project", () => {
  const names = [
    "history_search",
    "rename_chat",
    "delegate_read",
    "delegate_locate",
    "delegate_edit",
    "delegate_run",
    "delegate_draft",
    "land_changes",
    "run_command",
    "restart_harness",
  ];
  assert.deepEqual(names.filter(askHostAllowed), [
    "history_search",
    "rename_chat",
    "delegate_read",
    "delegate_locate",
  ]);
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
        {
          name: "browser",
          description: "Drive the shared Chrome.",
          inputSchema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["browser_snapshot"] },
            },
            required: ["action"],
          },
        },
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
        "mcp__harness__browser",
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
  assert.equal(decisions["mcp__harness__browser"].behavior, "allow");
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

// A stand-in Cursor session. The first prompt raises create_plan and waits
// until Harness answers it, then later prompts run to completion.
function fakeCursor(onPlan) {
  const calls = [],
    responses = [],
    handlers = [];
  let release = null;
  const rpc = {
    closed: false,
    promptCapabilities: {},
    on(event, fn) {
      if (event === "request") handlers.push(fn);
    },
    notify() {},
    close() {
      this.closed = true;
    },
    reject(id, message) {
      responses.push({ id, error: message });
      release?.();
      release = null;
    },
    respond(id, result) {
      responses.push({ id, result });
      release?.();
      release = null;
    },
    async call(method, params) {
      calls.push({ method, params });
      if (method === "session/new")
        return {
          sessionId: "session-1",
          models: { availableModels: [{ modelId: "m", name: "Fixture" }] },
          configOptions: [{ id: "model", currentValue: "m" }],
        };
      const promptCount = calls.filter(
        (call) => call.method === "session/prompt",
      ).length;
      if (method === "session/prompt" && promptCount === 1) {
        queueMicrotask(() => {
          for (const fn of handlers) fn(onPlan());
        });
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return method === "session/prompt" ? { stopReason: "end_turn" } : {};
    },
  };
  return { rpc, calls, responses };
}

async function runCursorPlan(mode, allow, reason) {
  const { rpc, calls, responses } = fakeCursor(() => ({
    id: "plan-1",
    method: "cursor/create_plan",
    params: { name: "Cache", plan: "1. Add a cache", overview: "Cache it" },
  }));
  const requests = [];
  let approved = 0;
  const result = await runCursor(
    {
      project: { path: process.cwd() },
      signal: new AbortController().signal,
      emit() {},
      saveSession() {},
      text: "Plan the parser",
      model: "m",
      mode,
      billingConfirmation: { fingerprint: "fixture", disabled: true },
      approve: async (request) => {
        requests.push(request);
        return { allow, reason };
      },
      planApproved: () => approved++,
    },
    {
      cursorAuth: async () => ({ connected: true, fingerprint: "fixture" }),
      openCursor: async () => rpc,
    },
  );
  return { result, calls, responses, requests, approved };
}

function promptTexts(calls) {
  return calls
    .filter((call) => call.method === "session/prompt")
    .map((call) => call.params.prompt.map((block) => block.text).join("\n"));
}

test("confirming a Cursor plan leaves plan mode and builds once", async () => {
  const { result, calls, responses, requests, approved } = await runCursorPlan(
    "plan",
    true,
  );
  assert.equal(result.status, "completed");
  assert.equal(requests[0].kind, "plan");
  assert.equal(requests[0].plan, "1. Add a cache");
  assert.equal(approved, 1);
  assert.deepEqual(
    calls
      .filter((call) => call.method === "session/set_mode")
      .map((call) => call.params.modeId),
    ["plan", "agent"],
  );
  const prompts = promptTexts(calls);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1], "Implement the plan.");
  assert.equal(responses[0].result.outcome.outcome, "accepted");
});

test("declining a Cursor plan stays in plan mode and does not build", async () => {
  const { result, calls, responses, requests, approved } = await runCursorPlan(
    "plan",
    false,
    "Include cache invalidation.\nTest expiry.",
  );
  assert.equal(result.status, "completed");
  assert.equal(requests[0].kind, "plan");
  assert.equal(approved, 0);
  assert.deepEqual(
    calls
      .filter((call) => call.method === "session/set_mode")
      .map((call) => call.params.modeId),
    ["plan"],
  );
  assert.equal(promptTexts(calls).length, 1);
  assert.equal(responses[0].result.outcome.outcome, "rejected");
  assert.equal(
    responses[0].result.outcome.reason,
    planRevisionRequest("Include cache invalidation.\nTest expiry."),
  );
});

test("a Cursor plan outside plan mode stays a permission and does not build", async () => {
  const { calls, responses, requests, approved } = await runCursorPlan(
    "default",
    true,
  );
  assert.equal(requests[0].kind, "permission");
  assert.equal(approved, 0);
  assert.deepEqual(
    calls
      .filter((call) => call.method === "session/set_mode")
      .map((call) => call.params.modeId),
    ["agent"],
  );
  assert.equal(promptTexts(calls).length, 1);
  assert.equal(responses[0].result.outcome.outcome, "accepted");
});
