// Which chats and terminals are open together. A pane's key is its identity:
// replacing what a pane shows makes a new key, so the composer starts fresh.
// One to three panes share a row. Four panes are a two-by-two grid.
export const MAX_PANES = 4;
export const MIN_PANE_WIDTH = 390;
const storageKey = "harness.panes.v1";
let created = 0;
const pane = (chatId = null, projectId = "", terminalId = null) => ({
  key: "pane-" + ++created,
  chatId,
  projectId,
  terminalId,
});
const occupied = (p) => !!(p.chatId || p.terminalId);
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
// A terminal is open at most once too. Beside only splits when there is room.
export function openTerminal(
  state,
  terminalId,
  projectId = "",
  beside = false,
  limit = MAX_PANES,
) {
  const existing = state.panes.find((p) => p.terminalId === terminalId);
  if (existing) return focusPane(state, existing.key);
  const current = focusedPane(state),
    next = pane(null, projectId, terminalId);
  if (
    beside &&
    occupied(current) &&
    canOpenAnother(state.panes.length, limit)
  ) {
    const index = state.panes.indexOf(current);
    return {
      panes: [
        ...state.panes.slice(0, index + 1),
        next,
        ...state.panes.slice(index + 1),
      ],
      focused: next.key,
    };
  }
  return {
    panes: state.panes.map((p) => (p.key === current.key ? next : p)),
    focused: next.key,
  };
}
// `limit` is how many columns the window can hold, not a pane count.
export function openBeside(state, chatId, projectId = "", limit = MAX_PANES) {
  const existing = chatId && state.panes.find((p) => p.chatId === chatId);
  if (existing) return focusPane(state, existing.key);
  const current = focusedPane(state);
  if (!occupied(current))
    return chatId ? openInFocused(state, chatId, projectId) : state;
  if (!canOpenAnother(state.panes.length, limit))
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
// Home is one fresh conversation. Staying there keeps whatever is already typed.
export function showHome(state, projectId = "") {
  const only = state.panes.length === 1 ? state.panes[0] : null;
  if (only && !occupied(only) && (only.projectId || projectId) === projectId)
    return state;
  const blank = pane(null, projectId);
  return { panes: [blank], focused: blank.key };
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
// Four panes use two columns. Fewer panes stay on one row, one column each.
export function columnsFor(count) {
  return count === 4 ? 2 : Math.max(1, count);
}
export function columnBudget(viewport, leftSpace = 0) {
  return Math.max(1, Math.floor((viewport - leftSpace) / MIN_PANE_WIDTH));
}
export function canOpenAnother(openCount, budget) {
  const next = openCount + 1;
  return next <= MAX_PANES && columnsFor(next) <= Math.max(1, budget);
}
// The largest count that still fits. Four stay visible on a two-column window.
export function visibleCount(openCount, budget) {
  const room = Math.max(1, budget);
  for (let n = Math.min(openCount, MAX_PANES); n > 1; n--) {
    if (columnsFor(n) <= room) return n;
  }
  return 1;
}
// How many panes you can reach by opening one at a time at this width.
export function maxPanes(viewport, leftSpace = 0) {
  const budget = columnBudget(viewport, leftSpace);
  let count = 1;
  while (canOpenAnother(count, budget)) count += 1;
  return count;
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
// The full arrangement, terminals included, so a reload puts every pane back
// in the same order. Chats alone are also kept in savePanes for addresses.
const layoutKey = "harness.layout.v1";
export function saveLayout(state, storage = window.localStorage) {
  try {
    const open = state.panes.filter(occupied);
    storage.setItem(
      layoutKey,
      JSON.stringify({
        items: open.map((p) =>
          p.terminalId
            ? { terminalId: p.terminalId, projectId: p.projectId }
            : { chatId: p.chatId },
        ),
        focused: Math.max(0, open.indexOf(focusedPane(state))),
      }),
    );
    return true;
  } catch {
    return false;
  }
}
export function readLayout(storage = window.localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(layoutKey) ?? "null"),
      items = (Array.isArray(saved?.items) ? saved.items : []).filter(
        (item) =>
          typeof item?.chatId === "string" ||
          typeof item?.terminalId === "string",
      );
    return {
      items: items.slice(0, MAX_PANES),
      focused: Number.isInteger(saved?.focused) ? saved.focused : 0,
    };
  } catch {
    return { items: [], focused: 0 };
  }
}
// Rebuild panes from saved items, dropping chats and terminals that are gone.
export function restoreLayout(items, focused, exists) {
  const seen = new Set(),
    kept = [];
  items.forEach((item, index) => {
    const id = item.chatId ?? item.terminalId;
    if (seen.has(id) || !exists(item)) return;
    seen.add(id);
    kept.push({ item, focus: index === focused });
  });
  if (!kept.length) return null;
  kept.splice(MAX_PANES);
  const panes = kept.map(({ item }) =>
    item.terminalId
      ? pane(null, item.projectId ?? "", item.terminalId)
      : pane(item.chatId),
  );
  const at = kept.findIndex((k) => k.focus);
  return { panes, focused: panes[Math.max(0, at)].key };
}
