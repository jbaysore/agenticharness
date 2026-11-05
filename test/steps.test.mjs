import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWork,
  buildSteps,
  interleave,
  presentTense,
  settle,
  activityLabel,
} from "../src/core/steps.mjs";

const codex = (method, item) => ({ kind: "tool", provider: "codex", method, item });

test("Codex commands and file changes become read, run and edit steps", () => {
  const read = {
    type: "commandExecution",
    id: "a",
    command: "pwsh -Command Get-Content src/title.mjs",
    commandActions: [{ type: "read", command: "Get-Content src/title.mjs", name: "title.mjs", path: "src/title.mjs" }],
    status: "inProgress",
  };
  const build = {
    type: "commandExecution",
    id: "b",
    command: "pwsh -Command npm run build",
    commandActions: [{ type: "unknown", command: "npm run build" }],
    status: "inProgress",
  };
  const steps = buildSteps([
    codex("item/started", read),
    codex("item/completed", { ...read, status: "completed", exitCode: 0, durationMs: 40 }),
    codex("item/started", build),
    { kind: "command-output", itemId: "b", delta: "building" },
    codex("item/completed", { ...build, status: "completed", exitCode: 1, durationMs: 4100 }),
    codex("item/completed", {
      type: "fileChange",
      id: "c",
      status: "completed",
      changes: [{ path: "src/ui/chat-pane.jsx", kind: { type: "update" }, diff: "@@\n-old\n-older\n+new\n context" }],
    }),
  ]);
  assert.deepEqual(
    steps.map(({ verb, target, status }) => [verb, target, status]),
    [
      ["read", "title.mjs", "ok"],
      ["run", "npm run build", "failed"],
      ["edit", "chat-pane.jsx", "ok"],
    ],
  );
  assert.equal(steps[1].ms, 4100);
  assert.deepEqual([steps[2].added, steps[2].removed], [1, 2]);
});

test("Codex subagents, history searches and browser calls are named", () => {
  const steps = buildSteps([
    codex("item/started", { type: "subAgentActivity", id: "x", kind: "started", agentThreadId: "t1", agentPath: "/root/explain_fallback" }),
    codex("item/completed", { type: "dynamicToolCall", id: "h", tool: "history_search", arguments: { query: "issueTitle" }, status: "completed", success: true }),
    codex("item/completed", { type: "mcpToolCall", id: "m", server: "playwright", tool: "browser_click", arguments: {}, status: "completed" }),
    { kind: "native-subagent", provider: "codex", method: "thread/status/changed", status: { type: "idle" } },
    codex("item/completed", { type: "subAgentActivity", id: "y", kind: "completed", agentThreadId: "t1", agentPath: "/root/explain_fallback" }),
  ]);
  assert.deepEqual(
    steps.map(({ verb, target, status }) => [verb, target, status]),
    [
      ["subagent", "explain_fallback", "ok"],
      ["search", "history: issueTitle", "ok"],
      ["browse", "playwright browser_click", "ok"],
    ],
  );
});

test("Claude tool calls resolve by their result, and subagent internals stay out", () => {
  const tool = (id, name, input) => ({ kind: "tool", provider: "claude", item: { type: "tool_use", id, name, input } });
  const steps = buildSteps([
    tool("r", "Read", { file_path: "C:\\repo\\title.mjs" }),
    tool("e", "Edit", { file_path: "C:\\repo\\title.mjs", old_string: "a\nb", new_string: "a\nc\nd" }),
    tool("b", "Bash", { command: "npm test", description: "Run the tests" }),
    { kind: "tool-result", provider: "claude", toolUseId: "r", item: { type: "text" } },
    { kind: "tool-result", provider: "claude", toolUseId: "e", item: {} },
    { kind: "tool-result", provider: "claude", toolUseId: "b", isError: true, item: "Error: exit 1" },
    { kind: "tool", provider: "claude", parentId: "agent", item: { type: "tool_use", id: "inner", name: "Read", input: {} } },
  ]);
  assert.deepEqual(
    steps.map(({ verb, target, status }) => [verb, target, status]),
    [
      ["read", "title.mjs", "ok"],
      ["edit", "title.mjs", "ok"],
      ["run", "npm test", "failed"],
    ],
  );
  assert.deepEqual([steps[1].added, steps[1].removed], [2, 1]);
});

test("Older Claude results without an ID settle the oldest open step", () => {
  let steps = buildSteps([
    { kind: "tool", provider: "claude", item: { type: "tool_use", id: "1", name: "Grep", input: { pattern: "issueTitle" } } },
    { kind: "tool", provider: "claude", item: { type: "tool_use", id: "2", name: "Read", input: { file_path: "a.mjs" } } },
    { kind: "tool-result", provider: "claude", item: "Error: Tool permission request failed" },
  ]);
  assert.deepEqual(steps.map((s) => s.status), ["failed", "running"]);
  assert.deepEqual(settle(steps).map((s) => s.status), ["failed", "ok"]);
});

