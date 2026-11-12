import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import {
  CHECKPOINT_MAX,
  CLAUDE_AUTO_COMPACT_WINDOW,
  COMPACTION_GUIDANCE,
  goalCheckpoint,
} from "../src/core/compaction.mjs";
import { claudeOptions, compactionHooks } from "../src/providers/claude.mjs";
import { contextView } from "../src/ui/context.mjs";

test("a Goal checkpoint carries phases, checks, watches, owner waits, repository state and recent asks", () => {
  const text = goalCheckpoint({
    progress: {
      goalId: "goal-1",
      phases: [
        { label: "Find the cause", status: "completed" },
        { label: "Fix it", status: "in_progress" },
      ],
      explanation: "Patch is half done",
    },
    checks: [{ outcome: "failed", command: "npm test", freshness: "Workspace matches" }],
    watches: [{ id: "w1", kind: "ci", status: "pending", label: "main" }],
    ownerPause: { statement: "Sign in to GitHub" },
    repository: { branch: "work", head: "abcdef1234567", changes: [{ status: " M", file: "src/a.mjs" }] },
    feedback: ["one", "two", "three", "four"],
  });
  for (const part of [
    "Goal ID: goal-1",
    "- [completed] Find the cause",
    "- [in_progress] Fix it",
    "Latest progress note: Patch is half done",
    "- failed: npm test (Workspace matches)",
    "- w1 ci pending: main",
    "Waiting on the owner: Sign in to GitHub",
    "Repository: branch work at abcdef1234",
    "- M src/a.mjs",
    "- four",
  ])
    assert.ok(text.includes(part), part);
  assert.ok(!text.includes("- one"));
  assert.match(goalCheckpoint({ repository: { branch: "main", changes: [] } }), /No uncommitted changes/);
});

test("a Goal checkpoint stays within its cap", () => {
  const phases = Array.from({ length: 50 }, (_, i) => ({ label: "x".repeat(400) + i, status: "pending" }));
  const text = goalCheckpoint({ progress: { goalId: "g", phases } });
  assert.ok(text.length <= CHECKPOINT_MAX);
});

test("Claude hooks guide the summary, re-anchor a Goal and keep the summary, for the root only", async () => {
  let summary = null;
  const reporter = { compactSummary: (text) => { summary = text; } };
  const goal = compactionHooks({ mode: "goal", goalCheckpoint: async () => "CHECKPOINT" }, () => reporter);
  const run = (hooks, name, event) => hooks[name][0].hooks[0](event);

  assert.deepEqual(await run(goal, "PreCompact", { trigger: "auto" }), { systemMessage: COMPACTION_GUIDANCE });
  assert.deepEqual(await run(goal, "PreCompact", { trigger: "auto", agent_id: "sub" }), {});

  assert.deepEqual(await run(goal, "SessionStart", { source: "compact" }), {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "CHECKPOINT" },
  });
  for (const event of [{ source: "startup" }, { source: "resume" }, { source: "compact", agent_id: "sub" }])
    assert.deepEqual(await run(goal, "SessionStart", event), {});
  const plain = compactionHooks({ mode: "default", goalCheckpoint: async () => "CHECKPOINT" }, () => reporter);
  assert.deepEqual(await run(plain, "SessionStart", { source: "compact" }), {});
  const failing = compactionHooks({ mode: "goal", goalCheckpoint: async () => { throw new Error("no"); } }, () => reporter);
  assert.deepEqual(await run(failing, "SessionStart", { source: "compact" }), {});

  await run(goal, "PostCompact", { compact_summary: "from a subagent", agent_id: "sub" });
  assert.equal(summary, null);
  await run(goal, "PostCompact", { compact_summary: "kept this" });
  assert.equal(summary, "kept this");
});

test("Claude compacts at the Harness window instead of near the whole 1M window", (t) => {
  let options;
  try { options = claudeOptions(process.cwd()); }
  catch (error) { return t.skip(error.message); }
  assert.equal(options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, String(CLAUDE_AUTO_COMPACT_WINDOW));
  assert.equal(CLAUDE_AUTO_COMPACT_WINDOW, 600000);
});

test("usage warnings follow the provider's compaction point when it reports one", () => {
  const reading = (usedTokens, compactAtTokens) => contextView(
    { model: "m", state: "ready", usedTokens, windowTokens: 1000000, compactAtTokens, accuracy: "provider-estimated" },
    { model: "m" },
  );
  const early = reading(560000, 600000);
  assert.equal(Math.round(early.percent), 56);
  assert.equal(early.compactAt, 600000);
  assert.equal(early.level, "high");
  assert.equal(early.usageWarning.label, "Needs compaction");
  assert.equal(reading(460000, 600000).usageWarning.label, "Costs usage");
  assert.equal(reading(400000, 600000).usageWarning, null);
  const unknown = reading(560000, null);
  assert.equal(unknown.compactAt, null);
  assert.equal(unknown.usageWarning, null);
  assert.equal(reading(950000, 1200000).compactAt, null);
});

test("the provider's compaction summary joins the compaction notice", async () => {
  const store = new Store(":memory:");
  const controller = new Controller(store, { probePath: ".local", bridgeUrl: "http://localhost" });
  try {
    const project = store.addProject("Compaction fixture", process.cwd());
    const chat = store.createConversation({ projectId: project.id, provider: "claude", model: "m" });
    store.updateConversation(chat.id, { sessions: { claude: { id: "native" } } });
    const run = store.createRun({ conversationId: chat.id, actionId: crypto.randomUUID(), provider: "claude", model: "m", text: "x" });
    const context = (patch) => controller.event(chat.id, run.id, "context-usage", {
      provider: "claude", sessionId: "native", model: "m", generation: 0, state: "ready", usedTokens: 1, windowTokens: 10, ...patch,
    });
    context({ generation: 1, state: "compacting" });
    const before = (await controller.reliability.read(chat.id)).notices[0];
    assert.equal(before.summary, undefined);
    context({ generation: 1, state: "compacting", compactSummary: "Kept the objective" });
    context({ generation: 1, usedTokens: 2, compactSummary: "Kept the objective" });
    const view = await controller.reliability.read(chat.id);
    assert.equal(view.compactions, 1);
    assert.equal(view.notices.length, 1);
    assert.equal(view.notices[0].summary, "Kept the objective");
    assert.equal(view.notices[0].eventId, before.eventId);
  } finally {
    store.close();
  }
});

test("Cursor is off unless turned on, and an off Cursor neither lists nor runs", async () => {
  const store = new Store(":memory:");
  const controller = new Controller(store, { probePath: ".local", bridgeUrl: "http://localhost" });
  try {
    assert.equal(controller.cursorEnabled(), false);
    controller.providers = [{ id: "codex", models: [{ id: "m", efforts: [] }] }, { id: "cursor", models: [{ id: "m", efforts: [] }] }];
    assert.deepEqual((await controller.setCursorEnabled(false)).map((p) => p.id), ["codex"]);
    assert.deepEqual((await controller.refreshProvider("cursor")).map((p) => p.id), ["codex"]);
    const project = store.addProject("Cursor fixture", process.cwd());
    const chat = store.createConversation({ projectId: project.id, provider: "cursor", model: "m" });
    assert.throws(
      () => controller.send(chat.id, { actionId: crypto.randomUUID(), text: "hi", provider: "cursor", model: "m" }),
      /Cursor is turned off in Connections/,
    );
    store.setting("cursor-enabled", true);
    assert.equal(controller.cursorUsable(), true);
  } finally {
    store.close();
  }
});
