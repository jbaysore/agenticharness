// Harness-wide rules the user sets once and every agent receives.
import {
  ACTION_NAMES,
  READ_PURPOSES,
  draftLimit,
  editThreshold,
  estimate,
  measure,
  offeredTools,
} from "./delegation.mjs";
import { priceOf } from "./prices.mjs";

const RULES_KEY = "agent-rules",
  STATS_KEY = "delegation-runs";
// Providers the host can run as a worker, and whose chats can delegate.
export const WORKER_PROVIDERS = ["claude", "codex"];
const MAX_INSTRUCTIONS = 8000,
  MAX_WORKERS = 2,
  KEPT_RUNS = 20;

export const workerKey = (worker) => worker.provider + "|" + worker.model;
const sameWorker = (a, b) => a.provider === b.provider && a.model === b.model;
const catalogModel = (worker, providers) =>
  providers
    .find((p) => p.id === worker.provider)
    ?.models?.find((m) => m.id === worker.model);
// Every action is allowed unless the user has switched it off.
const actionsFrom = (saved) =>
  Object.fromEntries(
    ACTION_NAMES.map((name) => [name, saved?.[name] !== false]),
  );

export function workerName(worker, providers) {
  const provider = providers.find((p) => p.id === worker.provider),
    model = catalogModel(worker, providers);
  return `${provider?.name ?? worker.provider} · ${model?.name ?? worker.model}`;
}

// Saved rules are read leniently: a worker whose model has since left the
// catalog stays in the list and is reported unavailable, never dropped.
export function readRules(store) {
  const saved = store.setting(RULES_KEY) ?? {},
    workers = Array.isArray(saved.delegate?.workers)
      ? saved.delegate.workers
      : [];
  return {
    instructions:
      typeof saved.instructions === "string" ? saved.instructions : "",
    delegate: {
      enabled: saved.delegate?.enabled === true,
      actions: actionsFrom(saved.delegate?.actions),
      workers: workers
        .filter(
          (w) =>
            WORKER_PROVIDERS.includes(w?.provider) &&
            typeof w.model === "string",
        )
        .slice(0, MAX_WORKERS)
        .map((w) => ({
          provider: w.provider,
          model: w.model,
          effort: typeof w.effort === "string" && w.effort ? w.effort : null,
        })),
    },
  };
}

// What the user submits is checked against the live model lists before saving.
export function saveRules(store, input, providers) {
  if (!input || typeof input !== "object")
    throw new Error("Rules must be an object");
  const instructions = input.instructions ?? "";
  if (
    typeof instructions !== "string" ||
    instructions.length > MAX_INSTRUCTIONS
  )
    throw new Error(
      `Instructions must be text of at most ${MAX_INSTRUCTIONS.toLocaleString("en-US")} characters`,
    );
  const requested = input.delegate?.workers ?? [];
  if (!Array.isArray(requested) || requested.length > MAX_WORKERS)
    throw new Error("Choose one worker and at most one fallback");
  const workers = requested.map((w) => {
    if (!WORKER_PROVIDERS.includes(w?.provider))
      throw new Error("A worker must be a Claude Code or Codex model");
    const model = catalogModel(w, providers);
    if (!model || model.disabled)
      throw new Error("Choose a worker model that is currently available");
    const effort = w.effort || null;
    if (effort && !model.efforts?.includes(effort))
      throw new Error("That worker model does not offer that effort setting");
    return { provider: w.provider, model: w.model, effort };
  });
  if (workers.length === 2 && sameWorker(workers[0], workers[1]))
    throw new Error("The fallback must be a different model from the worker");
  const enabled = input.delegate?.enabled === true;
  if (enabled && !workers.length)
    throw new Error("Choose a worker model before turning this rule on");
  const rules = {
    instructions,
    delegate: {
      enabled,
      actions: actionsFrom(input.delegate?.actions),
      workers,
    },
  };
  store.setting(RULES_KEY, rules);
  return rules;
}

// A worker can run when its provider could run a chat turn right now.
export function workerAvailability(worker, providers) {
  const provider = providers.find((p) => p.id === worker.provider);
  if (!provider?.connected)
    return {
      available: false,
      reason:
        provider?.blockReason ??
        `${provider?.name ?? worker.provider} is not connected`,
    };
  if (provider.blockReason)
    return { available: false, reason: provider.blockReason };
  const model = catalogModel(worker, providers);
  if (!model || model.disabled)
    return {
      available: false,
      reason: `${provider.name} no longer offers ${worker.model}`,
    };
  return { available: true, reason: null };
}

export function describeRules(rules, providers) {
  return {
    ...rules,
    delegate: {
      ...rules.delegate,
      workers: rules.delegate.workers.map((w) => ({
        ...w,
        name: workerName(w, providers),
        priced: !!priceOf(providers, w),
        ...workerAvailability(w, providers),
      })),
    },
  };
}

