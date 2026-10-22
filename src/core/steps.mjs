// Turns each provider's raw work events into the steps a reader cares about:
// files read and edited, commands run, searches, browsing and subagents.
// Pure, so the host builds steps for saved turns and the browser extends them live.

const basename = (path = "") => String(path).split(/[\\/]/).filter(Boolean).at(-1) ?? "";
const short = (text = "", length = 60) => {
  const line = String(text).trim().split("\n")[0];
  return line.length > length ? line.slice(0, length - 1) + "…" : line;
};

// Counts added and removed lines in a unified diff, or between two texts.
function diffCounts(diff) {
  let added = 0,
    removed = 0;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}
function textCounts(before = "", after = "") {
  const old = String(before ?? "").split("\n"),
    next = String(after ?? "").split("\n"),
    pool = new Map();
  for (const line of old) pool.set(line, (pool.get(line) ?? 0) + 1);
  let kept = 0;
  for (const line of next)
    if (pool.get(line)) {
      pool.set(line, pool.get(line) - 1);
      kept++;
    }
  return {
    added: before ? next.length - kept : next.length,
    removed: before ? old.length - kept : 0,
  };
}

// Harness's own history tools look the same whichever agent calls them.
function historyTool(name = "", args = {}) {
  if (/history_search/.test(name))
    return { verb: "search", target: "history: " + short(args.query ?? "", 40) };
  if (/history_read/.test(name)) return { verb: "read", target: "an earlier chat" };
  return null;
}

const finished = (status) =>
  ({
    completed: "ok",
    success: "ok",
    failed: "failed",
    declined: "failed",
    error: "failed",
    rejected: "failed",
    cancelled: "failed",
  })[status] ?? null;

function codexStep(p) {
  const item = p.item ?? {},
    status =
      p.method === "item/completed"
        ? (finished(item.status) ??
          (item.success === false ? "failed" : "ok"))
        : "running";
  const base = { id: "codex:" + item.id, status, ms: item.durationMs ?? null };
  if (item.type === "commandExecution") {
    const action = item.commandActions?.[0] ?? {};
    const failed = status === "ok" && item.exitCode ? "failed" : status;
    if (action.type === "read")
      return { ...base, verb: "read", target: action.name || basename(action.path), status: failed };
    if (action.type === "listFiles" || action.type === "search")
      return { ...base, verb: "search", target: short(action.query || action.command), status: failed };
    return { ...base, verb: "run", target: short(action.command || item.command), status: failed };
  }
  if (item.type === "fileChange") {
    const changes = item.changes ?? [],
      counts = changes.map((c) => diffCounts(c.diff));
    return {
      ...base,
      verb: "edit",
      target: changes.length === 1 ? basename(changes[0].path) : `${changes.length} files`,
      files: changes.map((c) => basename(c.path)),
      added: counts.reduce((sum, c) => sum + c.added, 0),
      removed: counts.reduce((sum, c) => sum + c.removed, 0),
    };
  }
  if (item.type === "webSearch")
    return { ...base, verb: "search", target: short(item.query) };
  if (item.type === "mcpToolCall") {
    const browser = /playwright|browser/i.test(item.server);
    return {
      ...base,
      verb: browser ? "browse" : "other",
      target: short(item.arguments?.title ?? `${item.server} ${item.tool}`),
    };
  }
  if (item.type === "dynamicToolCall")
    return { ...base, ...(historyTool(item.tool, item.arguments) ?? { verb: "other", target: item.tool }) };
  if (item.type === "subAgentActivity")
    return {
      id: "codex-agent:" + item.agentThreadId,
      verb: "subagent",
      target: basename(item.agentPath) || "subagent",
      status: item.kind === "completed" ? "ok" : "running",
    };
  if (item.type === "plan") return { ...base, verb: "plan", target: "plan" };
  return null;
}

