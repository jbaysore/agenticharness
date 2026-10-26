import test from "node:test";
import assert from "node:assert/strict";
import {
  configureCursorModel,
  cursorConfigDrift,
  cursorMessageIds,
  configureCursorEffort,
  learnCursorEfforts,
  cursorModels,
  cursorQuestionOutcome,
  cursorSpeedFollowUp,
  cursorStreamDropped,
  cursorWorkKind,
  isHarnessTool,
  runCursor,
} from "../src/providers/cursor.mjs";

test("Harness's own history and browser tools skip Cursor's prompt; other requests do not", () => {
  const tools = [
      { name: "history_search" },
      { name: "browser_click" },
      { name: "land_changes" },
    ],
    call = (title, kind = "other") => ({ title, kind });
  assert.equal(
    isHarnessTool(
      call("harness-history-history_search: history_search"),
      tools,
    ),
    true,
  );
  assert.equal(
    isHarnessTool(call("harness-history-browser_click: browser_click"), tools),
    true,
  );
  for (const toolCall of [
    // Landing changes is still reviewed.
    call("harness-history-land_changes: land_changes"),
    // A browser tool Harness is not offering this turn.
    call("harness-history-browser_tabs: browser_tabs"),
    // Mismatched names, other kinds and shell commands.
    call("harness-history-history_search: browser_click"),
    call("harness-history-history_search: history_search", "execute"),
    call("`harness-history-history_search: history_search`", "execute"),
    call("other-server-history_search: history_search"),
    null,
  ])
    assert.equal(isHarnessTool(toolCall, tools), false);
});

test("Cursor question answers preserve selected IDs, custom responses, and cancellation", () => {
  const questions = [
    {
      id: "approach",
      prompt: "Which approach?",
      options: [
        { id: "a", label: "Focused update" },
        { id: "b", label: "Redesign" },
      ],
    },
    {
      id: "checks",
      prompt: "Which checks?",
      options: [{ id: "unit", label: "Unit checks" }],
    },
  ];
  assert.deepEqual(
    cursorQuestionOutcome(questions, {
      allow: true,
      answers: { approach: ["a", "b"], checks: "Unit checks" },
    }),
    {
      outcome: "answered",
      answers: [
        { questionId: "approach", selectedOptionIds: ["a", "b"] },
        { questionId: "checks", selectedOptionIds: ["unit"] },
      ],
    },
  );
  const custom = cursorQuestionOutcome(questions, {
    allow: true,
    answers: {
      approach: "An accessibility pass",
      checks: ["unit", "Mobile review"],
    },
  });
  assert.equal(custom.outcome, "skipped");
  assert.match(custom.reason, /Which approach\?: An accessibility pass/);
  assert.match(custom.reason, /Which checks\?: Unit checks, Mobile review/);
  assert.deepEqual(
    cursorQuestionOutcome(questions, {
      allow: false,
      answers: { approach: "a", checks: "unit" },
    }),
    { outcome: "cancelled" },
  );
  assert.deepEqual(
    cursorQuestionOutcome(questions, {
      allow: true,
      answers: { approach: "a" },
    }),
    { outcome: "cancelled" },
  );
  assert.deepEqual(cursorQuestionOutcome([], { allow: true }), {
    outcome: "cancelled",
  });
});
test("Cursor task lifecycle stays labeled as native delegation when updates omit its name", () => {
  const ids = new Set();
  assert.equal(
    cursorWorkKind(
      {
        sessionUpdate: "tool_call",
        toolCallId: "task1",
        title: "Task: Read-only review",
        rawInput: { _toolName: "task" },
      },
      ids,
    ),
    "native-subagent",
  );
  assert.equal(
    cursorWorkKind(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "task1",
        status: "in_progress",
      },
      ids,
    ),
    "native-subagent",
  );
  assert.equal(
    cursorWorkKind(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "task1",
        status: "completed",
      },
      ids,
    ),
    "native-subagent",
  );
  assert.equal(
    cursorWorkKind(
      { sessionUpdate: "tool_call", toolCallId: "read1", kind: "read" },
      ids,
    ),
    "tool_call",
  );
});

