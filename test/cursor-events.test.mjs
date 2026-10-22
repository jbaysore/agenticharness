import test from "node:test";
import assert from "node:assert/strict";
import {
  configureCursorModel,
  cursorConfigDrift,
  cursorMessageIds,
  cursorModels,
  cursorQuestionOutcome,
  cursorSpeedFollowUp,
  cursorWorkKind,
  isHarnessTool,
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
