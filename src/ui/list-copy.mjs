// Edge and Chrome leave list markers out of text/plain. Numbers and bullets
// are ::marker boxes, so a paste into the composer or any other plain-text
// field keeps the words and drops the list. When a selection hits a visible
// list, write the markers into text/plain and keep the real list in text/html.
// Lists drawn without markers, and selections that never touch a list, stay
// on the browser's own copy path.

const BLOCK = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TD",
  "TH",
  "TR",
  "UL",
]);
const PARAGRAPH = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "PRE",
]);

function elementOf(node) {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

function ignoredHost(range) {
  return !!elementOf(range.commonAncestorContainer)?.closest(
    "input, textarea, select, .xterm",
  );
}

function intersects(range, node) {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function visibleList(list) {
  const item = [...list.children].find((child) => child.tagName === "LI");
  if (!item) return false;
  const style = getComputedStyle(item);
  return style.display === "list-item" && style.listStyleType !== "none";
}

function visibleItem(item) {
  const list = item.parentElement;
  return (
    !!list &&
    (list.tagName === "OL" || list.tagName === "UL") &&
    visibleList(list)
  );
}

function selectionHasVisibleList(range) {
  const origin = elementOf(range.commonAncestorContainer);
  if (!origin) return false;
  const scope = origin.closest("ol, ul") ?? origin;
  const lists = [
    ...(scope.matches?.("ol, ul") ? [scope] : []),
    ...scope.querySelectorAll("ol, ul"),
  ];
  return lists.some((list) => visibleList(list) && intersects(range, list));
}

function integer(value, fallback) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function itemIndexes(list) {
  const items = [...list.children].filter((child) => child.tagName === "LI");
  const reversed = list.hasAttribute("reversed");
  let index = reversed
    ? integer(list.getAttribute("start"), items.length)
    : integer(list.getAttribute("start"), 1);
  const step = reversed ? -1 : 1;
  const numbers = new Map();
  for (const item of items) {
    if (item.hasAttribute("value"))
      index = integer(item.getAttribute("value"), index);
    numbers.set(item, index);
    index += step;
  }
  return numbers;
}

function leadingCheckbox(node) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (!child.data.trim()) continue;
      return null;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (child.tagName === "INPUT" && child.type === "checkbox") return child;
    if (child.tagName === "OL" || child.tagName === "UL") return null;
    const nested = leadingCheckbox(child);
    if (nested) return nested;
    return null;
  }
  return null;
}

function markerFor(item, ordered, index) {
  const box = leadingCheckbox(item);
  if (box) return box.checked || box.hasAttribute("checked") ? "- [x] " : "- [ ] ";
  return ordered ? `${index}. ` : "- ";
}

// The start of an item is its own first letter, not the text of a nested list
// and not the checkbox that stands in for the bullet.
function firstContentPoint(node) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const offset = child.data.search(/\S/);
      if (offset >= 0) return { node: child, offset };
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (child.tagName === "OL" || child.tagName === "UL") continue;
    if (child.tagName === "INPUT" && child.type === "checkbox") continue;
    const nested = firstContentPoint(child);
    if (nested) return nested;
  }
  return null;
}

function includesStart(range, item) {
  if (!intersects(range, item)) return false;
  const point = firstContentPoint(item);
  if (!point) {
    try {
      return range.comparePoint(item, 0) === 0;
    } catch {
      return false;
    }
  }
  const probe = document.createRange();
  probe.setStart(point.node, point.offset);
  probe.collapse(true);
  return range.compareBoundaryPoints(Range.START_TO_START, probe) <= 0;
}

function listDepth(node) {
  let el = elementOf(node);
  if (!el) return 0;
  if (el.tagName === "LI") el = el.parentElement;
  if (el && (el.tagName === "OL" || el.tagName === "UL")) el = el.parentElement;
  let depth = 0;
  while (el) {
    if ((el.tagName === "OL" || el.tagName === "UL") && visibleList(el))
      depth += 1;
    el = el.parentElement;
  }
  return depth;
}

function inPre(node) {
  return !!node.parentElement?.closest("pre");
}

function textOf(node, range) {
  if (!intersects(range, node)) return "";
  if (!inPre(node) && !node.data.trim() && /[\r\n]/.test(node.data)) return "";
  let start = 0;
  let end = node.data.length;
  if (node === range.startContainer) start = Math.min(range.startOffset, end);
  if (node === range.endContainer) end = Math.min(range.endOffset, end);
  return end < start ? "" : node.data.slice(start, end);
}