test("Cursor native models stay selectable when ACP returns bare ids", () => {
  const models = cursorModels({
    models: {
      availableModels: [
        { modelId: "default", name: "Auto" },
        { modelId: "composer-2.5", name: "Composer 2.5" },
        { modelId: "grok-4.7", name: "Grok 4.7" },
        {
          modelId: "claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
        },
        {
          modelId: "composer-2.5[fast=true]",
          name: "Composer 2.5 Fast",
        },
      ],
    },
  });
  const byId = Object.fromEntries(models.map((model) => [model.id, model]));
  assert.equal(byId["composer-2.5"].disabled, false);
  assert.equal(byId["grok-4.7"].disabled, false);
  assert.equal(byId["claude-sonnet-5-5"].disabled, false);
  assert.equal(byId["claude-sonnet-5-5"].isDefault, false);
  assert.equal(byId.default, undefined);
  assert.equal(byId["composer-2.5[fast=true]"].disabled, true);
});

test("Cursor standard speed is applied only when Fast is offered", () => {
  const fastOn = [
    { id: "model", currentValue: "composer-2.5" },
    {
      id: "fast",
      currentValue: "true",
      options: [{ value: "false" }, { value: "true" }],
    },
  ];
  assert.deepEqual(cursorSpeedFollowUp(fastOn), {
    configId: "fast",
    value: "false",
  });
  assert.equal(
    cursorSpeedFollowUp([{ id: "fast", currentValue: "false" }]),
    null,
  );
  assert.equal(
    cursorSpeedFollowUp([
      { id: "model", currentValue: "claude-sonnet-5-5" },
    ]),
    null,
  );
  assert.equal(
    cursorSpeedFollowUp([{ id: "fast", currentValue: "true", options: [] }])
      .error,
    "Cursor only offers a fast preset for this model",
  );
  assert.equal(
    cursorConfigDrift(
      [{ id: "fast", currentValue: "true" }],
      "composer-2.5",
    ),
    "fast",
  );
  assert.equal(
    cursorConfigDrift(
      [{ id: "model", category: "model", currentValue: "grok-4.7" }],
      "composer-2.5",
    ),
    "model",
  );
  assert.equal(
    cursorConfigDrift(
      [
        { id: "model", currentValue: "composer-2.5" },
        { id: "fast", currentValue: "false" },
      ],
      "composer-2.5",
    ),
    null,
  );
});

test("configuring a native Cursor model confirms standard speed", async () => {
  const calls = [];
  const rpc = {
    async call(_method, params) {
      calls.push([params.configId, params.value]);
      if (params.configId === "model")
        return {
          configOptions: [
            { id: "model", currentValue: params.value },
            {
              id: "fast",
              currentValue: "true",
              options: [{ value: "false" }, { value: "true" }],
            },
          ],
        };
      return {
        configOptions: [
          { id: "model", currentValue: "composer-2.5" },
          { id: "fast", currentValue: params.value },
        ],
      };
    },
  };
  await configureCursorModel(rpc, "session-1", "composer-2.5");
  assert.deepEqual(calls, [
    ["model", "composer-2.5"],
    ["fast", "false"],
  ]);
});

test("a Cursor session already on the model at standard speed is not reconfigured", async () => {
  const rpc = {
    async call() {
      throw new Error("no configuration call expected");
    },
  };
  const current = [
    { id: "model", currentValue: "grok-4.7" },
    { id: "fast", currentValue: "false", options: [{ value: "false" }] },
  ];
  assert.deepEqual(
    await configureCursorModel(rpc, "session-1", "grok-4.7", current),
    { configOptions: current },
  );
  await assert.rejects(
    configureCursorModel(rpc, "session-1", "composer-2.5", current),
    /no configuration call expected/,
  );
});

test("Cursor text either side of a tool call becomes separate messages", () => {
  const id = cursorMessageIds(),
    text = (t) => ({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: t },
    });
  assert.equal(id(text("I'll look.")), "cursor-response-1");
  assert.equal(id(text(" Then edit.")), "cursor-response-1");
  assert.equal(id({ sessionUpdate: "tool_call", toolCallId: "a" }), null);
  assert.equal(
    id({ sessionUpdate: "tool_call_update", toolCallId: "a" }),
    null,
  );
  assert.equal(id(text("Found it.")), "cursor-response-2");
  assert.equal(
    id({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "x" },
    }),
    null,
  );
  assert.equal(id(text(" Done.")), "cursor-response-2");
});

