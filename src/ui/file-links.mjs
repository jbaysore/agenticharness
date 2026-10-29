// Agents link a document once per message. This only rewrites those links;
// it does not search the message for paths.

function lineNumber(value) {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : null;
}

function normalizePath(path) {
  return String(path)
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

function isAbsolute(path) {
  return /^[A-Za-z]:\//.test(path) || path.startsWith("/");
}

function relativeTo(root, file) {
  const base = normalizePath(root);
  const target = normalizePath(file);
  if (!base || !target.toLowerCase().startsWith(base.toLowerCase() + "/"))
    return null;
  return target.slice(base.length + 1);
}

function parseFileTarget(target) {
  let value = String(target ?? "").trim();
  if (!value) return null;
  if (value.startsWith("harness://file/"))
    value = value.slice("harness://file/".length);
  const hash = value.match(/#L(\d+)(?:-\d+)?$/);
  const line = hash ? lineNumber(hash[1]) : null;
  if (hash) value = value.slice(0, hash.index);
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!value) return null;
  return { path: normalizePath(value), line };
}

function cleanRelative(path) {
  const file = path.replace(/^\.\/+/, "");
  if (
    !file ||
    isAbsolute(file) ||
    file.includes(":") ||
    file.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    return null;
  return file;
}

// A harness file URL, or a path, becomes the repository and relative file the
// Files panel can open. Null means the path is outside this chat's project.
export function resolveFileLink(target, options = {}) {
  const parsed = parseFileTarget(target);
  if (!parsed) return null;
  const line = lineNumber(options.line) ?? parsed.line;
  if (!isAbsolute(parsed.path)) {
    const file = cleanRelative(parsed.path);
    if (!file || (!options.worktree && !options.project)) return null;
    return { repo: "primary", file, line };
  }
  const roots = [];
  if (options.worktree) roots.push({ repo: "primary", path: options.worktree });
  if (options.project) roots.push({ repo: "primary", path: options.project });
  for (const [index, reference] of (options.references ?? []).entries()) {
    if (reference?.path) roots.push({ repo: String(index), path: reference.path });
  }
  let best = null;
  for (const root of roots) {
    const file = relativeTo(root.path, parsed.path);
    if (!file || file.split("/").includes("..")) continue;
    if (!best || normalizePath(root.path).length > normalizePath(best.path).length)
      best = { repo: root.repo, file };
  }
  return best ? { ...best, line } : null;
}

export function rewriteHarnessLinks(html) {
  return html
    .replace(
      /href="harness:\/\/conversation\/([^"#]+)(#[^"]*)?"/g,
      'href="/?chat=$1$2"',
    )
    .replace(/href="harness:\/\/file\/([^"]*)"/g, (full, raw) => {
      const parsed = parseFileTarget("harness://file/" + raw);
      if (!parsed) return full;
      const line = parsed.line ? "&line=" + parsed.line : "";
      return 'href="/?file=' + encodeURIComponent(parsed.path) + line + '"';
    });
}
