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