// What each worker actually used on recent runs of each action. The estimate
// for the next run is drawn from these, so it improves without any model
// spending tokens on it.
export function recordRun(store, worker, action, sample) {
  const all = store.setting(STATS_KEY) ?? {},
    key = `${workerKey(worker)}|${action}`;
  all[key] = [...(Array.isArray(all[key]) ? all[key] : []), sample].slice(
    -KEPT_RUNS,
  );
  store.setting(STATS_KEY, all);
}
export function measuredRuns(store, worker, action) {
  const runs = (store.setting(STATS_KEY) ?? {})[
    `${workerKey(worker)}|${action}`
  ];
  return measure(Array.isArray(runs) ? runs : []);
}
// Per worker model, for the settings screen: how many hand-offs and their size.
export function delegationStats(store) {
  const byWorker = {};
  for (const [key, runs] of Object.entries(store.setting(STATS_KEY) ?? {})) {
    if (!Array.isArray(runs)) continue;
    const worker = key.slice(0, key.lastIndexOf("|"));
    (byWorker[worker] ??= []).push(...runs.map((r) => r.input + r.output));
  }
  return Object.fromEntries(
    Object.entries(byWorker)
      .filter(([, totals]) => totals.length)
      .map(([worker, totals]) => {
        const sorted = totals.sort((a, b) => a - b);
        return [
          worker,
          {
            count: sorted.length,
            median: sorted[Math.floor((sorted.length - 1) / 2)],
            min: sorted[0],
          },
        ];
      }),
  );
}

// What this turn may hand off, to which workers in which order, and why any
// configured worker is left out. Nothing is offered to Cursor chats, to a chat
// already on the worker model, or where a price needed for the comparison is
// unknown. An action that could never come out cheaper for this pairing is not
// offered at all, so the agent never spends a call on it.
export function planDelegation(rules, providers, run, store) {
  const none = (note = null, skipped = []) => ({
      workers: [],
      skipped,
      note,
      tools: [],
      actions: {},
    }),
    { enabled, workers, actions } = rules.delegate,
    onModel = (w) => w.provider === run.provider && w.model === run.model;
  if (
    !enabled ||
    !workers.length ||
    !WORKER_PROVIDERS.includes(run.provider) ||
    onModel(workers[0])
  )
    return none();
  const mainPrice = priceOf(providers, run);
  if (!mainPrice)
    return none(
      `No list price is known for ${workerName(run, providers)}, so the cost of handing work off cannot be compared. This chat does its own work.`,
    );
  const usable = [],
    skipped = [];
  for (const worker of workers.filter((w) => !onModel(w))) {
    const { available, reason } = workerAvailability(worker, providers),
      price = priceOf(providers, worker);
    if (!available) skipped.push({ worker, reason });
    else if (!price)
      skipped.push({ worker, reason: "No list price is known for it." });
    else if (price.input >= mainPrice.input)
      skipped.push({
        worker,
        reason: "It is not cheaper than this chat's model.",
      });
    else usable.push({ ...worker, price });
  }
  if (!usable.length) return none(null, skipped);
  const prices = { main: mainPrice, worker: usable[0].price },
    measured = (action) => measuredRuns(store, usable[0], action),
    editFrom = editThreshold(prices, measured("edit")),
    draftUpTo = draftLimit(prices, measured("draft")),
    offered = {
      ...actions,
      locate:
        actions.locate &&
        estimate({ action: "locate" }, prices, measured("locate")).cheaper,
      edit: actions.edit && editFrom !== null,
      draft: actions.draft && draftUpTo > 0,
    };
  return {
    workers: usable,
    skipped,
    note: null,
    mainPrice,
    actions: offered,
    tools: offeredTools(offered),
    editFrom,
    draftUpTo,
  };
}

const PURPOSE_TEXT = {
  read: "the part of a file that matters to a question",
  extract: "values pulled out into a list",
  triage: "a set of files or lines sorted by relevance",
  summarise: "a summary for orientation",
};
export function rulesInstructions(rules, plan, providers, shell) {
  const parts = [];
  if (rules.instructions.trim())
    parts.push(
      "Standing instructions from the user for every agent in this workspace:\n" +
        rules.instructions.trim(),
    );
  if (plan.tools.length) {
    const { actions } = plan,
      purposes = READ_PURPOSES.filter((p) => actions[p]),
      lines = [
        purposes.length &&
          `- delegate_read (purpose ${purposes.join(", ")}): when you need an answer from files rather than their full text: ${purposes.map((p) => PURPOSE_TEXT[p]).join("; ")}. Small files come back as raw text.`,
        actions.locate &&
          "- delegate_locate: to find where something lives when you do not already know the file.",
        actions.edit &&
          `- delegate_edit: one mechanical change to one file that you can state exactly in a sentence and that touches about ${plan.editFrom} or more lines. Review the diff it returns. Make smaller edits yourself.`,
        actions.run &&
          `- delegate_run: a command whose output may be long, such as tests, a build or a linter. It runs in ${shell}. You get the output, or its relevant lines verbatim when it is long.`,
        actions.draft &&
          `- delegate_draft: a commit message or changelog entry for the uncommitted diff, when that diff is under about ${plan.draftUpTo.toLocaleString("en-US")} tokens. Read the draft before using it.`,
      ].filter(Boolean);
    parts.push(
      `Cost rule set by the user. A low-cost worker (${workerName(plan.workers[0], providers)}) can take certain work off your model. On every call the host compares the measured cost of the worker, including your reading of its result, with the cost of you doing the work, and uses whichever is cheaper. Do not estimate costs yourself: use these tools for these actions instead of your own tools.\n${lines.join("\n")}\nKeep on your own model: anything that must be exhaustive or prove absence (every usage, nothing calls this), changes across several files, configuration or infrastructure, new code or tests, multi-step terminal work, planning, debugging and final review. A worker's "not found" is not proof that something does not exist. Read a file yourself before you edit it. When a tool says it declined or that no worker is available, do that task yourself. Use these tools rather than your own built-in subagents.`,
    );
  }
  return parts.length ? "\n" + parts.join("\n") : "";
}