function finishBlock(tag, text) {
  const trimmed = text.replace(/\n+$/, "");
  if (!trimmed.trim()) return "";
  return trimmed + (PARAGRAPH.has(tag) ? "\n\n" : "\n");
}

function serializeChildren(node, range, depth) {
  let out = "";
  for (const child of node.childNodes) {
    const next = serializeNode(child, range, depth);
    if (
      next &&
      out &&
      !out.endsWith("\n") &&
      child.nodeType === Node.ELEMENT_NODE &&
      BLOCK.has(child.tagName)
    )
      out += "\n";
    out += next;
  }
  return out;
}

function serializeNode(node, range, depth) {
  if (node.nodeType === Node.TEXT_NODE) return textOf(node, range);
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  if (node !== range.commonAncestorContainer && !intersects(range, node))
    return "";
  const tag = node.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return "";
  if (tag === "BR" || tag === "HR") return "\n";
  if (tag === "IMG") return node.getAttribute("alt") ?? "";
  if ((tag === "OL" || tag === "UL") && visibleList(node))
    return serializeList(node, range, depth);
  const inner = serializeChildren(node, range, depth);
  return BLOCK.has(tag) ? finishBlock(tag, inner) : inner;
}

function prefixMarker(body, marker, depth) {
  const indent = "  ".repeat(depth);
  const blankAfter = /\n\s*\n\s*$/.test(body);
  let text = body.replace(/^\n+/, "").replace(/\n+$/, "");
  if (marker?.startsWith("- [")) text = text.replace(/^ /, "");
  if (!text) return marker ? indent + marker.trimEnd() : "";
  const lines = text.split("\n");
  const first = marker ? indent + marker + lines[0] : indent + lines[0];
  const rest = lines.slice(1).map((line) => (line ? indent + line : ""));
  const rendered = [first, ...rest].join("\n");
  return blankAfter ? rendered + "\n" : rendered;
}

function serializeList(list, range, depth) {
  const ordered = list.tagName === "OL";
  const numbers = itemIndexes(list);
  const parts = [];
  for (const item of numbers.keys()) {
    if (!intersects(range, item)) continue;
    const marker = includesStart(range, item)
      ? markerFor(item, ordered, numbers.get(item))
      : null;
    const rendered = prefixMarker(
      serializeChildren(item, range, depth + 1),
      marker,
      depth,
    );
    if (rendered) parts.push(rendered);
  }
  return parts.length ? parts.join("\n") + "\n\n" : "";
}

function walked(list, root) {
  if (!list || !root) return false;
  if (root === list) return true;
  return root.nodeType === Node.ELEMENT_NODE && root.contains(list);
}

// A selection that stays inside one item never walks its list element, so the
// marker has to be added on the way back out.
function wrapAncestorMarkers(root, range, text) {
  const items = [];
  let el = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
  while (el) {
    if (el.tagName === "LI" && visibleItem(el)) items.push(el);
    el = el.parentElement;
  }
  let body = text;
  for (const item of items) {
    const list = item.parentElement;
    if (!includesStart(range, item) || walked(list, root)) continue;
    body = prefixMarker(
      body,
      markerFor(item, list.tagName === "OL", itemIndexes(list).get(item)),
      listDepth(item),
    );
  }
  return body;
}

export function plainTextFromRange(range) {
  const root = range.commonAncestorContainer;
  const text = wrapAncestorMarkers(
    root,
    range,
    serializeNode(root, range, listDepth(root)),
  );
  return text
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .replace(/\n{3,}/g, "\n\n");
}

function htmlFromRange(range) {
  const holder = document.createElement("div");
  holder.append(range.cloneContents());
  return holder.innerHTML;
}

export function installListCopy(doc = document) {
  const onCopy = (event) => {
    if (event.defaultPrevented || !event.clipboardData) return;
    const selection = doc.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0)
      return;
    const range = selection.getRangeAt(0);
    if (ignoredHost(range) || !selectionHasVisibleList(range)) return;
    let plain = "";
    let html = "";
    try {
      plain = plainTextFromRange(range);
      html = htmlFromRange(range);
    } catch {
      return;
    }
    if (!plain) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", plain);
    event.clipboardData.setData("text/html", html);
  };
  doc.addEventListener("copy", onCopy);
  return () => doc.removeEventListener("copy", onCopy);
}
