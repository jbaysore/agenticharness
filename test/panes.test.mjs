import test from "node:test";
import assert from "node:assert/strict";
import {
  closePane,
  focusedPane,
  focusPane,
  initialPanes,
  maxPanes,
  movePane,
  openBeside,
  openInFocused,
  parseSearch,
  readPanes,
  savePanes,
  setPaneChat,
  showHome,
  toSearch,
  visiblePanes,
} from "../src/ui/panes.mjs";
const chats = (state) => state.panes.map((p) => p.chatId);

test("a workspace starts with one empty pane and opens a chat in it", () => {
  let state = initialPanes();
  assert.deepEqual(chats(state), [null]);
  const blank = state.focused;
  state = openInFocused(state, "a", "project");
  assert.deepEqual(chats(state), ["a"]);
  assert.notEqual(state.focused, blank);
  assert.equal(focusedPane(state).projectId, "project");
});
test("opening beside adds panes after the focused one, up to three", () => {
  let state = openInFocused(initialPanes(), "a");
  state = openBeside(state, "b");
  state = focusPane(state, state.panes[0].key);
  state = openBeside(state, "c");
  assert.deepEqual(chats(state), ["a", "c", "b"]);
  assert.equal(focusedPane(state).chatId, "c");
  state = openBeside(state, "d");
  assert.deepEqual(chats(state), ["a", "d", "b"]);
  assert.equal(openBeside(state, null), state);
});
test("the narrower limit of the window is respected when opening beside", () => {
  const state = openBeside(openInFocused(initialPanes(), "a"), "b", "", 1);
  assert.deepEqual(chats(state), ["b"]);
});
test("a chat already open is focused instead of opened twice", () => {
  let state = openBeside(openInFocused(initialPanes(), "a"), "b");
  const first = state.panes[0].key;
  assert.equal(openInFocused(state, "a").focused, first);
  assert.equal(openBeside(state, "a").focused, first);
  assert.deepEqual(chats(openBeside(state, "a")), ["a", "b"]);
});
test("an empty focused pane is filled rather than left beside a new one", () => {
  let state = openBeside(openInFocused(initialPanes(), "a"), null, "project");
  assert.deepEqual(chats(state), ["a", null]);
  assert.equal(focusedPane(state).projectId, "project");
  state = openBeside(state, "b");
  assert.deepEqual(chats(state), ["a", "b"]);
});
test("a pane keeps its key when it creates its own chat", () => {
  const state = initialPanes(),
    next = setPaneChat(state, state.focused, "new");
  assert.equal(next.focused, state.focused);
  assert.deepEqual(chats(next), ["new"]);
});
test("closing moves focus to a neighbour and never leaves zero panes", () => {
  let state = initialPanes(["a", "b", "c"], 1);
  assert.equal(focusedPane(state).chatId, "b");
  state = closePane(state, state.focused);
  assert.deepEqual(chats(state), ["a", "c"]);
  assert.equal(focusedPane(state).chatId, "c");
  state = closePane(state, state.panes[0].key);
  assert.equal(focusedPane(state).chatId, "c");
  state = closePane(state, state.focused, "project");
  assert.deepEqual(chats(state), [null]);
  assert.equal(focusedPane(state).projectId, "project");
  assert.equal(closePane(state, "missing"), state);
});

test("reordering moves panes in both directions without changing their identity or focus", () => {
  const state = initialPanes(["a", "b", "c"], 1),
    [a, b, c] = state.panes;
  const moved = movePane(state, a.key, c.key);
  assert.deepEqual(chats(moved), ["b", "c", "a"]);
  assert.equal(moved.focused, b.key);
  assert.equal(moved.panes[0], b);
  assert.equal(moved.panes[1], c);
  assert.equal(moved.panes[2], a);
  assert.deepEqual(chats(state), ["a", "b", "c"]);
  assert.deepEqual(movePane(moved, a.key, b.key), state);
  assert.deepEqual(chats(movePane(state, a.key, b.key)), ["b", "a", "c"]);
  assert.equal(movePane(state, a.key, a.key), state);
  assert.equal(movePane(state, "missing", a.key), state);
  assert.equal(movePane(state, a.key, "missing"), state);
});
test("the window width decides how many panes show, keeping the focused one", () => {
  assert.equal(maxPanes(1920, 246), 3);
  assert.equal(maxPanes(1366, 246), 2);
  assert.equal(maxPanes(1000, 246), 1);
  assert.equal(maxPanes(390, 0), 1);
  assert.equal(maxPanes(200, 0), 1);
  const state = initialPanes(["a", "b", "c"], 2);
  assert.deepEqual(
    visiblePanes(state, 2).map((p) => p.chatId),
    ["b", "c"],
  );
  assert.deepEqual(
    visiblePanes(state, 1).map((p) => p.chatId),
    ["c"],
  );
  assert.deepEqual(
    visiblePanes(focusPane(state, state.panes[0].key), 2).map((p) => p.chatId),
    ["a", "b"],
  );
  assert.equal(visiblePanes(state, 3), state.panes);
});
test("home is one new conversation and stays put when that is already open", () => {
  const split = openBeside(openInFocused(initialPanes(), "a"), "b");
  const home = showHome(split, "project");
  assert.deepEqual(chats(home), [null]);
  assert.equal(focusedPane(home).projectId, "project");
  assert.equal(toSearch(home), "/");
  assert.equal(showHome(home, "project"), home);
  const unnamed = initialPanes();
  assert.equal(showHome(unnamed, "project"), unnamed);
  const elsewhere = showHome(home, "other");
  assert.notEqual(elsewhere, home);
  assert.equal(focusedPane(elsewhere).projectId, "other");
  assert.equal(toSearch(showHome(openInFocused(initialPanes(), "a"))), "/");
});
test("open chats round-trip through the address and a single-chat link still works", () => {
  const state = initialPanes(["a", "b"]);
  assert.equal(toSearch(state), "/?chat=a,b");
  assert.deepEqual(parseSearch("?chat=a,b"), ["a", "b"]);
  assert.deepEqual(parseSearch("?chat=a"), ["a"]);
  assert.deepEqual(parseSearch("?chat=a,a,,b,c,d"), ["a", "b", "c"]);
  assert.deepEqual(parseSearch(""), []);
  assert.equal(toSearch(initialPanes()), "/");
});
test("the pane layout is remembered, and broken storage opens an empty workspace", () => {
  const data = new Map(),
    storage = {
      getItem: (k) => data.get(k),
      setItem: (k, v) => data.set(k, v),
    };
  let state = openBeside(openInFocused(initialPanes(), "a"), "b");
  state = openBeside(state, null);
  assert.equal(savePanes(state, storage), true);
  assert.deepEqual(readPanes(storage), { chats: ["a", "b"], focused: 0 });
  savePanes(focusPane(state, state.panes[1].key), storage);
  assert.deepEqual(readPanes(storage), { chats: ["a", "b"], focused: 1 });
  assert.deepEqual(readPanes({ getItem: () => "{broken" }), {
    chats: [],
    focused: 0,
  });
  assert.deepEqual(
    readPanes({ getItem: () => JSON.stringify({ chats: "a", focused: "x" }) }),
    { chats: [], focused: 0 },
  );
  const blocked = {
    getItem: () => {
      throw Error("disabled");
    },
    setItem: () => {
      throw Error("disabled");
    },
  };
  assert.deepEqual(readPanes(blocked), { chats: [], focused: 0 });
  assert.equal(savePanes(state, blocked), false);
});
