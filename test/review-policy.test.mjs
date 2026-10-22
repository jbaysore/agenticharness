import test from "node:test";
import assert from "node:assert/strict";
import { agentInstructions } from "../src/core/history.mjs";
import {
  cursorReviewer,
  parseReview,
  readOnlyGitCommand,
  REVIEW_PROMPT,
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

test("the reviewer decides technical actions and asks only for an explained managerial choice", () => {
  assert.match(REVIEW_PROMPT, /cannot judge code or commands better than you/);
  assert.match(
    REVIEW_PROMPT,
    /Do not ask the user to approve a command, script, or code change/,
  );
  assert.match(
    REVIEW_PROMPT,
    /Use ask only when the task leaves a managerial choice/,
  );
  assert.match(REVIEW_PROMPT, /why you cannot make it/);
  assert.doesNotMatch(
    REVIEW_PROMPT,
    /Use ask when the exact action or its authorization is unclear/,
  );
  const instructions = agentInstructions(
    { path: "C:\\repo", repositories: [] },
    { id: "chat", scope: "all" },
  );
  assert.match(instructions, /do not ask the user to judge them/);
  assert.match(instructions, /managerial choice only the user can make/);
  assert.match(instructions, /explain why you cannot decide it/);
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

test("only Cursor requests for read-only Git commands skip the model review", () => {
  const request = (title, kind = "execute") => ({
    kind: "permission",
    method: "session/request_permission",
    title,
    details: { kind, title },
  });
  for (const title of [
    "`git status`",
    "`git status --short; git diff --stat`",
    "`git log -8 --oneline`",
    '`git log -1 --format="%H %s"`',
    "`git diff -- src/ui/app.jsx`",
    "`git status --short && git diff --cached --stat`",
  ])
    assert.equal(readOnlyGitCommand(request(title)), true, title);
  for (const title of [
    "`git add -A`",
    "`git commit -m x`",
    "`git push origin main`",
    "`git branch -D old`",
    "`git -c core.pager=evil log`",
    "`git diff --output=.local/a.patch`",
    "`git diff --ext-diff`",
    "`git diff | node -e x`",
    "`git log > out.txt`",
    "`git status; npm test`",
    "`git log $(rm -rf x)`",
    "`git status & calc`",
    "`git log @args`",
    "`git status`\n`rm x`",
    "git status",
  ])
    assert.equal(readOnlyGitCommand(request(title)), false, title);
  assert.equal(readOnlyGitCommand(request("`git status`", "other")), false);
  assert.equal(
    readOnlyGitCommand({
      ...request("`git status`"),
      method: "cursor/create_plan",
    }),
    false,
  );
});
