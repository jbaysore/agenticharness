import test from "node:test";
import assert from "node:assert/strict";
import { progressToken, toolBridgeTimeoutMs } from "../src/core/tool-bridge.mjs";
import { CLAUDE_SESSION_SETTINGS } from "../src/providers/claude.mjs";

test("a question or mode suggestion is not closed by the history bridge", () => {
  assert.equal(toolBridgeTimeoutMs("ask_user"), null);
  assert.equal(toolBridgeTimeoutMs("suggest_mode"), null);
  assert.equal(toolBridgeTimeoutMs("browser"), 15 * 60 * 1000);
  assert.equal(toolBridgeTimeoutMs("land_changes"), 15 * 60 * 1000);
  assert.equal(toolBridgeTimeoutMs("history_search"), 15_000);
  assert.equal(toolBridgeTimeoutMs(undefined), 15_000);
});

test("progress updates use only the token the client sent", () => {
  assert.equal(progressToken({ params: { _meta: { progressToken: "q" } } }), "q");
  assert.equal(progressToken({ _meta: { progressToken: 4 } }), 4);
  assert.equal(progressToken({ params: { _meta: { progressToken: "" } } }), null);
  assert.equal(progressToken({ params: {} }), null);
  assert.equal(progressToken(null), null);
});

test("Claude is told not to expire a question or dialog on its own clock", () => {
  assert.equal(CLAUDE_SESSION_SETTINGS.askUserQuestionTimeout, "never");
  assert.equal(CLAUDE_SESSION_SETTINGS.dialogExpiry, "never");
});
