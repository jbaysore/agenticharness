// Which project folders are open in the sidebar. `null` means the user has
// not chosen yet, so only the selected project is open. An array, including
// an empty one, is an explicit choice and is remembered.
export const folderStorageKey = "harness.sidebar-folders.v1";

export function readExpandedFolders(raw) {
  if (raw == null || raw === "") return null;
  try {
    const saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.expanded)) return null;
    return [
      ...new Set(saved.expanded.filter((id) => typeof id === "string" && id)),
    ];
  } catch {
    return null;
  }
}

export function openFolderIds(saved, selectedId) {
  if (saved !== null) return saved;
  return selectedId ? [selectedId] : [];
}

export function toggleFolder(open, id) {
  return open.includes(id) ? open.filter((item) => item !== id) : [...open, id];
}

export function expandFolder(open, id) {
  return open.includes(id) ? open : [...open, id];
}

// "expand" keeps an implicit choice implicit. "toggle" records an explicit one.
export function changeFolders(saved, selectedId, id, action) {
  if (action === "expand" && saved === null) return null;
  const open = saved ?? (selectedId ? [selectedId] : []);
  return action === "toggle" ? toggleFolder(open, id) : expandFolder(open, id);
}
