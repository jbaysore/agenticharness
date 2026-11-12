// Explicit, bounded subscription-only smoke; not part of the offline test suite.
// Compacts a tiny Codex thread on request, hands it a checkpoint through
// thread/inject_items, and checks the next turn can read it.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCodex, openCodex } from "../src/providers/codex.mjs";

const provider = await inspectCodex();
if (!provider.connected || provider.blockReason)
  throw new Error(provider.blockReason ?? "Codex is not connected.");
const models = provider.models.filter((m) => !m.disabled);
const model = process.argv[2] ?? (models.find((m) => /mini/i.test(m.id)) ?? models.find((m) => m.isDefault) ?? models[0]).id;

const dir = await mkdtemp(join(tmpdir(), "harness-codex-compaction-smoke-"));
const abort = new AbortController();
const rpc = await openCodex(dir, { signal: abort.signal, purpose: "smoke" });
const timeout = setTimeout(() => abort.abort(), 240000);
const seen = { compacted: 0, injected: false, answers: [] };
let waiters = [];
rpc.on("notification", ({ method, params }) => {
  if (method === "item/completed" && params.item?.type === "contextCompaction") seen.compacted++;
  if (method === "item/completed" && params.item?.type === "agentMessage") seen.answers.push(params.item.text ?? "");
  for (const w of waiters) w(method, params);
});
const until = (match) => new Promise((resolve) => {
  const w = (method, params) => { if (match(method, params)) { waiters = waiters.filter((x) => x !== w); resolve(params); } };
  waiters.push(w);
});
const turn = async (threadId, text) => {
  const done = until((m) => m === "turn/completed");
  await rpc.call("turn/start", { threadId, model, serviceTierForTurn: "default", input: [{ type: "text", text }] });
  await done;
};
try {
  const { thread } = await rpc.call("thread/start", {
    cwd: dir, model, modelProvider: "openai", serviceTier: "default",
    approvalPolicy: "never", sandbox: "read-only",
    config: { model_provider: "openai", forced_login_method: "chatgpt", service_tier: "default" },
  });
  await turn(thread.id, "Remember the word HARNESS-PELICAN. Reply exactly OK. Do not run commands.");
  const compacted = until((m, p) => m === "item/completed" && p.item?.type === "contextCompaction");
  await rpc.call("thread/compact/start", { threadId: thread.id });
  await compacted;
  await rpc.call("thread/inject_items", { threadId: thread.id, items: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Harness Goal checkpoint (smoke). Goal ID: SMOKE-GOAL-42." }] },
  ] });
  seen.injected = true;
  await turn(thread.id, "Reply with only the Goal ID from the Harness Goal checkpoint, then the word you were asked to remember. Do not run commands.");
  console.log(JSON.stringify({ model, ...seen }, null, 2));
  assert.equal(seen.compacted, 1);
  assert.match(seen.answers.at(-1) ?? "", /SMOKE-GOAL-42/);
  console.log("Codex compaction smoke passed.");
} finally {
  clearTimeout(timeout);
  rpc.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
