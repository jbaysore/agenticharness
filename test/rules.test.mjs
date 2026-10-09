import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.mjs";
import {
  delegationStats,
  describeRules,
  measuredRuns,
  planDelegation,
  readRules,
  recordRun,
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
const allActions = {
    read: true,
    extract: true,
    triage: true,
    summarise: true,
    locate: true,
    edit: true,
    run: true,
    draft: true,
  },
  haiku = { provider: "claude", model: "haiku", effort: null },
  mini = { provider: "codex", model: "mini", effort: "low" };

test("nothing is chosen until the user chooses, and a saved choice is kept", () => {
  const store = new Store(":memory:");
  assert.deepEqual(readRules(store), {
    instructions: "",
    delegate: { enabled: false, actions: allActions, workers: [] },
  });
  const saved = saveRules(
    store,
    {
      instructions: "Prefer small diffs.",
      delegate: {
        enabled: true,
        workers: [haiku, { ...mini, extra: 1 }],
        // Every action is allowed unless it is switched off; unknown names are ignored.
        actions: { edit: false, run: "no", teleport: true },
      },
    },
    providers(),
  );
  assert.deepEqual(saved.delegate.workers, [haiku, mini]);
  assert.deepEqual(saved.delegate.actions, { ...allActions, edit: false });
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

test("each worker's real runs are remembered per action, the last twenty of each", () => {
  const store = new Store(":memory:");
  assert.deepEqual(delegationStats(store), {});
  assert.equal(measuredRuns(store, haiku, "read").count, 0);
  for (const [input, output] of [
    [10_400, 500],
    [10_200, 100],
    [10_900, 300],
  ])
    recordRun(store, haiku, "read", { input, output, content: 10_000 });
  recordRun(store, haiku, "locate", { input: 9000, output: 700, content: 0 });
  recordRun(store, mini, "read", { input: 4000, output: 1000, content: 3000 });
  assert.deepEqual(measuredRuns(store, haiku, "read"), {
    count: 3,
    extraInput: 400,
    output: 300,
    share: 0.03,
  });
  assert.equal(measuredRuns(store, haiku, "locate").share, null);
  assert.equal(measuredRuns(store, mini, "locate").count, 0);
  // The settings screen shows one line per worker model across its actions.
  assert.deepEqual(delegationStats(store), {
    "claude|haiku": { count: 4, median: 10_300, min: 9700 },
    "codex|mini": { count: 1, median: 5000, min: 5000 },
  });
  for (let i = 0; i < 30; i++)
    recordRun(store, haiku, "read", { input: 1000 + i, output: 0, content: 0 });
  assert.equal(measuredRuns(store, haiku, "read").count, 20);
  assert.equal(measuredRuns(store, haiku, "read").extraInput, 1019);
  store.close();
});

test("a turn is offered only what can come out cheaper for its model and worker", () => {
  const store = new Store(":memory:"),
    list = [
      {
        id: "claude",
        name: "Claude Code",
        connected: true,
        models: [
          { id: "opus", name: "Opus", resolvedModel: "claude-opus-5-5" },
          { id: "old", name: "Haiku 4.5", resolvedModel: "claude-haiku-4-5" },
          { id: "new", name: "Haiku 5.5", resolvedModel: "claude-haiku-5-5" },
        ],
      },
      {
        id: "codex",
        name: "Codex",
        connected: true,
        models: [
          { id: "gpt-6.1-sol", name: "Sol" },
          { id: "gpt-6-luna", name: "Luna" },
          { id: "gpt-5.6-terra", name: "Terra" },
        ],
      },
    ],
    plan = (worker, provider, model) => {
      saveRules(
        store,
        {
          delegate: {
            enabled: true,
            workers: [{ provider: "claude", model: worker }],
          },
        },
        list,
      );
      const p = planDelegation(
        readRules(store),
        list,
        { provider, model },
        store,
      );
      return {
        tools: p.tools.map((t) => t.name.replace("delegate_", "")),
        editFrom: p.editFrom,
        draftUpTo: p.draftUpTo,
        skipped: p.skipped.map((s) => s.reason),
        note: p.note,
      };
    };
  // A worker forty times cheaper than the chat's model: everything is offered.
  assert.deepEqual(plan("new", "claude", "opus"), {
    tools: ["read", "locate", "edit", "run", "draft"],
    editFrom: 17,
    draftUpTo: 8000,
    skipped: [],
    note: null,
  });
  // Haiku 4.5 under Opus: drafts can never pay, and only very large edits do.
  assert.deepEqual(plan("old", "claude", "opus").tools, [
    "read",
    "locate",
    "edit",
    "run",
  ]);
  assert.equal(plan("old", "claude", "opus").editFrom, 95);
  // Haiku 4.5 under Sol: a search, an edit and a draft all cost more than doing them.
  assert.deepEqual(plan("old", "codex", "gpt-6.1-sol").tools, ["read", "run"]);
  // A worker that costs as much as the chat's model is not a saving at all.
  assert.deepEqual(plan("new", "codex", "gpt-6-luna"), {
    tools: [],
    editFrom: undefined,
    draftUpTo: undefined,
    skipped: ["It is not cheaper than this chat's model."],
    note: null,
  });
  assert.match(
    plan("new", "codex", "gpt-5.6-terra").note,
    /No list price is known for Codex · Terra/,
  );
  // An unpriced worker cannot be compared either.
  list[0].models.push({ id: "mystery", name: "Mystery" });
  assert.deepEqual(plan("mystery", "claude", "opus").skipped, [
    "No list price is known for it.",
  ]);
  store.close();
});
