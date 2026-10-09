// Harness-wide rules the user sets once and every agent receives.
const RULES_KEY = "agent-rules",
  STATS_KEY = "delegation-stats";
// Providers the host can run as a read-only worker, and whose chats can delegate.
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
  const rules = { instructions, delegate: { enabled, workers } };
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
        ...workerAvailability(w, providers),
      })),
    },
  };
}

// The measured token cost of recent delegations, per worker model.
export function recordDelegation(store, worker, tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const all = store.setting(STATS_KEY) ?? {},
    key = workerKey(worker);
  all[key] = [...(Array.isArray(all[key]) ? all[key] : []), tokens].slice(
    -KEPT_RUNS,
  );
  store.setting(STATS_KEY, all);
}
export function delegationStats(store) {
  return Object.fromEntries(
    Object.entries(store.setting(STATS_KEY) ?? {})
      .filter(([, runs]) => Array.isArray(runs) && runs.length)
      .map(([key, runs]) => {
        const sorted = [...runs].sort((a, b) => a - b);
        return [
          key,
          {
            count: sorted.length,
            median: sorted[Math.floor((sorted.length - 1) / 2)],
            min: sorted[0],
          },
        ];
      }),
  );
}

export const delegateTool = {
  name: "delegate_task",
  description:
    "Hand a self-contained, read-only task (searching, listing or reading files in this repository) to the user's low-cost worker model and get back its written answer. The worker cannot change anything and does not see this conversation, so state the whole task and what to report.",
  inputSchema: {
    type: "object",
    properties: { task: { type: "string" }, report: { type: "string" } },
    required: ["task"],
    additionalProperties: false,
  },
};

// Which workers this turn may use, in order, and why any configured one is
// left out. A chat already running on the worker model has nothing cheaper to
// hand work to, and Cursor chats are not covered.
export function planWorkers(rules, providers, run) {
  const { enabled, workers } = rules.delegate,
    onModel = (w) => w.provider === run.provider && w.model === run.model;
  if (
    !enabled ||
    !workers.length ||
    !WORKER_PROVIDERS.includes(run.provider) ||
    onModel(workers[0])
  )
    return { workers: [], skipped: [] };
  const usable = [],
    skipped = [];
  for (const worker of workers.filter((w) => !onModel(w))) {
    const { available, reason } = workerAvailability(worker, providers);
    if (available) usable.push(worker);
    else skipped.push({ worker, reason });
  }
  return { workers: usable, skipped };
}

export function rulesInstructions(rules, worker, providers, stats) {
  const parts = [];
  if (rules.instructions.trim())
    parts.push(
      "Standing instructions from the user for every agent in this workspace:\n" +
        rules.instructions.trim(),
    );
  if (worker) {
    const cost = stats[workerKey(worker)],
      count = (n) => n.toLocaleString("en-US");
    parts.push(
      `Cost rule set by the user: a low-cost worker (${workerName(worker, providers)}) is available through the delegate_task tool. It can search, list and read files in this repository, cannot change anything, does not see this conversation, and returns a written answer. ${
        cost
          ? `Recent delegations have cost about ${count(cost.median)} tokens on that cheaper model, and never less than ${count(cost.min)}.`
          : "Each delegation has a small fixed overhead on that cheaper model."
      } Delegate when you expect a search or exploration to cost more than that in your own context: finding where something lives, surveying how a pattern is used, or reading several files to answer one question. Do the work yourself when one or two direct lookups will do, or when you need the file contents in your own context to edit them. Give the worker a complete, specific task and say what to report (paths, line numbers, short excerpts). Use delegate_task rather than your own built-in subagents for this kind of work. If delegate_task reports that no worker is available, do the task yourself.`,
    );
  }
  return parts.length ? "\n" + parts.join("\n") : "";
}
