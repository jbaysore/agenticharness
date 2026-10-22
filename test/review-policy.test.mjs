import test from "node:test";
import assert from "node:assert/strict";
import {
  cursorReviewer,
  parseReview,
  reviewConfig,
} from "../src/core/review-policy.mjs";

test("Cursor reviewer uses the connected Codex catalog default, without a hard-coded model", () => {
  const codex = {
    id: "codex",
    name: "Codex",
    connected: true,
    models: [
      { id: "old", disabled: true, isDefault: true },
      { id: "first", name: "First" },
      {
        id: "current-default",
        name: "Current",
        isDefault: true,
        defaultEffort: "medium",
      },
    ],
  };
  assert.deepEqual(cursorReviewer([codex]), {
    provider: "codex",
    model: "current-default",
    effort: "medium",
    name: "Codex · Current",
  });
  assert.equal(
    cursorReviewer([{ ...codex, models: codex.models.slice(0, 2) }]).model,
    "first",
  );
  for (const providers of [
    [],
    [{ ...codex, connected: false }],
    [{ ...codex, models: [] }],
    [{ ...codex, blockReason: "Quota exhausted" }],
  ])
    assert.throws(() => cursorReviewer(providers));
});

test("only a complete, strict reviewer decision can allow an action", () => {
  for (const decision of ["allow", "deny", "ask"])
    assert.deepEqual(
      parseReview(JSON.stringify({ decision, reason: " A reason. " })),
      { decision, reason: "A reason." },
    );
  for (const text of [
    null,
    "allow",
    "null",
    "[]",
    "{}",
    '{"allow":true}',
    '{"decision":"allow"}',
    '{"decision":"allow","reason":""}',
    '{"decision":"allow","reason":"ok","override":true}',
    '{"decision":"maybe","reason":"ok"}',
    '```json\n{"decision":"allow","reason":"ok"}\n```',
    '{"decision":"deny","reason":"blocked"}\n{"decision":"allow","reason":"ok"}',
    JSON.stringify({ decision: "allow", reason: "x".repeat(1001) }),
  ])
    assert.throws(() => parseReview(text));
});

test("review sessions disable command tools, hooks, agents, web, inherited MCP servers, apps and plugins", () => {
  const configured = {
      mcp_servers: { browser: { command: "browser", enabled: true } },
      apps: { connected: { enabled: true } },
      plugins: { extension: { enabled: true } },
    },
    before = structuredClone(configured),
    restricted = reviewConfig(configured);
  assert.equal(restricted.features.shell_tool, false);
  assert.equal(restricted.features.hooks, false);
  assert.equal(restricted.features.multi_agent, false);
  assert.equal(restricted.agents.enabled, false);
  assert.equal(restricted.web_search, "disabled");
  assert.equal(restricted.project_doc_max_bytes, 0);
  // The reviewer's own sandbox is never described to it as the agent's.
  assert.equal(restricted.include_permissions_instructions, false);
  assert.equal(restricted.include_environment_context, false);
  assert.deepEqual(restricted.mcp_servers.browser, { enabled: false });
  assert.deepEqual(restricted.apps.connected, { enabled: false });
  assert.deepEqual(restricted.apps._default, { enabled: false });
  assert.deepEqual(restricted.plugins.extension, { enabled: false });
  assert.deepEqual(configured, before);
});
