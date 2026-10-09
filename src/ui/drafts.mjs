const key = "harness.drafts.v1";
function readAll(storage) {
  try {
    const drafts = JSON.parse(storage.getItem(key) ?? "{}");
    return drafts && typeof drafts === "object" && !Array.isArray(drafts)
      ? drafts
      : {};
  } catch {
    return {};
  }
}
export function readDraft(id, storage = window.sessionStorage) {
  const draft = readAll(storage)[id];
  return typeof draft === "string" ? draft : "";
}
export function saveDraft(id, text, storage = window.sessionStorage) {
  try {
    const drafts = readAll(storage);
    if (text) drafts[id] = text;
    else delete drafts[id];
    if (Object.keys(drafts).length)
      storage.setItem(key, JSON.stringify(drafts));
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
