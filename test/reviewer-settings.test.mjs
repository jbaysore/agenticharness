import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { readRules, saveRules } from "../src/core/rules.mjs";
import { cursorReviewer } from "../src/core/review-policy.mjs";
import { createHarness } from "../src/server.mjs";

const providers = () => [
  {
    id: "codex",
    name: "Codex",
    connected: true,
    models: [
      {
        id: "default",
        name: "Default Codex",
        isDefault: true,
        efforts: ["low"],
        defaultEffort: "low",
      },
      {
        id: "pinned",
        name: "Pinned Codex",
        efforts: ["low", "high"],
        defaultEffort: "high",
      },
      { id: "retired", disabled: true, efforts: [] },
    ],
  },
  {
    id: "claude",
    name: "Claude Code",
    connected: true,
    models: [
      {
        id: "default",
        name: "Default Claude",
        isDefault: true,
        efforts: ["medium"],
        defaultEffort: "medium",
      },
      { id: "fallback", name: "Chosen Claude", efforts: ["low", "high"] },
    ],
  },
];
const selection = {
  codex: { model: "pinned", effort: "low" },
  claude: { model: "fallback", effort: "high" },
  claudeFallback: true,
};

test("reviewer choices and effort override changing catalog defaults without changing delegation", () => {
  const store = new Store(":memory:"),
    catalog = providers();
  try {
    const saved = saveRules(
      store,
      { review: selection, instructions: "Small edits" },
      catalog,
    );
    assert.deepEqual(saved.review, selection);
    assert.equal(saved.delegate.enabled, false);
    assert.deepEqual(cursorReviewer(catalog, saved.review.codex), {
      provider: "codex",
      model: "pinned",
      effort: "low",
      name: "Codex · Pinned Codex",
    });
    catalog[0].models[0].isDefault = false;
    catalog[0].models[2].isDefault = true;
    assert.equal(cursorReviewer(catalog, saved.review.codex).model, "pinned");
    assert.equal(
      cursorReviewer(catalog, saved.review.claude, "claude").model,
      "fallback",
    );
    saveRules(store, { instructions: "Old client save" }, catalog);
    assert.deepEqual(readRules(store).review, selection);
    catalog[0].models = [];
    saveRules(
      store,
      { review: selection, instructions: "Keep unavailable selections" },
      catalog,
    );
    assert.deepEqual(readRules(store).review.codex, selection.codex);
    assert.throws(
      () => cursorReviewer(catalog, selection.codex),
      /selected reviewer model/,
    );
  } finally {
    store.close();
  }
});

test("invalid reviewer models, providers, efforts and fallback settings never change saved rules", () => {
  const store = new Store(":memory:"),
    catalog = providers();
  try {
    saveRules(store, { review: selection }, catalog);
    for (const review of [
      null,
      [],
      "wrong",
      { claudeFallback: "yes" },
      { codex: { model: "missing" } },
      { codex: { model: "retired" } },
      { codex: { provider: "claude", model: "pinned" } },
      { codex: { model: "pinned", effort: "ultra" } },
      { claude: { model: "fallback", effort: 10 } },
    ]) {
      assert.throws(() =>
        saveRules(store, { instructions: "Must not save", review }, catalog),
      );
      assert.deepEqual(readRules(store).review, selection);
      assert.equal(readRules(store).instructions, "");
    }
    assert.deepEqual(
      saveRules(
        store,
        { review: { codex: null, claudeFallback: false } },
        catalog,
      ).review,
      {
        codex: null,
        claude: selection.claude,
        claudeFallback: false,
      },
    );
  } finally {
    store.close();
  }
});

test("reviewer choices save through the API and survive a host restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-review-settings-"));
  let app = await createHarness({
    dataDir: dir,
    port: 0,
    startProviders: false,
  });
  try {
    app.controller.providers = providers();
    const response = await fetch(app.runtime.origin + "/api/rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Harness-Client": "1" },
      body: JSON.stringify({ review: selection }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).review, selection);
    await app.close();
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false });
    const state = await fetch(app.runtime.origin + "/api/state").then((r) =>
      r.json(),
    );
    assert.deepEqual(state.rules.review, selection);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
