const key = "harness.pending-submissions.v2";
const legacyKey = "harness.pending-submission.v1";
const valid = (p) =>
  p &&
  typeof p.actionId === "string" &&
  typeof p.chatId === "string" &&
  typeof p.text === "string";
// One unconfirmed submission per chat; a single entry saved by an older build is kept.
export function readAllPending(storage = window.sessionStorage) {
  try {
    const saved = JSON.parse(storage.getItem(key) ?? "{}") ?? {},
      legacy = JSON.parse(storage.getItem(legacyKey) ?? "null"),
      pending = {};
    for (const p of [legacy, ...Object.values(saved)])
      if (valid(p)) pending[p.chatId] = p;
    return pending;
  } catch {
    return {};
  }
}
export function readPending(chatId, storage = window.sessionStorage) {
  return readAllPending(storage)[chatId] ?? null;
}
// A send paints before the chat snapshot returns. Keep that local row until
// the snapshot has the same user message or queued action.
export function keepPendingMessages(previous, incoming) {
  const messages = incoming?.messages ?? [];
  const queue = incoming?.queue ?? [];
  const runs = incoming?.runs ?? [];
  const claimed = new Set();
  const keptMessages = (previous?.messages ?? []).filter((message) => {
    if (!message?.pending) return false;
    const run = message.actionId
      ? runs.find((item) => item.action_id === message.actionId)
      : null;
    const runId = message.run_id ?? run?.id ?? null;
    const index = messages.findIndex(
      (row, i) =>
        !claimed.has(i) &&
        row.role === "user" &&
        !row.pending &&
        !!runId &&
        row.run_id === runId &&
        (row.content ?? "") === (message.content ?? ""),
    );
    if (index < 0) return true;
    claimed.add(index);
    return false;
  });
  const keptQueue = (previous?.queue ?? []).filter((item) => {
    if (!item?.pending) return false;
    if (
      queue.some((row) => (row.action_id ?? row.actionId) === item.actionId)
    )
      return false;
    const run = runs.find((entry) => entry.action_id === item.actionId);
    return !(
      run &&
      messages.some((row) => row.role === "user" && row.run_id === run.id)
    );
  });
  if (!keptMessages.length && !keptQueue.length) return incoming;
  return {
    ...incoming,
    messages: [...messages, ...keptMessages],
    queue: [...queue, ...keptQueue],
  };
}
export function savePending(chatId, value, storage = window.sessionStorage) {
  try {
    const pending = readAllPending(storage);
    if (value) pending[chatId] = value;
    else delete pending[chatId];
    storage.removeItem(legacyKey);
    if (Object.keys(pending).length)
      storage.setItem(key, JSON.stringify(pending));
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
