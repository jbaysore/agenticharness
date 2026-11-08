const live = (watch) =>
  ["registering", "pending", "settling", "retrying"].includes(watch.status);

// A finished watch card belongs to the turn that registered it, so later turns
// scroll past it like any other message. Each is shown just before the first
// user message sent after it was created; one with no later message stays at
// the end (key null). A watch still in progress always stays at the end, so a
// later turn cannot bury what the chat is waiting on.
export function placeWatches(messages = [], watches = []) {
  const users = messages
    .filter((m) => m.role !== "assistant")
    .map((m) => ({ id: m.id, at: Date.parse(m.created_at) }));
  const placed = new Map();
  for (const watch of watches) {
    const next =
      !live(watch) && Number.isFinite(watch.createdAt)
        ? users.find((m) => m.at > watch.createdAt)
        : null;
    const key = next?.id ?? null;
    placed.set(key, [...(placed.get(key) ?? []), watch]);
  }
  return placed;
}
