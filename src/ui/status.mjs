export function providerStatusLabel(provider) {
  if (
    provider?.blockReason &&
    /exhausted|usage limit has been reached/i.test(provider.blockReason)
  )
    return "Out of usage";
  if (provider?.blockReason) return "Setup needed";
  if (provider?.connected && provider.usage?.verificationStatus === "unknown")
    return "Usage unknown";
  return provider?.connected ? "Connected" : "Checking…";
}
export function usageVerificationLabel(provider) {
  if (provider?.usage?.verificationStatus !== "unknown") return null;
  const at = provider.usage.lastConfirmedAt;
  if (!at) return "Unknown · no confirmed reading";
  return "Unknown · last confirmed at " + new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
// What a chat is asking of you right now, most pressing first. A turn that
// failed or finished stops being marked once the chat has been looked at.
export function chatMarker(chat) {
  if (chat?.status === "needs-approval") return "approval";
  if (chat?.status === "running") return "running";
  if (!chat?.unread) return null;
  return ["failed", "interrupted"].includes(chat.status) ? "failed" : "unread";
}
export function chatMarkerLabel(marker) {
  return (
    {
      approval: "Waiting for your approval",
      running: "Working",
      failed: "Stopped before finishing",
      unread: "Finished since you last looked",
    }[marker] ?? ""
  );
}
export function activeChats(conversations) {
  const order = ["approval", "failed", "unread", "running"];
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
  return activeChats(conversations).filter((c) => chatMarker(c) !== "running")
    .length;
}
// Remaining included usage, one row per provider limit window.
export function usageWindows(provider) {
  if (!provider?.usage?.authoritative && !provider?.usage?.lastConfirmedAt) return [];
  return (provider.usage.windows ?? [])
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
        resetsAt:
          w.resetsAt == null
            ? null
            : typeof w.resetsAt === "number"
              ? w.resetsAt * 1000
              : Date.parse(w.resetsAt) || null,
      };
    });
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
// The tightest limit decides a provider's state. The header shows the 5-hour
// and weekly limits side by side, or the tightest limit when neither exists.
export function usageGlance(provider) {
  const windows = usageWindows(provider),
    unknown = provider?.usage?.verificationStatus === "unknown";
  const remaining = !unknown && windows.length
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
      remaining: unknown ? null : w.remaining,
      level: unknown ? "unknown" : usageLevel(w.remaining),
    }));
  return {
    remaining,
    level,
    bars: bars.length ? bars : [{ name: "Usage", short: "", remaining, level }],
  };
}
export function resetLabel(at, now = Date.now()) {
  if (!at) return "";
  const minutes = Math.max(0, Math.round((at - now) / 60000));
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
