// Context occupancy, model usage, and account quota are deliberately separate.
// Missing provider fields are unknown, never a measured zero.
export const tokenCount = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
const sum = (...values) =>
  values.every((n) => n !== null) ? values.reduce((a, b) => a + b, 0) : null;
const subtract = (total, ...parts) => {
  const amount = sum(...parts);
  return total !== null && amount !== null && total >= amount
    ? total - amount
    : null;
};

export function openAIUsage(usage = {}) {
  const details =
    usage.input_tokens_details ?? usage.prompt_tokens_details ?? {};
  const inputTokens = tokenCount(
    usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens,
  );
  const cacheReadTokens = tokenCount(
    usage.cachedInputTokens ?? details.cached_tokens,
  );
  const cacheWriteTokens = tokenCount(
    usage.cacheWriteTokens ?? details.cache_write_tokens,
  );
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    uncachedInputTokens: subtract(
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    ),
    outputTokens: tokenCount(
      usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens,
    ),
    reasoningTokens: tokenCount(
      usage.reasoningOutputTokens ??
        usage.output_tokens_details?.reasoning_tokens ??
        usage.completion_tokens_details?.reasoning_tokens,
    ),
  };
}

export function claudeUsage(usage = {}) {
  const uncachedInputTokens = tokenCount(
    usage.input_tokens ?? usage.inputTokens,
  );
  const cacheReadTokens = tokenCount(
    usage.cache_read_input_tokens ?? usage.cacheReadInputTokens,
  );
  const cacheWriteTokens = tokenCount(
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
  );
  return {
    inputTokens: sum(uncachedInputTokens, cacheReadTokens, cacheWriteTokens),
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: tokenCount(usage.output_tokens ?? usage.outputTokens),
    reasoningTokens: null,
  };
}

// Cumulative reports replace their predecessor. A resumed session without a
// recorded baseline cannot honestly attribute its first total to this run.
export function usageDelta(previous, next) {
  if (!previous) return null;
  return Object.fromEntries(
    Object.entries(next).map(([key, value]) => {
      const before = tokenCount(previous[key]),
        after = tokenCount(value);
      return [
        key,
        before !== null && after !== null && after >= before
          ? after - before
          : null,
      ];
    }),
  );
}

export function contextReporter(ctx, provider) {
  let snapshot = null;
  const publish = () => {
    if (ctx.signal?.aborted || !snapshot) return;
    ctx.emit("context-usage", { ...snapshot });
  };
  return {
    get generation() {
      return snapshot?.generation ?? 0;
    },
    get snapshot() {
      return snapshot;
    },
    start(sessionId) {
      const prior = ctx.context;
      const same = prior?.sessionId === sessionId && prior.model === ctx.model;
      snapshot = {
        ...(same ? prior : {}),
        provider,
        sessionId,
        model: ctx.model,
        generation: same ? (tokenCount(prior.generation) ?? 0) : 0,
        usedTokens: same ? prior.usedTokens : null,
        windowTokens: same ? prior.windowTokens : null,
        accuracy: same ? prior.accuracy : "unavailable",
        basis: same ? prior.basis : "current-context",
        source: same ? prior.source : provider,
        observedAt: same ? prior.observedAt : null,
        state: same
          ? prior.state === "compacting"
            ? "compacting"
            : "updating"
          : "waiting",
      };
      publish();
    },
    update(patch, generation = snapshot?.generation) {
      if (
        !snapshot ||
        generation !== snapshot.generation ||
        ctx.signal?.aborted
      )
        return;
      const normalized = { ...patch };
      for (const key of ["usedTokens", "windowTokens", "reserveTokens"])
        if (key in normalized) normalized[key] = tokenCount(normalized[key]);
      if ("windowTokens" in normalized && normalized.windowTokens === 0)
        normalized.windowTokens = null;
      snapshot = { ...snapshot, ...normalized };
      if ("usedTokens" in normalized) {
        snapshot.observedAt = new Date().toISOString();
        snapshot.state = "ready";
      }
      publish();
    },
    totals(totals, scope) {
      if (!snapshot) return;
      const previous = snapshot.usageTotals ?? {};
      const deltas = Object.fromEntries(
        Object.entries(totals).map(([model, values]) => [
          model,
          usageDelta(previous[model], values),
        ]),
      );
      this.update({
        usageTotals: totals,
        usageDeltas: deltas,
        usageScope: scope,
      });
    },
    compact() {
      if (!snapshot) return;
      snapshot = {
        ...snapshot,
        generation: snapshot.generation + 1,
        state: "compacting",
        cache: null,
      };
      ctx.invalidatePromptDelivery?.();
      publish();
    },
    finish() {
      if (!snapshot) return;
      if (snapshot.state === "updating")
        snapshot = { ...snapshot, state: "outdated" };
      if (snapshot.state === "waiting")
        snapshot = { ...snapshot, state: "unavailable" };
      publish();
    },
  };
}

// Summary mode is a native control read, not an inference or token-count call.
// A timed-out underlying read stays single-flight until it settles; late
// replies cannot overwrite a newer generation or survive disposal.
export function contextSampler(
  q,
  reporter,
  { intervalMs = 1000, timeoutMs = 2000, now = Date.now } = {},
) {
  let inFlight = null,
    lastRead = -Infinity,
    disposed = false;
  return {
    sample(force = false) {
      if (disposed || typeof q.getContextUsage !== "function")
        return Promise.resolve();
      if (inFlight) return inFlight;
      if (!force && now() - lastRead < intervalMs) return Promise.resolve();
      lastRead = now();
      const generation = reporter.generation;
      const identity = reporter.snapshot;
      let expired = false,
        timer;
      const read = Promise.resolve()
        .then(() => q.getContextUsage({ detail: "summary" }))
        .then((reading) => {
          if (
            disposed ||
            expired ||
            !reading ||
            tokenCount(reading.totalTokens) === null ||
            reporter.snapshot?.sessionId !== identity?.sessionId ||
            reporter.snapshot?.model !== identity?.model
          )
            return;
          reporter.update(
            {
              usedTokens: reading.totalTokens,
              windowTokens: reading.rawMaxTokens,
              accuracy: "provider-estimated",
              basis: "current-context",
              source: "Claude SDK context summary",
              resolvedModel: reading.model,
              categories: (reading.categories ?? [])
                .filter(
                  (c) =>
                    ["used", "buffer"].includes(c.kind) &&
                    tokenCount(c.tokens) !== null,
                )
                .map(({ name, tokens, kind }) => ({ name, tokens, kind })),
            },
            generation,
          );
        })
        .catch(() => {})
        .finally(() => {
          clearTimeout(timer);
          inFlight = null;
        });
      inFlight = Promise.race([
        read,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
      return inFlight;
    },
    dispose() {
      disposed = true;
    },
  };
}
