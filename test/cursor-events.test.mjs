import test from "node:test";
import assert from "node:assert/strict";
import { cursorWorkKind } from "../src/providers/cursor.mjs";
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
