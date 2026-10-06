const key = "harness.pending-submission.v1";
export function readPending(storage = window.sessionStorage) {
  try {
    const p = JSON.parse(storage.getItem(key) ?? "null");
    return p &&
      typeof p.actionId === "string" &&
      typeof p.chatId === "string" &&
      typeof p.text === "string"
      ? p
      : null;
  } catch {
    return null;
  }
}
export function savePending(value, storage = window.sessionStorage) {
  try {
    if (value) storage.setItem(key, JSON.stringify(value));
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
