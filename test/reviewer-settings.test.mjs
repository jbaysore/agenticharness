import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import {
  readRules,
  saveRules,
  saveReviewSettings,
} from "../src/core/rules.mjs";
import {
  cursorReviewer,
  reviewSettings,
  reviewProviders,
} from "../src/core/review-policy.mjs";
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
  primaryProvider: "claude",
  fallbackEnabled: true,
  plan: {
    primaryProvider: "codex",
    fallbackEnabled: false,
    codex: { model: "pinned", effort: "high" },
    claude: null,
  },
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
      { fallbackEnabled: "yes" },
      { primaryProvider: "cursor" },
      { primaryProvider: "openrouter" },
      { primaryProvider: "independent" },
      { plan: null },
      { plan: [] },
      { plan: { primaryProvider: "openrouter" } },
      { plan: { fallbackEnabled: 1 } },
      { plan: { codex: { model: "missing" } } },
      { plan: { claude: { model: "fallback", effort: "ultra" } } },
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
        primaryProvider: "claude",
        fallbackEnabled: false,
        plan: selection.plan,
      },
    );
  } finally {
    store.close();
  }
});

test("legacy reviewer models migrate to separate plan choices and preserve their fallback policy", () => {
  const legacy = {
      codex: selection.codex,
      claude: selection.claude,
      claudeFallback: false,
    },
    settings = reviewSettings(legacy);
  assert.equal(settings.primaryProvider, "codex");
  assert.equal(settings.fallbackEnabled, false);
  assert.deepEqual(settings.plan, {
    primaryProvider: "independent",
    fallbackEnabled: true,
    codex: selection.codex,
    claude: selection.claude,
  });
  assert.deepEqual(reviewProviders(settings), ["codex"]);
  assert.deepEqual(reviewProviders(settings, "plan", "codex"), [
    "claude",
    "codex",
  ]);
  assert.deepEqual(reviewProviders(settings, "plan", "claude"), [
    "codex",
    "claude",
  ]);
  assert.deepEqual(reviewProviders(selection), ["claude", "codex"]);
  assert.deepEqual(reviewProviders(selection, "plan", "codex"), ["codex"]);
});

test("saving only reviewers preserves instructions and an unavailable delegated worker", () => {
  const store = new Store(":memory:");
  try {
    const rules = saveRules(
      store,
      {
        instructions: "Keep my standing rules",
        delegate: {
          enabled: true,
          workers: [{ provider: "codex", model: "pinned" }],
        },
      },
      providers(),
    );
    const catalog = providers();
    catalog[0].models = [];
    const saved = saveReviewSettings(
      store,
      { primaryProvider: "claude", plan: { claude: selection.claude } },
      catalog,
    );
    assert.equal(saved.instructions, rules.instructions);
    assert.deepEqual(saved.delegate, rules.delegate);
    assert.equal(saved.review.primaryProvider, "claude");
    assert.deepEqual(saved.review.plan.claude, selection.claude);
    saveReviewSettings(store, { claude: null }, catalog);
    assert.deepEqual(readRules(store).review.plan.claude, selection.claude);
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
    saveRules(
      app.store,
      {
        instructions: "Preserve these",
        delegate: {
          enabled: true,
          workers: [{ provider: "codex", model: "pinned" }],
        },
      },
      providers(),
    );
    const response = await fetch(app.runtime.origin + "/api/rules", {
      method: "PATCH",
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
    assert.equal(state.rules.instructions, "Preserve these");
    assert.equal(state.rules.delegate.enabled, true);
    assert.equal(state.rules.delegate.workers[0].model, "pinned");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
