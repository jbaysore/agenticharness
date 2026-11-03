import { isUsageExhausted } from "../security/billing.mjs";

export const USAGE_STALE_AFTER_MS = 5 * 60 * 1000;

export function providerStatusLabel(provider) {
  if (isUsageExhausted(provider?.blockReason)) return "Out of usage";
  if (provider?.blockReason) return "Setup needed";
  if (provider?.connected && provider.usage?.verificationStatus === "unknown")
    return "Usage unknown";
  return provider?.connected ? "Connected" : "Checking…";
}
function confirmedAt(provider) {
  const at = Date.parse(provider?.usage?.lastConfirmedAt ?? "");
  return Number.isFinite(at) ? at : null;
}
// A missed read keeps its last meter. The mark appears only after that meter
// has gone five minutes without a new reading.
export function usageReadingStale(provider, now = Date.now()) {
  if (provider?.usage?.verificationStatus !== "unknown") return false;
  const at = confirmedAt(provider);
  return at != null && now - at >= USAGE_STALE_AFTER_MS;
}
export function usageVerificationLabel(provider, now = Date.now()) {
  if (provider?.usage?.verificationStatus !== "unknown") return null;
  const at = confirmedAt(provider);
  if (at == null) return "Unknown · no confirmed reading";
  if (!usageReadingStale(provider, now)) return null;
  return "Stale · last confirmed at " + new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
// What a chat is asking of you right now, most pressing first. A turn that
// failed or finished stops being marked once the chat has been looked at.
// A usage stop stays until the chat is continued or the flag is dismissed.
export function chatMarker(chat) {
  if (chat?.status === "needs-approval") return "approval";
  if (chat?.status === "running") return "running";
  if (chat?.usage_stopped_at) return "usage";
  if (chat?.unread && ["failed", "interrupted"].includes(chat.status))
    return "failed";
  // An in-progress host watch is the current activity. A finished watch is
  // no longer flagged, so a plain unread result still surfaces on its own.
  if (chat?.watching) return "watching";
  if (!chat?.unread) return null;
  return "unread";
}
export function chatMarkerLabel(marker) {
  return (
    {
      approval: "Waiting for your approval",
      running: "Working",
      watching: "Watching CI",
      usage: "Stopped because usage ran out",
      failed: "Stopped before finishing",
      unread: "Finished since you last looked",
    }[marker] ?? ""
  );
}
// Another model on the provider that just stopped would meet the same
// included-usage limit. Goal mode can only move to Codex or Claude Code.
function continuationCandidate(provider, stoppedProvider) {
  return (
    provider &&
    provider.id !== stoppedProvider &&
    provider.connected &&
    !provider.blockReason &&
    (provider.models ?? []).some((model) => !model.disabled)
  );
}
export function continuationProviders(providers, { stoppedProvider, mode } = {}) {
  return (providers ?? []).filter((provider) => {
    if (!continuationCandidate(provider, stoppedProvider)) return false;
    if (mode === "goal" && ["cursor", "openrouter"].includes(provider.id))
      return false;
    return true;
  });
}
export function continuationUnavailableTitle(
  providers,
  options = {},
) {
  if (continuationProviders(providers, options).length) return "";
  const others = (providers ?? []).filter((provider) =>
    continuationCandidate(provider, options.stoppedProvider),
  );
  if (
    options.mode === "goal" &&
    others.length > 0 &&
    others.every((provider) => ["cursor", "openrouter"].includes(provider.id))
  )
    return "Cursor and OpenRouter cannot take a Goal.";
  return "No other connected agent has usage left.";
}
// Pinned chats lead, most recently pinned first. The rest stay in
// newest-activity order. Pinning does not change that activity time.
export function sidebarOrder(conversations) {
  return [...conversations].sort((a, b) => {
    if (a.pinned_at || b.pinned_at) {
      if (!a.pinned_at) return 1;
      if (!b.pinned_at) return -1;
      const pin = b.pinned_at.localeCompare(a.pinned_at);
      if (pin) return pin;
    }
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  });
}
// Newest activity first, across every project. Pinning does not change
// that activity time.
export function recentChats(conversations) {
  return conversations
    .filter((c) => !c.archived_at)
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
}
export function pinnedChats(conversations) {
  return sidebarOrder(conversations).filter(
    (c) => c.pinned_at && !c.archived_at,
  );
}
export function activeChats(conversations) {
  const order = ["approval", "usage", "failed", "unread", "watching", "running"];
  return conversations
    .filter((c) => !c.archived_at && chatMarker(c))
    .sort(
      (a, b) =>
        order.indexOf(chatMarker(a)) - order.indexOf(chatMarker(b)) ||
        b.updated_at.localeCompare(a.updated_at),
    );
}
// Other chats with a turn in progress in the same project folder as this one.
// A chat in its own worktree shares its folder with nobody.
export function workspacePeers(conversations, projectId, chatId) {
  if (conversations.find((c) => c.id === chatId)?.worktree) return [];
  return conversations.filter(
    (c) =>
      c.project_id === projectId &&
      c.id !== chatId &&
      !c.worktree &&
      ["running", "needs-approval"].includes(c.status),
  );
}
export function workspacePeersLabel(peers) {
  return peers.length
    ? `${peers.length} other ${peers.length === 1 ? "chat" : "chats"} working in this project`
    : "";
}
export function attentionCount(conversations) {
  return activeChats(conversations).filter(
    (c) => !["running", "watching"].includes(chatMarker(c)),
  ).length;
}
// Remaining included usage, one row per reported limit window. An exhausted
// reading still carries those windows; only a reading with no percents is blank.
export function usageWindows(provider) {
  return (provider?.usage?.windows ?? [])
    .filter((w) => typeof w.usedPercent === "number")
    .map((w) => {
      // Claude's native meters use session/weekly_all/weekly_scoped; older
      // readings use five_hour, seven_day, seven_day_opus….
      const [, claudeSpan, scope] =
        /^(five_hour|seven_day)_?(.*)$/.exec(w.bucket ?? "") ?? [];
      const minutes =
        w.windowMinutes ??
        { session: 300, weekly_all: 10080, weekly_scoped: 10080 }[w.bucket] ??
        { five_hour: 300, seven_day: 10080 }[claudeSpan];
      const span = minutes
        ? minutes >= 1440
          ? minutes === 10080
            ? "Weekly"
            : Math.round(minutes / 1440) + "-day"
          : Math.round(minutes / 60) + "-hour"
        : null;
      const bucket = claudeSpan
        ? scope
        : !["session", "weekly_all"].includes(w.bucket) &&
          w.bucket !== provider.id &&
          w.bucket;
      const scopeName =
        w.label ?? (bucket ? String(bucket).replaceAll("_", " ") : null);
      return {
        name:
          [
            scopeName && scopeName[0].toUpperCase() + scopeName.slice(1),
            span && span + " limit",
          ]
            .filter(Boolean)
            .join(" · ") || "Usage limit",
        minutes: minutes ?? null,
        scoped: Boolean(scopeName),
        remaining: Math.max(0, Math.min(100, Math.round(100 - w.usedPercent))),
        resetsAt: resetTimestamp(w.resetsAt),
      };
    });
}
// Providers use Unix seconds or ISO strings. Accept millisecond epochs too,
// and discard malformed timestamps before they reach a visible countdown.
export function resetTimestamp(value) {
  if (value == null || value === "") return null;
  const numeric = typeof value === "number" ||
    (typeof value === "string" && /^[+-]?\d+(\.\d+)?$/.test(value.trim()));
  const at = numeric
    ? Number(value) * (Number(value) < 1e12 ? 1000 : 1)
    : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > 0 && at <= 8.64e15 ? at : null;
}
function usageLevel(remaining) {
  return remaining === null
    ? "unknown"
    : remaining === 0
      ? "out"
      : remaining <= 15
        ? "low"
        : "ok";
}
// This account's Cursor allowance is assumed to refresh at noon local time on
// the 14th of each month. ACP does not report a percentage, so only the date
// is shown.
const CURSOR_RESET_DAY = 14;
const CURSOR_RESET_HOUR = 12;
export function cursorMonthlyReset(now = Date.now()) {
  const current = new Date(now);
  const reset = new Date(
    current.getFullYear(),
    current.getMonth(),
    CURSOR_RESET_DAY,
    CURSOR_RESET_HOUR,
    0,
    0,
    0,
  );
  if (reset.getTime() <= now) reset.setMonth(reset.getMonth() + 1);
  return reset.getTime();
}
export function cursorResetDay(at) {
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
export function cursorResetLabel(at) {
  return (
    "Resets " +
    new Date(at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  );
}
// The tightest limit decides a provider's state. The header shows the 5-hour
// and weekly limits side by side, or the tightest limit when neither exists.
// Cursor has no percentage, so its header row is the next assumed reset.
// A missed read keeps the last of those values instead of blanking the meter.
export function usageGlance(provider, now = Date.now()) {
  const windows = usageWindows(provider);
  const remaining = windows.length
    ? Math.min(...windows.map((w) => w.remaining))
    : null;
  const level =
    providerStatusLabel(provider) === "Out of usage"
      ? "out"
      : usageLevel(remaining);
  const general = windows.filter((w) => !w.scoped && w.minutes);
  const bars = [
    general.find((w) => w.minutes < 1440),
    general.find((w) => w.minutes >= 1440),
  ]
    .filter(Boolean)
    .map((w) => ({
      name: w.name,
      short: w.minutes < 1440 ? Math.round(w.minutes / 60) + "h" : "wk",
      remaining: w.remaining,
      level: usageLevel(w.remaining),
      resetsAt: w.resetsAt,
    }));
  const assumedCursorReset = provider?.id === "cursor" && !windows.length;
  return {
    remaining,
    level,
    bars: bars.length
      ? bars
      : [{
          name: assumedCursorReset ? "Monthly reset" : "Usage",
          short: "",
          remaining,
          level,
          resetsAt: assumedCursorReset ? cursorMonthlyReset(now) : null,
          dateOnly: assumedCursorReset,
        }],
  };
}
// Compact time until a reset for the top bar: "45m", "3h 40m", "4d 6h".
// Rounds up, so the meter is never back later than the header says.
export function resetCountdown(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return "";
  const minutes = Math.max(0, Math.ceil((at - now) / 60000));
  if (minutes < 60) return minutes + "m";
  if (minutes < 1440)
    return `${Math.floor(minutes / 60)}h` + (minutes % 60 ? ` ${minutes % 60}m` : "");
  const hours = Math.ceil(minutes / 60);
  return `${Math.floor(hours / 24)}d` + (hours % 24 ? ` ${hours % 24}h` : "");
}
export function resetLabel(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return "";
  const minutes = Math.max(0, Math.ceil((at - now) / 60000));
  if (minutes < 60) return `Resets in ${minutes}m`;
  if (minutes < 1440)
    return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return (
    "Resets " +
    new Date(at).toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    })
  );
}
