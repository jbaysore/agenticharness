// Which chats are open side by side. A pane's key is its identity: replacing
// the chat in a pane makes a new key, so the composer starts fresh for it.
export const MAX_PANES = 3;
export const MIN_PANE_WIDTH = 390;
const storageKey = "harness.panes.v1";
let created = 0;
const pane = (chatId = null, projectId = "") => ({
  key: "pane-" + ++created,
  chatId,
  projectId,
});
const unique = (ids) =>
  [...new Set(ids.filter((id) => typeof id === "string" && id))].slice(
    0,
    MAX_PANES,
  );

export function initialPanes(chatIds = [], focusedIndex = 0) {
  const panes = unique(chatIds).map((id) => pane(id));
  if (!panes.length) panes.push(pane());
  return { panes, focused: (panes[focusedIndex] ?? panes[0]).key };
}
export function focusedPane(state) {
  return state.panes.find((p) => p.key === state.focused) ?? state.panes[0];
}
export function focusPane(state, key) {
  return state.focused === key || !state.panes.some((p) => p.key === key)
    ? state
    : { ...state, focused: key };
}
// Move the existing pane so its composer and reading position stay with it.
export function movePane(state, key, targetKey) {
  const from = state.panes.findIndex((p) => p.key === key),
    to = state.panes.findIndex((p) => p.key === targetKey);
  if (from < 0 || to < 0 || from === to) return state;
  const panes = [...state.panes];
  panes.splice(to, 0, panes.splice(from, 1)[0]);
  return { ...state, panes };
}
// A chat is only ever open once; asking for it again moves focus to it.
export function openInFocused(state, chatId, projectId = "") {
  const existing = chatId && state.panes.find((p) => p.chatId === chatId);
  if (existing) return focusPane(state, existing.key);
  const next = pane(chatId, projectId),
    target = focusedPane(state).key;
  return {
    panes: state.panes.map((p) => (p.key === target ? next : p)),
    focused: next.key,
  };
}
export function openBeside(state, chatId, projectId = "", limit = MAX_PANES) {
  const existing = chatId && state.panes.find((p) => p.chatId === chatId);
  if (existing) return focusPane(state, existing.key);
  const current = focusedPane(state);
  if (!current.chatId)
    return chatId ? openInFocused(state, chatId, projectId) : state;
  if (state.panes.length >= Math.min(limit, MAX_PANES))
    return chatId ? openInFocused(state, chatId, projectId) : state;
  const next = pane(chatId, projectId),
    index = state.panes.indexOf(current);
  return {
    panes: [
      ...state.panes.slice(0, index + 1),
      next,
      ...state.panes.slice(index + 1),
    ],
    focused: next.key,
  };
}
// The pane keeps its key when it creates its own chat, so nothing typed is lost.
export function setPaneChat(state, key, chatId) {
  return {
    ...state,
    panes: state.panes.map((p) => (p.key === key ? { ...p, chatId } : p)),
  };
}
export function closePane(state, key, projectId = "") {
  const index = state.panes.findIndex((p) => p.key === key);
  if (index < 0) return state;
  const panes = state.panes.filter((p) => p.key !== key);
  if (!panes.length) {
    const blank = pane(null, projectId);
    return { panes: [blank], focused: blank.key };
  }
  return {
    panes,
    focused:
      state.focused === key
        ? panes[Math.min(index, panes.length - 1)].key
        : state.focused,
  };
}
export function maxPanes(viewport, leftSpace = 0) {
  return Math.min(
    MAX_PANES,
    Math.max(1, Math.floor((viewport - leftSpace) / MIN_PANE_WIDTH)),
  );
}
// When the window is too narrow for every pane, the focused one always shows.
export function visiblePanes(state, limit) {
  if (state.panes.length <= limit) return state.panes;
  const index = state.panes.indexOf(focusedPane(state)),
    start = Math.max(0, index - limit + 1);
  return state.panes.slice(start, start + limit);
}
export function parseSearch(search) {
  return unique((new URLSearchParams(search).get("chat") ?? "").split(","));
}
export function toSearch(state) {
  const ids = state.panes.map((p) => p.chatId).filter(Boolean);
  return ids.length ? "/?chat=" + ids.join(",") : "/";
}
export function readPanes(storage = window.localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(storageKey) ?? "null");
    return {
      chats: unique(Array.isArray(saved?.chats) ? saved.chats : []),
      focused: Number.isInteger(saved?.focused) ? saved.focused : 0,
    };
  } catch {
    return { chats: [], focused: 0 };
  }
}
export function savePanes(state, storage = window.localStorage) {
  try {
    const open = state.panes.filter((p) => p.chatId);
    storage.setItem(
      storageKey,
      JSON.stringify({
        chats: open.map((p) => p.chatId),
        focused: Math.max(0, open.indexOf(focusedPane(state))),
      }),
    );
    return true;
  } catch {
    return false;
  }
}
