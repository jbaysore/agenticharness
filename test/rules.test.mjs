import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.mjs";
import {
  delegationStats,
  describeRules,
  readRules,
  recordDelegation,
  saveRules,
  workerAvailability,
} from "../src/core/rules.mjs";

const providers = () => [
  {
    id: "claude",
    name: "Claude Code",
    connected: true,
    models: [
      { id: "opus", name: "Opus", efforts: ["low", "high"] },
      { id: "haiku", name: "Haiku", efforts: [] },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    connected: true,
    models: [
      { id: "big", name: "Big", efforts: ["low", "medium"] },
      { id: "mini", name: "Mini", efforts: ["low", "medium"] },
      { id: "retired", name: "Retired", efforts: [], disabled: true },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    connected: true,
    models: [{ id: "composer", name: "Composer", efforts: [] }],
  },
];
const haiku = { provider: "claude", model: "haiku", effort: null },
  mini = { provider: "codex", model: "mini", effort: "low" };

test("nothing is chosen until the user chooses, and a saved choice is kept", () => {
  const store = new Store(":memory:");
  assert.deepEqual(readRules(store), {
    instructions: "",
    delegate: { enabled: false, workers: [] },
  });
  const saved = saveRules(
    store,
    {
      instructions: "Prefer small diffs.",
      delegate: { enabled: true, workers: [haiku, { ...mini, extra: 1 }] },
    },
    providers(),
  );
  assert.deepEqual(saved.delegate.workers, [haiku, mini]);
  assert.deepEqual(readRules(store), saved);
  store.close();
});

test("rules are checked against the live model lists before they are saved", () => {
  const store = new Store(":memory:"),
    save = (delegate, instructions = "") =>
      saveRules(store, { instructions, delegate }, providers());
  assert.throws(
    () => save({ enabled: true, workers: [] }),
    /Choose a worker model before/,
  );
  assert.throws(
    () => save({ workers: [{ provider: "cursor", model: "composer" }] }),
    /Claude Code or Codex/,
  );
  assert.throws(
    () => save({ workers: [{ provider: "claude", model: "unknown" }] }),
    /currently available/,
  );
  assert.throws(
    () => save({ workers: [{ provider: "codex", model: "retired" }] }),
    /currently available/,
  );
  assert.throws(
    () => save({ workers: [{ ...haiku, effort: "high" }] }),
    /effort/,
  );
  assert.throws(() => save({ workers: [haiku, haiku] }), /different model/);
  assert.throws(() => save({ workers: [haiku, mini, mini] }), /at most one/);
  assert.throws(() => save({}, "x".repeat(8001)), /at most 8,000/);
  assert.throws(() => saveRules(store, null, providers()), /object/);
  assert.deepEqual(readRules(store).delegate.workers, []);
  assert.equal(
    save({ enabled: false, workers: [mini] }).delegate.enabled,
    false,
  );
  store.close();
});

test("a worker is available exactly when its provider could run a turn", () => {
  const list = providers();
  assert.deepEqual(workerAvailability(haiku, list), {
    available: true,
    reason: null,
  });
  list[0].blockReason = "A Claude included-usage limit is exhausted.";
  assert.deepEqual(workerAvailability(haiku, list), {
    available: false,
    reason: "A Claude included-usage limit is exhausted.",
  });
  list[1].connected = false;
  assert.match(workerAvailability(mini, list).reason, /Codex is not connected/);
  assert.match(
    workerAvailability({ provider: "codex", model: "mini" }, []).reason,
    /not connected/,
  );
  // A saved worker whose model has left the catalog is reported, not dropped.
  const store = new Store(":memory:");
  saveRules(
    store,
    { delegate: { enabled: true, workers: [mini] } },
    providers(),
  );
  const later = providers();
  later[1].models = later[1].models.filter((m) => m.id !== "mini");
  const [worker] = describeRules(readRules(store), later).delegate.workers;
  assert.equal(worker.model, "mini");
  assert.equal(worker.available, false);
  assert.match(worker.reason, /no longer offers mini/);
  assert.equal(
    describeRules(readRules(store), providers()).delegate.workers[0].name,
    "Codex · Mini",
  );
  store.close();
});

test("delegation cost is remembered per worker model over the last twenty runs", () => {
  const store = new Store(":memory:");
  assert.deepEqual(delegationStats(store), {});
  for (const tokens of [900, 300, 600]) recordDelegation(store, haiku, tokens);
  recordDelegation(store, mini, 5000);
  recordDelegation(store, mini, 0);
  recordDelegation(store, mini, NaN);
  assert.deepEqual(delegationStats(store), {
    "claude|haiku": { count: 3, median: 600, min: 300 },
    "codex|mini": { count: 1, median: 5000, min: 5000 },
  });
  for (let i = 0; i < 30; i++) recordDelegation(store, haiku, 1000 + i);
  assert.deepEqual(delegationStats(store)["claude|haiku"], {
    count: 20,
    median: 1019,
    min: 1010,
  });
  store.close();
});
