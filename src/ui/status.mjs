export function providerStatusLabel(provider) {
  if (
    provider?.blockReason &&
    /exhausted|usage limit has been reached/i.test(provider.blockReason)
  )
    return "Out of usage";
  if (provider?.blockReason) return "Setup needed";
  return provider?.connected ? "Connected" : "Checking…";
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
// Other chats with a turn in progress in the same project as this one.
export function workspacePeers(conversations, projectId, chatId) {
  return conversations.filter(
    (c) =>
      c.project_id === projectId &&
      c.id !== chatId &&
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
