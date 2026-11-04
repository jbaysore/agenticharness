import test from "node:test";
import assert from "node:assert/strict";
import { cursorMoveFor } from "../src/ui/terminal-click.mjs";

// Rows of text, one cell per character except "＊", which is two cells wide.
// A row starting with "~" continues the row above it.
const screen = (rows, cursorY, cursorX, cols = 10) => {
  const lines = rows.map((text) => {
    const isWrapped = text.startsWith("~"),
      cells = [];
    for (const ch of isWrapped ? text.slice(1) : text) {
      if (ch === "＊") cells.push(2, 0);
      else cells.push(1);
    }
    return {
      isWrapped,
      translateToString: () => "x".repeat(cells.length),
      getCell: (x) => ({ getWidth: () => (x < cells.length ? cells[x] : 1) }),
    };
  });
  return {
    buffer: { baseY: 0, cursorY, cursorX, getLine: (y) => lines[y] },
    cols,
  };
};
const left = (n) => "\x1b[D".repeat(n),
  right = (n) => "\x1b[C".repeat(n);

test("a click on the typed line walks the cursor there", () => {
  const { buffer, cols } = screen(["PS> abcdef"], 0, 10);
  assert.equal(cursorMoveFor(buffer, { cols, col: 6, row: 0 }), left(4));
  const mid = screen(["PS> abcdef"], 0, 5);
  assert.equal(cursorMoveFor(mid.buffer, { cols, col: 8, row: 0 }), right(3));
});

test("a click past the text stops at its end", () => {
  const { buffer } = screen(["PS> ab"], 0, 4, 20);
  assert.equal(cursorMoveFor(buffer, { cols: 20, col: 15, row: 0 }), right(2));
});

test("wrapped rows of a long command count as one line", () => {
  const { buffer, cols } = screen(["PS> abcdef", "~ghijkl"], 0, 5);
  assert.equal(cursorMoveFor(buffer, { cols, col: 2, row: 1 }), right(7));
  const below = screen(["PS> abcdef", "~ghijkl"], 1, 3);
  assert.equal(cursorMoveFor(below.buffer, { cols, col: 8, row: 0 }), left(5));
});

test("clicks on earlier output do nothing", () => {
  const { buffer, cols } = screen(["old output", "PS> ab"], 1, 6);
  assert.equal(cursorMoveFor(buffer, { cols, col: 3, row: 0 }), "");
});

test("a wide character is one step", () => {
  const { buffer, cols } = screen(["PS> a＊b"], 0, 8);
  assert.equal(cursorMoveFor(buffer, { cols, col: 4, row: 0 }), left(3));
  // Its right half stands for the character itself.
  assert.equal(cursorMoveFor(buffer, { cols, col: 6, row: 0 }), left(2));
});

test("application cursor mode uses its own arrow keys", () => {
  const { buffer, cols } = screen(["PS> abc"], 0, 7);
  assert.equal(
    cursorMoveFor(buffer, { cols, col: 5, row: 0, applicationCursor: true }),
    "\x1bOD\x1bOD",
  );
});
