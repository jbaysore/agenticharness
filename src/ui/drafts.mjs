const key = "harness.drafts.v1";
function readAll(storage, storageKey = key) {
  try {
    const drafts = JSON.parse(storage.getItem(storageKey) ?? "{}");
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

const attachmentKey = "harness.draft-attachments.v1";
export function readDraftAttachments(id, storage = window.sessionStorage) {
  const files = readAll(storage, attachmentKey)[id];
  return Array.isArray(files)
    ? files.filter(
        (f) => f && typeof f.id === "string" && typeof f.name === "string",
      )
    : [];
}
export function saveDraftAttachments(
  id,
  files,
  storage = window.sessionStorage,
) {
  try {
    const drafts = readAll(storage, attachmentKey);
    if (files.length) drafts[id] = files;
    else delete drafts[id];
    if (Object.keys(drafts).length)
      storage.setItem(attachmentKey, JSON.stringify(drafts));
    else storage.removeItem(attachmentKey);
    return true;
  } catch {
    return false;
  }
}
export function hasComposerDraft(id, storage = window.sessionStorage) {
  return Boolean(
    readDraft(id, storage).trim() || readDraftAttachments(id, storage).length,
  );
}