function claudeTool(block) {
  const input = block.input ?? {},
    name = block.name ?? "",
    base = { id: "claude:" + block.id, status: "running" };
  if (name === "Read") return { ...base, verb: "read", target: basename(input.file_path) };
  if (name === "Write")
    return { ...base, verb: "edit", target: basename(input.file_path), ...textCounts("", input.content) };
  if (name === "Edit")
    return { ...base, verb: "edit", target: basename(input.file_path), ...textCounts(input.old_string, input.new_string) };
  if (name === "MultiEdit") {
    const counts = (input.edits ?? []).map((e) => textCounts(e.old_string, e.new_string));
    return {
      ...base,
      verb: "edit",
      target: basename(input.file_path),
      added: counts.reduce((sum, c) => sum + c.added, 0),
      removed: counts.reduce((sum, c) => sum + c.removed, 0),
    };
  }
  if (name === "Bash" || name === "PowerShell")
    return { ...base, verb: "run", target: short(input.command || input.description) };
  if (name === "Grep" || name === "Glob")
    return { ...base, verb: "search", target: short(input.pattern) };
  if (name === "WebSearch") return { ...base, verb: "search", target: short(input.query) };
  if (name === "WebFetch" || /playwright|browser/i.test(name))
    return { ...base, verb: "browse", target: short(input.url ?? name.split("__").at(-1)) };
  if (name === "Agent" || name === "Task")
    return { ...base, verb: "subagent", target: short(input.description || "subagent") };
  if (name === "TodoWrite") return { ...base, verb: "plan", target: "plan" };
  if (name === "ToolSearch") return null;
  return { ...base, ...(historyTool(name, input) ?? { verb: "other", target: name.split("__").at(-1) }) };
}

function cursorStep(p, existing) {
  const item = p.item ?? {},
    kind = item.kind ?? existing?.kind,
    title = String(item.title ?? "").replaceAll("`", ""),
    path = item.locations?.[0]?.path ?? item.rawInput?.path,
    verb =
      p.kind === "native-subagent"
        ? "subagent"
        : ({ read: "read", edit: "edit", delete: "edit", move: "edit", search: "search", execute: "run", fetch: "browse", think: "plan" })[kind] ??
          existing?.verb ??
          "other";
  const diff = (item.content ?? []).find((c) => c.type === "diff");
  const history = historyTool(title, item.rawInput);
  const step = {
    id: "cursor:" + item.toolCallId,
    kind,
    verb,
    status: finished(item.status) ?? existing?.status ?? "running",
  };
  if (history) return { ...step, ...history };
  const target =
    verb === "run"
      ? short(item.rawInput?.command ?? title)
      : path
        ? basename(path)
        : title.replace(/^(Read|Edit|Task:)\s*/, "") || undefined;
  if (target && !(existing?.target && target === "File")) step.target = target;
  if (diff) Object.assign(step, textCounts(diff.oldText, diff.newText));
  return step;
}

// Folds one work event into the list of steps, returning a new list. A new
// step remembers the reply it followed, so the chat can place it in the turn.
export function applyWork(steps, p, after = null) {
  if (!p || p.parentId) return steps;
  let step = null;
  const merge = (next) => {
    const index = steps.findIndex((s) => s.id === next.id);
    if (index < 0) return [...steps, { ...next, after }];
    const copy = steps.slice();
    copy[index] = {
      ...steps[index],
      ...Object.fromEntries(Object.entries(next).filter(([, v]) => v != null)),
    };
    return copy;
  };
  if (p.kind === "permission-review") {
    step = {
      id: "review:" + p.item.id,
      verb: "other",
      target: p.item.title,
      status:
        p.status === "running"
          ? "running"
          : ["deny", "cancelled"].includes(p.status) ? "failed" : "ok",
    };
  } else if (p.provider === "codex" && (p.kind === "tool" || p.kind === "native-subagent")) {
    if (p.item?.type === "collabAgentToolCall" || p.item?.type === "agentMessage") return steps;
    step = codexStep(p);
  } else if (p.provider === "claude") {
    if (p.kind === "tool" || (p.kind === "native-subagent" && p.item?.type === "tool_use"))
      step = claudeTool(p.item);
    else if (p.kind === "tool-result") {
      const failed =
        p.isError || (typeof p.item === "string" && /^Error\b/.test(p.item));
      const id = p.toolUseId
        ? "claude:" + p.toolUseId
        : steps.find((s) => s.id.startsWith("claude:") && s.status === "running")?.id;
      if (!id || !steps.some((s) => s.id === id)) return steps;
      step = { id, status: failed ? "failed" : "ok" };
    } else if (p.kind === "native-subagent" && p.item?.subtype === "task_notification") {
      const id = "claude:" + p.item.tool_use_id;
      if (!steps.some((s) => s.id === id)) return steps;
      step = { id, status: finished(p.item.status) ?? "ok" };
    }
  } else if (p.provider === "cursor" && p.item?.toolCallId) {
    step = cursorStep(p, steps.find((s) => s.id === "cursor:" + p.item.toolCallId));
  }
  return step ? merge(step) : steps;
}

