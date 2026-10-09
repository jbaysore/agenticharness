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
