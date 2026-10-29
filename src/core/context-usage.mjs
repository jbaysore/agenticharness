// Active context-window occupancy for one conversation. This is not account
// quota, not tokens summed across a thread, and not estimated cost.

const empty = (provider, model, status, measuredAt) => ({
  provider,
  model: model ?? null,
  used: null,
  window: null,
  percentage: null,
  status,
  measuredAt: measuredAt ?? new Date().toISOString(),
});

function whole(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}
function positive(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function measuredReading({
  provider,
  model,
  used,
  window,
  percentage,
  measuredAt,
  status = "measured",
}) {
  const usedN = whole(used),
    windowN = positive(window);
  let pct = null;
  if (usedN != null && windowN != null) {
    const given = Number.isFinite(percentage) ? Math.round(percentage) : null;
    pct = given != null && given >= 0 ? given : Math.round((usedN / windowN) * 100);
  }
  return {
    provider,
    model: model ?? null,
    used: usedN,
    window: windowN,
    percentage: pct,
    status,
    measuredAt: measuredAt ?? new Date().toISOString(),
  };
}

export function unreportedReading(provider, model, measuredAt) {
  return empty(provider, model, "unreported", measuredAt);
}
export function unmeasuredReading(provider, model, measuredAt) {
  return empty(provider, model, "unmeasured", measuredAt);
}

// Codex occupancy is the latest model call. `total` is lifetime thread usage.
export function codexContextReading({ tokenUsage, model, measuredAt } = {}) {
  const used = whole(tokenUsage?.last?.totalTokens);
  if (used == null) return null;
  return measuredReading({
    provider: "codex",
    model,
    used,
    window: tokenUsage.modelContextWindow,
    measuredAt,
  });
}

// Claude's context API reports the measured window, which may be a compaction
// limit. Cumulative modelUsage is not occupancy and is not read here.
export function claudeContextReading({ usage, requestedModel, measuredAt } = {}) {
  const used = whole(usage?.totalTokens);
  if (used == null)
    return unreportedReading("claude", requestedModel, measuredAt);
  const reported = typeof usage.model === "string" ? usage.model : null;
  return measuredReading({
    provider: "claude",
    model: !reported || reported === requestedModel ? requestedModel : reported,
    used,
    window: positive(usage.rawMaxTokens) ?? positive(usage.maxTokens),
    percentage: usage.percentage,
    measuredAt,
  });
}

// ACP context occupancy. Cumulative session cost is intentionally ignored.
export function cursorContextReading({ update, model, measuredAt } = {}) {
  if (update?.sessionUpdate !== "usage_update") return null;
  const used = whole(update.used),
    size = whole(update.size);
  if (used == null || size == null) return null;
  return measuredReading({
    provider: "cursor",
    model,
    used,
    window: size,
    measuredAt,
  });
}

export function mergeContext(previous, update) {
  if (!update) return previous ?? null;
  if (update.kind === "compacting" || update.status === "compacting") {
    if (
      previous?.used != null &&
      (!update.provider || update.provider === previous.provider) &&
      (!update.model || !previous.model || update.model === previous.model)
    )
      return { ...previous, status: "compacting" };
    return empty(
      update.provider ?? previous?.provider,
      update.model ?? previous?.model,
      "compacting",
      previous?.measuredAt,
    );
  }
  if (update.kind === "retarget") {
    if (previous?.used != null)
      return {
        ...previous,
        provider: update.provider ?? previous.provider,
        model: update.model ?? previous.model,
        status: "unmeasured",
      };
    return unmeasuredReading(update.provider, update.model, update.measuredAt);
  }
  if (update.kind === "used") {
    const used = whole(update.used);
    if (used == null) return previous ?? null;
    const same =
      previous &&
      previous.provider === update.provider &&
      previous.model === update.model &&
      positive(previous.window);
    return measuredReading({
      provider: update.provider,
      model: update.model,
      used,
      window: same ? previous.window : null,
      measuredAt: update.measuredAt,
    });
  }
  if (update.status === "unreported")
    return unreportedReading(update.provider, update.model, update.measuredAt);
  if (update.status === "unmeasured")
    return unmeasuredReading(update.provider, update.model, update.measuredAt);
  if (update.status === "measured") return measuredReading(update);
  return previous ?? null;
}

export function formatContextTokens(value) {
  if (value >= 1_000_000) {
    const scaled = value / 1_000_000;
    return (
      (scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)).replace(
        /\.0$/,
        "",
      ) + "m"
    );
  }
  if (value >= 10_000) {
    const scaled = value / 1000;
    return (
      (scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)).replace(
        /\.0$/,
        "",
      ) + "k"
    );
  }
  return String(value);
}

function fullCount(reading) {
  const used = reading.used.toLocaleString("en-US");
  return reading.window
    ? `${used} of ${reading.window.toLocaleString("en-US")} context tokens`
    : `${used} context tokens`;
}

// What the composer footer shows. A reading for another provider or model
// stays stored and is not presented as the current window.
export function contextMeterView({
  reading,
  provider,
  model,
  resolvedModel,
  compact = false,
} = {}) {
  const matches =
    reading &&
    reading.provider === provider &&
    (reading.model === model ||
      (resolvedModel && reading.model === resolvedModel));
  const idle = (status, title, aria) => ({
    status,
    text:
      status === "compacting"
        ? "Compacting…"
        : compact
          ? status === "unreported"
            ? "Not reported"
            : "Not measured"
          : status === "unreported"
            ? "Context not reported"
            : "Context not measured",
    title,
    aria,
    dimmed: status === "compacting",
    percentage: null,
  });
  if (!matches) {
    if (reading?.used != null && reading.provider)
      return idle(
        "unmeasured",
        "Not measured for this model.",
        "Context has not been measured for this model.",
      );
    if (provider === "cursor")
      return idle(
        "unreported",
        "Cursor does not report context-window occupancy.",
        "Context occupancy is not reported.",
      );
    return idle(
      "unmeasured",
      "Context occupancy has not been measured for this conversation.",
      "Context occupancy has not been measured.",
    );
  }
  if (reading.status === "compacting" && reading.used == null)
    return idle(
      "compacting",
      "Compacting. The last reading is stale.",
      "Context is compacting. The last reading is stale.",
    );
  if (reading.status === "unreported" || reading.used == null) {
    const unreported = reading.status === "unreported" || provider === "cursor";
    return idle(
      unreported ? "unreported" : "unmeasured",
      unreported
        ? "This provider did not report context-window occupancy."
        : "Context occupancy has not been measured yet.",
      unreported
        ? "Context occupancy is not reported."
        : "Context occupancy has not been measured.",
    );
  }
  if (reading.status === "unmeasured")
    return idle(
      "unmeasured",
      "Not measured for this model.",
      "Context has not been measured for this model.",
    );
  const ratio =
    reading.percentage != null && reading.window
      ? `${reading.percentage}% · ${formatContextTokens(reading.used)}/${formatContextTokens(reading.window)}`
      : `${formatContextTokens(reading.used)} in context`;
  const windowNote =
    provider === "claude"
      ? " The window is the one Claude measured, which may be a compaction limit smaller than the model's hard maximum."
      : "";
  const stale =
    reading.status === "compacting"
      ? " Compacting. The last reading is stale."
      : "";
  const detail = `${fullCount(reading)}. Latest model call. Tool results after that call are not included until the next reading.${windowNote}${stale}`;
  return {
    status: reading.status,
    text: compact && reading.percentage != null ? `${reading.percentage}%` : ratio,
    title: detail,
    aria: detail,
    dimmed: reading.status === "compacting",
    percentage: reading.percentage,
  };
}