test("Cursor effort levels are learned per model and keep the first default", () => {
  const options = (model, effort, levels = ["low", "medium", "high"]) => [
    { id: "model", currentValue: model },
    ...(levels.length
      ? [
          {
            id: "reasoning_effort",
            currentValue: effort,
            options: levels.map((value) => ({ value })),
          },
        ]
      : []),
  ];
  let known = learnCursorEfforts({}, options("grok-4.7", "high"));
  assert.deepEqual(known, {
    "grok-4.7": { efforts: ["low", "medium", "high"], defaultEffort: "high" },
  });
  // Cursor reports the last level chosen anywhere; the default stays.
  assert.equal(learnCursorEfforts(known, options("grok-4.7", "low")), known);
  known = learnCursorEfforts(known, options("composer-2.5", null, []));
  assert.deepEqual(known["composer-2.5"], { efforts: [], defaultEffort: null });
  const [grok] = cursorModels(
    { models: { availableModels: [{ modelId: "grok-4.7", name: "Grok" }] } },
    known,
  );
  assert.deepEqual(
    [grok.efforts, grok.defaultEffort],
    [["low", "medium", "high"], "high"],
  );
});

test("Cursor effort is set only when it differs, and must be confirmed", async () => {
  const current = [
    { id: "model", currentValue: "grok-4.7" },
    { id: "fast", currentValue: "false" },
    {
      id: "reasoning_effort",
      currentValue: "high",
      options: [{ value: "low" }, { value: "high" }],
    },
  ];
  const calls = [];
  const rpc = (confirm) => ({
    async call(_method, params) {
      calls.push(params.value);
      return {
        configOptions: current.map((o) =>
          o.id === "reasoning_effort" ? { ...o, currentValue: confirm } : o,
        ),
      };
    },
  });
  await configureCursorEffort(rpc("low"), "s", current, "high");
  await configureCursorEffort(rpc("low"), "s", current, null);
  assert.deepEqual(calls, []);
  await configureCursorEffort(rpc("low"), "s", current, "low");
  assert.deepEqual(calls, ["low"]);
  await assert.rejects(
    configureCursorEffort(rpc("high"), "s", current, "low"),
    /did not confirm/,
  );
  await assert.rejects(
    configureCursorEffort(rpc("low"), "s", current, "xhigh"),
    /does not offer/,
  );
  // A model without effort levels ignores the setting.
  await configureCursorEffort(rpc("low"), "s", current.slice(0, 2), "low");
});

const dropText =
  "\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)";

test("Cursor's retriable stream error is recognised only at the end of a reply", () => {
  assert.equal(cursorStreamDropped("Working on it." + dropText), true);
  assert.equal(cursorStreamDropped(dropText + "\n"), true);
  assert.equal(cursorStreamDropped("All done."), false);
  assert.equal(
    cursorStreamDropped("Earlier I saw" + dropText + "\n\nThen it recovered."),
    false,
  );
});

// Each prompt replies with the next text in `replies`, then ends the turn.
async function runDropping(replies) {
  const calls = [],
    notified = [];
  let onNotification;
  const rpc = {
    closed: false,
    promptCapabilities: {},
    on(event, fn) {
      if (event === "notification") onNotification = fn;
    },
    notify(method) {
      notified.push(method);
    },
    close() {
      this.closed = true;
    },
    async call(method, params) {
      calls.push({ method, params });
      if (method === "session/new")
        return {
          sessionId: "session-1",
          models: { availableModels: [{ modelId: "m", name: "Fixture" }] },
          configOptions: [{ id: "model", currentValue: "m" }],
        };
      if (method !== "session/prompt") return {};
      const text = replies.shift() ?? "Done.";
      onNotification({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      });
      return { stopReason: "end_turn" };
    },
  };
  const result = await runCursor(
    {
      project: { path: process.cwd() },
      signal: new AbortController().signal,
      emit() {},
      saveSession() {},
      text: "Build it",
      model: "m",
      mode: "default",
      billingConfirmation: { fingerprint: "fixture", disabled: true },
      approve: async () => ({ allow: true }),
    },
    {
      cursorAuth: async () => ({ connected: true, fingerprint: "fixture" }),
      openCursor: async () => rpc,
    },
  );
  const prompts = calls
    .filter((call) => call.method === "session/prompt")
    .map((call) => call.params.prompt.map((block) => block.text).join("\n"));
  return { result, prompts, notified };
}

test("a dropped Cursor stream continues the same turn automatically", async () => {
  const { result, prompts, notified } = await runDropping([
    "Editing the sidebar." + dropText,
    "Finished the sidebar.",
  ]);
  assert.equal(result.status, "completed");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /^Continue where you left off/);
  assert.deepEqual(notified, []);
});

test("a Cursor stream that keeps dropping stops after two retries and fails", async () => {
  const { result, prompts } = await runDropping([dropText, dropText, dropText]);
  assert.equal(prompts.length, 3);
  assert.equal(result.status, "failed");
  assert.match(result.error, /connection dropped/);
});
