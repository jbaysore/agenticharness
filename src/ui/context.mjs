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
    level: percent >= 90 ? "high" : percent >= 75 ? "elevated" : "normal",
    updating: active && !compacting,
    outdated: reading?.state === "outdated",
  };
}

export function cacheReuse(usage) {
  const input = tokenCount(usage?.inputTokens),
    read = tokenCount(usage?.cacheReadTokens);
  return input > 0 && read !== null && read <= input
    ? (read / input) * 100
    : null;
}