// Takes work payloads, or saved events where a text event marks the reply
// that later steps follow.
export const buildSteps = (items) => {
  let after = null;
  return items.reduce((steps, item) => {
    if (item.type === "text") {
      after = item.payload?.messageId ?? after;
      return steps;
    }
    return applyWork(steps, item.type === "work" ? item.payload : item, after);
  }, []);
};

// Splits a turn into replies and the work between them: the steps before
// the first reply, then each reply followed by the steps that came after it.
export function interleave(messages, steps = []) {
  const ids = new Set(messages.map((m) => m.id)),
    after = (id) => steps.filter((s) => (ids.has(s.after) ? s.after : null) === id);
  return [
    { message: null, steps: after(null) },
    ...messages.map((m) => ({ message: m, steps: after(m.id) })),
  ];
}

// When a turn is over, a step that never reported back is treated as done.
export const settle = (steps) =>
  steps.map((s) => (s.status === "running" ? { ...s, status: "ok" } : s));

const order = ["read", "search", "edit", "run", "browse", "subagent", "plan", "other"];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// One short phrase per kind of work, in reading order.
export function summarize(steps) {
  const groups = order
    .map((verb) => [verb, steps.filter((s) => s.verb === verb)])
    .filter(([, list]) => list.length);
  return groups.map(([verb, list]) => {
    const failed = list.filter((s) => s.status === "failed").length,
      only = list.length === 1 ? list[0] : null;
    let text;
    if (verb === "read") {
      const files = new Set(list.map((s) => s.target));
      text = files.size === 1 ? `read ${only?.target ?? [...files][0]}` : `read ${plural(files.size, "file", "files")}`;
    } else if (verb === "edit") {
      const files = new Set(list.flatMap((s) => s.files ?? [s.target]));
      text = files.size === 1 ? `edited ${[...files][0]}` : `edited ${plural(files.size, "file", "files")}`;
    } else if (verb === "run")
      text = only ? `ran ${only.target}` : `ran ${plural(list.length, "command", "commands")}`;
    else if (verb === "search") text = only ? `searched ${only.target}` : `searched ${list.length}×`;
    else if (verb === "browse") text = "used the browser";
    else if (verb === "subagent") text = plural(list.length, "subagent", "subagents");
    else if (verb === "plan") text = "updated the plan";
    else
      text = only?.target
        ? only.target[0].toLowerCase() + only.target.slice(1)
        : plural(list.length, "other tool", "other tools");
    return {
      verb,
      text,
      added: list.reduce((sum, s) => sum + (s.added ?? 0), 0),
      removed: list.reduce((sum, s) => sum + (s.removed ?? 0), 0),
      failed,
      running: list.some((s) => s.status === "running"),
    };
  });
}

export const verbLabels = {
  read: "Read",
  edit: "Edit",
  run: "Run",
  search: "Search",
  browse: "Browse",
  subagent: "Subagent",
  plan: "Plan",
  other: "Tool",
};
const present = {
  read: "Reading",
  edit: "Editing",
  run: "Running",
  search: "Searching",
  browse: "Browsing",
  subagent: "Waiting on",
  plan: "Planning",
  other: "Using",
};
export const presentTense = (step) => `${present[step.verb] ?? "Working on"} ${step.target ?? ""}`.trim();
