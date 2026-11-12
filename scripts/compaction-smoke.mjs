// Explicit, bounded subscription-only smoke; not part of the offline test suite.
// A manual /compact on a tiny Claude session runs the real PreCompact,
// SessionStart(compact) and PostCompact hooks without filling a window.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../src/core/queue.mjs";
import { claudeOptions, compactionHooks, inspectClaude } from "../src/providers/claude.mjs";
import { COMPACTION_GUIDANCE } from "../src/core/compaction.mjs";

const model = process.argv[2] ?? "haiku";
const provider = await inspectClaude();
if (!provider.connected || provider.blockReason)
  throw new Error(provider.blockReason ?? "Claude Code is not connected.");

const dir = await mkdtemp(join(tmpdir(), "harness-compaction-smoke-"));
const seen = { preCompact: 0, sessionStartCompact: 0, summary: "", boundary: 0, answers: [] };
const ctx = { mode: "goal", goalCheckpoint: async () => "Harness Goal checkpoint (smoke). Goal ID: SMOKE-GOAL-42. Phases: - [in_progress] Verify compaction." };
const hooks = compactionHooks(ctx, () => ({ compactSummary: (text) => { seen.summary = text; } }));
const wrap = (name, after) => [{ hooks: [async (event, ...rest) => {
  const result = await hooks[name][0].hooks[0](event, ...rest);
  return after(event, result);
}] }];
const input = new AsyncQueue();
const say = (text) => input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
const base = claudeOptions(dir);
const q = query({
  prompt: input,
  options: {
    ...base,
    model,
    tools: [],
    permissionMode: "default",
    canUseTool: async () => ({ behavior: "deny", message: "No tools in this smoke test." }),
    hooks: {
      PreCompact: wrap("PreCompact", (event, result) => {
        if (!event.agent_id) seen.preCompact++;
        assert.equal(result.systemMessage, COMPACTION_GUIDANCE);
        return { systemMessage: result.systemMessage + "\nAlso write the token PRECOMPACT-MARKER-7 verbatim in the summary." };
      }),
      SessionStart: wrap("SessionStart", (event, result) => {
        if (event.source === "compact" && result.hookSpecificOutput) seen.sessionStartCompact++;
        return result;
      }),
      PostCompact: hooks.PostCompact,
    },
  },
});
const timeout = setTimeout(() => q.interrupt?.().catch(() => {}), 240000);
try {
  const steps = [
    "Remember the word HARNESS-PELICAN. Reply exactly OK.",
    "/compact",
    "Reply with only the Goal ID from the Harness Goal checkpoint, then the word you were asked to remember.",
  ];
  say(steps.shift());
  for await (const event of q) {
    if (event.type === "system" && event.subtype === "compact_boundary" && !event.parent_tool_use_id) seen.boundary++;
    if (event.type !== "result") continue;
    if (typeof event.result === "string" && event.result.trim()) seen.answers.push(event.result.trim());
    if (!steps.length) break;
    say(steps.shift());
  }
  input.close?.();
  const last = seen.answers.at(-1) ?? "";
  console.log(JSON.stringify({ ...seen, summary: seen.summary.slice(0, 600) }, null, 2));
  assert.equal(seen.preCompact, 1, "PreCompact ran for the root session");
  assert.equal(seen.boundary, 1, "compaction produced a boundary");
  assert.ok(seen.summary, "PostCompact delivered the provider's summary");
  assert.match(seen.summary, /PRECOMPACT-MARKER-7/, "PreCompact systemMessage reached the summary instructions");
  assert.equal(seen.sessionStartCompact, 1, "SessionStart(compact) returned the checkpoint");
  assert.match(last, /SMOKE-GOAL-42/, "the model saw the checkpoint after compaction");
  console.log("Compaction smoke passed.");
} finally {
  clearTimeout(timeout);
  q.close?.();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
