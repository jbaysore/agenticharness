// Opt-in native validation. Two tiny turns through the existing Codex
// subscription adapter; no API keys, paid routing, workers, or tool execution.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectCodex, runCodex } from "../src/providers/codex.mjs";
import { promptDelivery } from "../src/core/history.mjs";

if (!process.argv.includes("--codex"))
  throw new Error("Pass --codex to opt into two subscription inference turns.");
const cwd = resolve(".local/context-probe");
await mkdir(cwd, { recursive: true });
const provider = await inspectCodex(cwd);
if (provider.blockReason || !provider.connected)
  throw new Error(provider.blockReason ?? "Codex is not connected.");
const model = provider.models.find((m) => m.id === "gpt-6.1-sol");
assert.ok(
  model,
  "The pinned verification model must be available; do not substitute another route.",
);
const reference =
  "Verification reference: the archive label is HARBOR-47. The review limit is 73. The owner is Morgan. Preserve these facts across follow-up turns.";
const instructions =
  "You are validating native conversation continuity. Do not use any tools, browse, read files, or change anything. Answer only the requested facts from the verification reference.";
let session = {},
  context = null;
const outputs = [];
for (const [index, notice, text] of [
  [
    0,
    "The notebook is open.",
    "Return only the archive label from the verification reference.",
  ],
  [
    1,
    "The notebook is now closed.",
    "Using the reference from the previous turn, return only the archive label, review limit, and owner, separated by commas.",
  ],
]) {
  const blocks = [
    { key: "reference", text: reference },
    { key: "notice", text: notice },
  ];
  const delivery = promptDelivery({
    provider: "codex",
    session,
    prefix: instructions,
    addendum: blocks.map((b) => b.text).join("\n\n"),
    blocks,
    independent: true,
  });
  if (index) assert.equal(delivery.addendum.includes(reference), false);
  const previousId = session.id;
  const abort = new AbortController(),
    messages = new Map();
  const timer = setTimeout(() => abort.abort(), 60000);
  try {
    const result = await runCodex({
      project: { path: cwd },
      model: model.id,
      effort: model.efforts.includes("low") ? "low" : model.defaultEffort,
      mode: "ask",
      permissions: "manual",
      session: { ...session },
      context,
      instructions: delivery.instructions,
      addendum: delivery.addendum,
      text,
      tools: [],
      signal: abort.signal,
      saveSession: (patch) => {
        session = { ...session, ...patch };
      },
      promptAccepted: () => {
        session = {
          ...session,
          promptHash: delivery.promptHash,
          addendumHash: delivery.addendumHash,
          blockHashes: delivery.blockHashes,
          acceptedGeneration: delivery.generation,
        };
      },
      approve: async () => ({ allow: false }),
      history: async () => ({ error: "Tools are disabled for validation." }),
      emit: (type, payload) => {
        if (type === "context-usage") context = payload;
        if (type === "text")
          messages.set(
            payload.nativeId,
            payload.text ??
              (messages.get(payload.nativeId) ?? "") + (payload.delta ?? ""),
          );
      },
    });
    assert.equal(
      result.status,
      "completed",
      result.error?.message ?? result.error,
    );
    if (index) assert.equal(session.id, previousId);
    const answer = [...messages.values()].join("\n");
    assert.match(answer, /HARBOR-47/);
    if (index) {
      assert.match(answer, /73/);
      assert.match(answer, /Morgan/);
    }
    assert.ok(
      context?.usedTokens > 0 && context?.windowTokens > 0,
      "Native context telemetry must be present.",
    );
    outputs.push({
      turn: index + 1,
      addendumBytes: Buffer.byteLength(delivery.addendum),
      usedTokens: context.usedTokens,
      windowTokens: context.windowTokens,
      cacheReadTokens: context.cache?.cacheReadTokens,
      status: result.status,
    });
  } finally {
    clearTimeout(timer);
  }
}
console.log(
  JSON.stringify(
    {
      provider: "codex",
      model: model.id,
      nativeSessionPreserved: true,
      referenceRetained: true,
      measurements: outputs,
    },
    null,
    2,
  ),
);
