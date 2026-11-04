// A shell can't be told "put the cursor here", so a click on the line being
// typed becomes the arrow presses that walk the cursor there, as xterm's own
// Alt+click does. The line includes the wrapped rows of a long command; clicks
// anywhere else give nothing.
export function cursorMoveFor(buffer, { cols, col, row, applicationCursor }) {
  const cursorRow = buffer.baseY + buffer.cursorY,
    cursorCol = buffer.cursorX;
  let first = cursorRow,
    last = cursorRow;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  while (buffer.getLine(last + 1)?.isWrapped) last++;
  if (row < first || row > last) return "";
  col = Math.max(0, Math.min(col, cols - 1));
  // Past the end of the typed text means the end of it, not empty space.
  if (row === last) {
    let end = buffer.getLine(last)?.translateToString(true).length ?? 0;
    if (cursorRow === last) end = Math.max(end, cursorCol);
    col = Math.min(col, end);
  }
  // The right half of a wide character belongs to the character before it.
  while (col > 0 && buffer.getLine(row)?.getCell(col)?.getWidth() === 0) col--;
  const from = cursorRow * cols + cursorCol,
    to = row * cols + col;
  let steps = 0;
  for (let i = Math.min(from, to); i < Math.max(from, to); i++) {
    const width = buffer
      .getLine(Math.floor(i / cols))
      ?.getCell(i % cols)
      ?.getWidth();
    if (width !== 0) steps++;
  }
  const key = (applicationCursor ? "\x1bO" : "\x1b[") + (to < from ? "D" : "C");
  return key.repeat(steps);
}