test("Cursor tool calls merge their updates", () => {
  const call = (item, kind = "tool_call") => ({ kind, provider: "cursor", item: { toolCallId: "t", ...item } });
  const steps = buildSteps([
    call({ sessionUpdate: "tool_call", title: "Edit File", kind: "edit", status: "pending", rawInput: {} }),
    call({ sessionUpdate: "tool_call_update", title: "Edit `C:\\repo\\title.test.mjs`", locations: [{ path: "C:\\repo\\title.test.mjs" }], content: [{ type: "diff", path: "x", oldText: "a", newText: "a\nb" }] }, "tool_call_update"),
    call({ sessionUpdate: "tool_call_update", status: "completed" }, "tool_call_update"),
    { kind: "tool_call", provider: "cursor", item: { sessionUpdate: "tool_call", toolCallId: "u", title: "`git status --short`", kind: "execute", status: "pending", rawInput: { command: "git status --short" } } },
  ]);
  assert.deepEqual(
    steps.map(({ verb, target, status }) => [verb, target, status]),
    [
      ["edit", "title.test.mjs", "ok"],
      ["run", "git status --short", "running"],
    ],
  );
  assert.equal(steps[0].added, 1);
  assert.equal(presentTense(steps[1]), "Running git status --short");
});

test("A summary counts files created, files edited, and commands run", () => {
  assert.equal(
    activityLabel([
      { verb: "read", target: "a.mjs", status: "ok" },
      { verb: "read", target: "b.mjs", status: "ok" },
      { verb: "edit", target: "a.mjs", status: "ok", added: 3, removed: 7 },
      { verb: "run", target: "npm run build", status: "failed" },
      { verb: "run", target: "npm test", status: "running" },
    ]),
    "Edited 1 File, Ran 2 Commands",
  );
  assert.equal(activityLabel([{ verb: "search", target: "title" }]), "");
  assert.equal(applyWork([], null).length, 0);
});

test("Creates, edits, and deletes count as unique files", () => {
  const tool = (id, name, input) => ({ kind: "tool", provider: "claude", item: { type: "tool_use", id, name, input } });
  const steps = buildSteps([
    tool("w", "Write", { file_path: "C:\\repo\\new.mjs", content: "a\nb" }),
    tool("e", "Edit", { file_path: "C:\\repo\\new.mjs", old_string: "a", new_string: "c" }),
    tool("o", "Edit", { file_path: "C:\\repo\\old.mjs", old_string: "a", new_string: "b" }),
    tool("b", "Bash", { command: "npm test" }),
    codex("item/completed", {
      type: "fileChange",
      id: "c",
      status: "completed",
      changes: [
        { path: "src/added.mjs", kind: { type: "add" }, diff: "@@\n+new" },
        { path: "src/gone.mjs", kind: { type: "delete" }, diff: "@@\n-old" },
        { path: "src/old.mjs", kind: { type: "update" }, diff: "@@\n-a\n+b" },
      ],
    }),
  ]);
  assert.equal(activityLabel(steps), "Created 2 Files, Edited 1 File, Ran 1 Command");
});

test("A Cursor write stays created when a later update has no title", () => {
  const call = (item, kind = "tool_call") => ({ kind, provider: "cursor", item: { toolCallId: "w", ...item } });
  const steps = buildSteps([
    call({ title: "Write `src/new.mjs`", kind: "edit", status: "pending", locations: [{ path: "src/new.mjs" }] }),
    call({ status: "completed" }, "tool_call_update"),
    call({ toolCallId: "d", title: "Delete `src/old.mjs`", kind: "delete", status: "completed", locations: [{ path: "src/old.mjs" }] }),
  ]);
  assert.equal(steps[0].fileActions[0].action, "create");
  assert.equal(steps[1].fileActions[0].action, "delete");
  assert.equal(activityLabel(steps), "Created 1 File");
});

test("Steps are placed after the reply they followed", () => {
  const read = (id) => ({ kind: "tool", provider: "claude", item: { type: "tool_use", id, name: "Read", input: { file_path: `src/${id}.mjs` } } });
  const steps = buildSteps([
    { type: "work", payload: read("a") },
    { type: "text", payload: { messageId: "m1" } },
    { type: "work", payload: read("b") },
    { type: "work", payload: read("c") },
    { type: "text", payload: { messageId: "m2" } },
  ]);
  assert.deepEqual(steps.map((s) => [s.target, s.after]), [["a.mjs", null], ["b.mjs", "m1"], ["c.mjs", "m1"]]);
  const parts = interleave([{ id: "m1" }, { id: "m2" }], steps);
  assert.deepEqual(
    parts.map((p) => [p.message?.id ?? null, p.steps.map((s) => s.target)]),
    [[null, ["a.mjs"]], ["m1", ["b.mjs", "c.mjs"]], ["m2", []]],
  );
  // A later status update keeps the step where it first appeared.
  const done = applyWork(steps, { kind: "tool-result", provider: "claude", toolUseId: "b" }, "m2");
  assert.equal(done[1].after, "m1");
});
