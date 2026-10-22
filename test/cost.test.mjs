import test from "node:test";
import assert from "node:assert/strict";
import { cost, modelPrice, priceOf } from "../src/core/prices.mjs";
import {
  MIN_HANDOFF,
  draftLimit,
  editThreshold,
  estimate,
  measure,
  offeredTools,
  tokensOf,
} from "../src/core/delegation.mjs";

const opus = { input: 4, output: 20 },
  sol = { input: 2, output: 10 },
  small = { input: 0.1, output: 0.5 },
  haiku45 = { input: 1, output: 5 };

test("a model is priced by its resolved name, and an unknown one has no price", () => {
  assert.deepEqual(
    modelPrice("claude", { id: "default", resolvedModel: "claude-opus-5-5" }),
    opus,
  );
  assert.deepEqual(
    modelPrice("claude", {
      id: "claude-opus-5",
      resolvedModel: "claude-opus-5",
    }),
    { input: 5, output: 25 },
  );
  assert.deepEqual(
    modelPrice("claude", {
      id: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
    }),
    haiku45,
  );
  assert.deepEqual(
    modelPrice("claude", { id: "haiku", resolvedModel: "claude-haiku-5-5" }),
    small,
  );
  assert.deepEqual(modelPrice("codex", { id: "gpt-6.1-sol" }), sol);
  assert.deepEqual(modelPrice("codex", { id: "gpt-6-luna" }), small);
  assert.equal(modelPrice("codex", { id: "gpt-5.6-terra" }), null);
  assert.equal(modelPrice("claude", { id: "claude-opus-4-8" }), null);
  assert.equal(modelPrice("cursor", { id: "composer" }), null);
  assert.equal(modelPrice("codex", undefined), null);
  assert.deepEqual(
    priceOf([{ id: "codex", models: [{ id: "gpt-6-luna" }] }], {
      provider: "codex",
      model: "gpt-6-luna",
    }),
    small,
  );
  assert.equal(priceOf([], { provider: "codex", model: "gpt-6-luna" }), null);
  assert.equal(cost(opus, 1_000_000, 100_000), 6);
  assert.equal(tokensOf(4001), 1001);
});

test("the whole round trip is compared: the worker, and the chat reading its result", () => {
  const prices = { main: opus, worker: small },
    read = estimate({ action: "read", content: 10_000 }, prices);
  // Self: 10,000 tokens read twice at $4. Delegated: the worker reads 11,200
  // and writes 4,000 at its price, then the chat reads those 4,000 twice.
  assert.equal(read.self, 0.08);
  assert.equal(
    Number(read.delegated.toFixed(6)),
    Number(((11_200 * 0.1 + 4000 * 0.5 + 8000 * 4) / 1e6).toFixed(6)),
  );
  assert.equal(read.cheaper, true);
  // A summary comes back much shorter than the file, so it saves far more.
  assert.ok(
    estimate({ action: "summarise", content: 10_000 }, prices).delegated <
      read.delegated / 4,
  );
  // Retention makes the hand-off cheaper even when the worker costs a quarter
  // of the chat's model, because the file would otherwise be read twice.
  assert.equal(
    estimate(
      { action: "read", content: 10_000 },
      { main: opus, worker: haiku45 },
    ).cheaper,
    true,
  );
});

test("a small job is never handed off, however the prices compare", () => {
  const prices = { main: opus, worker: small };
  for (const action of ["read", "extract", "triage", "summarise", "run"]) {
    assert.equal(
      estimate({ action, content: MIN_HANDOFF - 1 }, prices).cheaper,
      false,
      action,
    );
    assert.equal(
      estimate({ action, content: MIN_HANDOFF * 5 }, prices).cheaper,
      true,
      action,
    );
  }
});

test("measured worker runs replace the starting assumptions", () => {
  const prices = { main: opus, worker: small },
    job = { action: "read", content: 10_000 };
  assert.deepEqual(measure([]), {
    count: 0,
    extraInput: null,
    output: null,
    share: null,
  });
  const terse = measure([
    { input: 10_400, output: 500, content: 10_000 },
    { input: 20_600, output: 1000, content: 20_000 },
    { input: 5_300, output: 250, content: 5_000 },
  ]);
  assert.deepEqual(terse, {
    count: 3,
    extraInput: 400,
    output: 500,
    share: 0.05,
  });
  assert.ok(
    estimate(job, prices, terse).delegated <
      estimate(job, prices).delegated / 3,
  );
  // A worker that returns nearly the whole file saves nothing.
  const verbose = measure([{ input: 11_000, output: 9_800, content: 10_000 }]);
  assert.equal(estimate(job, prices, verbose).cheaper, false);
});

test("an edit is offered only from the size at which asking for it pays", () => {
  assert.equal(editThreshold({ main: opus, worker: small }), 135);
  assert.equal(editThreshold({ main: sol, worker: small }), 238);
  assert.equal(editThreshold({ main: opus, worker: haiku45 }), null);
  assert.equal(editThreshold({ main: sol, worker: haiku45 }), null);
  const prices = { main: opus, worker: small },
    edit = (lines, haveRead) =>
      estimate({ action: "edit", content: 2000, lines, haveRead }, prices);
  // Once the call is made its sentence is already spent, so the decision at
  // that point is a little more willing than the advertised threshold.
  assert.equal(edit(100, true).cheaper, true);
  assert.equal(edit(2, true).cheaper, false);
  // Not having read the file yet makes handing off more attractive.
  assert.ok(edit(2, false).self > edit(2, true).self);
});

test("drafts and searches are offered only where they can come out cheaper", () => {
  assert.equal(draftLimit({ main: opus, worker: small }), 8000);
  assert.equal(draftLimit({ main: sol, worker: small }), 4000);
  assert.equal(draftLimit({ main: opus, worker: haiku45 }), 0);
  assert.equal(
    estimate({ action: "locate" }, { main: sol, worker: small }).cheaper,
    true,
  );
  assert.equal(
    estimate({ action: "locate" }, { main: sol, worker: haiku45 }).cheaper,
    true,
  );
});

test("only the tools for allowed actions are offered", () => {
  const names = (actions) => offeredTools(actions).map((t) => t.name);
  assert.deepEqual(names({}), []);
  assert.deepEqual(names({ summarise: true }), ["delegate_read"]);
  assert.deepEqual(names({ locate: true, run: true }), [
    "delegate_locate",
    "delegate_run",
  ]);
  assert.deepEqual(
    names({
      read: true,
      extract: true,
      locate: true,
      edit: true,
      run: true,
      draft: true,
    }),
    [
      "delegate_read",
      "delegate_locate",
      "delegate_edit",
      "delegate_run",
      "delegate_draft",
    ],
  );
});
