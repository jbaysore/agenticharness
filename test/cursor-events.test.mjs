import test from "node:test";
import assert from "node:assert/strict";
import {
  configureCursorModel,
  cursorConfigDrift,
  cursorModels,
  cursorSpeedFollowUp,
  cursorWorkKind,
} from "../src/providers/cursor.mjs";
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
