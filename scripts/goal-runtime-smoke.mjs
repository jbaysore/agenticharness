// Explicit, bounded subscription-only smoke; not part of the offline test suite.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { runClaude } from "../src/providers/claude.mjs";

const dir = await mkdtemp(join(tmpdir(), "harness-goal-smoke-"));
const store = new Store(":memory:"), controller = new Controller(store, {});
let nativeResults = 0, progressCalls = 0, completionCalls = 0;
controller.providers = [{ id: "claude", models: [{ id: "opus", efforts: [] }] }];
controller.runners.claude = (ctx) => {
  const history = ctx.history;
  return runClaude({ ...ctx,
    approve: async () => ({ allow: false, reason: "This smoke test permits only Goal reporting tools." }),
    history: async (name, args) => {
      if (name === "update_goal_progress") progressCalls++;
      else if (name === "complete_goal") {
        if (!nativeResults) return { error: "Finish the first checkpoint reply before completing this two-turn test." };
        completionCalls++;
      } else return { error: "Only update_goal_progress and complete_goal are needed in this smoke test." };
      return history(name, args);
    },
  }, { queryFn: (args) => {
    const q = query(args);
    return new Proxy(q, { get(target, key) {
      if (key === Symbol.asyncIterator) return async function* () {
        for await (const event of target) {
          if (event.type === "result") nativeResults++;
          yield event;
        }
      };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } });
};
const chat = store.createConversation({ projectId: store.addProject("Goal smoke", dir, { scratch: true }).id,
  title: "Goal runtime smoke", provider: "claude", model: "opus", mode: "goal" });
const timeout = setTimeout(() => controller.active.get(chat.id)?.abort.abort({ kind: "smoke-timeout" }), 120000);
try {
  const run = controller.send(chat.id, { actionId: crypto.randomUUID(), provider: "claude", model: "opus", text:
    "Validate the Harness Goal runtime using only its own progress/completion tools. Record two phases: First turn, Continuation verification. On your first turn set First turn completed and Continuation verification pending and reply exactly HARNESS_CHECKPOINT without calling complete_goal. When Harness sends the next continuation, mark both phases complete, call complete_goal with evidence that you received that continuation, and reply exactly HARNESS_GOAL_SMOKE_DONE. Do not run commands, browse, use subagents, read files, or edit anything." });
  await controller.active.get(chat.id).task;
  assert.equal(store.run(run.id).status, "completed", store.run(run.id).error);
  const progress = store.conversation(chat.id).goalProgress;
  assert.equal(progress.status, "complete");
  assert.equal(progress.phases.length, 2);
  assert.ok(progress.phases.every((p) => p.status === "completed"));
  assert.ok(nativeResults >= 2);
  assert.ok(progressCalls >= 2);
  assert.equal(completionCalls, 1);
  console.log(JSON.stringify({ passed: true, nativeResults, progressCalls, completionCalls, phases: progress.phases.length }));
} finally {
  clearTimeout(timeout);
  await controller.close(); store.close();
  await rm(dir, { recursive: true, force: true });
}
