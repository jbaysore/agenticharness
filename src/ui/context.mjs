import { tokenCount } from "../core/context.mjs";

// An HTTP snapshot can arrive after a newer context event. Preserve the
// newer reading without delaying the rest of the snapshot's chat state.
export function mergeContextSnapshots(
  current = {},
  incoming = {},
  snapshotEventId,
) {
  const merged = { ...incoming };
  for (const [provider, reading] of Object.entries(current))
    if (reading.eventId > (snapshotEventId ?? incoming[provider]?.eventId ?? 0))
      merged[provider] = reading;
  return merged;
}

export function contextView(
  snapshot,
  { model, active = false, started = false } = {},
) {
  const matches = snapshot?.model === model;
  const reading = matches ? snapshot : null;
  const used = tokenCount(reading?.usedTokens),
    window = tokenCount(reading?.windowTokens);
  const compacting = reading?.state === "compacting";
  const percent =
    used !== null && window > 0 && !compacting ? (used / window) * 100 : null;
  // Usage warnings follow the provider's compaction point when it reports one;
  // a 1M window that compacts at 600k should warn before 600k, not 750k.
  const compactAt = tokenCount(reading?.compactAtTokens),
    limit = compactAt > 0 && (!window || compactAt < window) ? compactAt : window,
    pressure =
      used !== null && limit > 0 && !compacting ? (used / limit) * 100 : null;
  const waiting = active || !started;
  const label =
    !matches && snapshot
      ? "Waiting for model context"
      : compacting
        ? "Updating after compaction"
        : percent !== null
          ? `${reading.accuracy !== "provider-reported" || reading.basis === "last-request" ? "≈ " : ""}Context ${Math.round(percent)}%`
          : used !== null
            ? "Context · limit unavailable"
            : reading?.state === "unavailable"
              ? "Context unavailable"
              : waiting
                ? "Waiting for context data"
                : "Context unavailable";
  return {
    reading,
    previous: !matches ? snapshot : null,
    used,
    window,
    percent,
    fill: percent === null ? 0 : Math.min(100, percent),
    label,
    compactAt: limit !== window ? limit : null,
    level: pressure >= 90 ? "high" : pressure >= 75 ? "elevated" : "normal",
    updating: active && !compacting,
    outdated: reading?.state === "outdated",
    usageWarning: contextUsageWarning({ percent: pressure, compacting }),
  };
}

// A large window is reread on every turn. Included usage still moves when
// those tokens are cache reads, so a full context can spend a session limit
// before the provider compacts.
export function contextUsageWarning({ percent, compacting = false } = {}) {
  if (compacting || percent == null || percent < 75) return null;
  return percent >= 90
    ? {
        level: "high",
        label: "Needs compaction",
        detail:
          "Context is nearly full and compaction has not run. Each turn rereads almost this whole window. Included usage still rises when those tokens are cache reads, and one turn can spend a large share of a usage window. Compact this chat, or continue from a fresh chat that keeps only the current state.",
      }
    : {
        level: "elevated",
        label: "Costs usage",
        detail:
          "This conversation is large enough that each turn rereads it. Included usage rises faster, including cached tokens. Compaction is what shrinks the transcript.",
      };
}

export function cacheReuse(usage) {
  const input = tokenCount(usage?.inputTokens),
    read = tokenCount(usage?.cacheReadTokens);
  return input > 0 && read !== null && read <= input
    ? (read / input) * 100
    : null;
}
