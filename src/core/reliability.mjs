// Evidence projection only: no model calls, confidence scores, or prose grading.
const date = (value) =>
  Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const terminal = (run) =>
  !["starting", "running", "waiting"].includes(run.status);
export const ISSUE_CATEGORIES = [
  "Incorrect factual claim",
  "Missed requirement",
  "Conversation misrepresentation",
  "Unsupported completion claim",
  "Other",
];

export function sessionTiming(chat, runs, now = Date.now()) {
  const start = date(chat.created_at) ?? now;
  let incomplete = !runs.length || !!chat.timingIncomplete;
  const intervals = runs
    .flatMap((run) => {
      const from = date(run.created_at);
      let to = terminal(run) ? date(run.ended_at) : now;
      if (run.status === "interrupted") {
        to = date(run.last_progress_at) ?? from;
        incomplete = true;
      }
      if (from === null || to === null || to < from) {
        incomplete = true;
        return [];
      }
      return [[Math.max(start, from), Math.min(now, to)]];
    })
    .sort((a, b) => a[0] - b[0]);
  let activeMs = 0,
    end = start;
  for (const [from, to] of intervals) {
    activeMs += Math.max(0, to - Math.max(from, end));
    end = Math.max(end, to);
  }
  const totalMs = Math.max(0, now - start);
  return {
    activeMs,
    idleMs: incomplete ? null : Math.max(0, totalMs - activeMs),
    totalMs,
    incomplete,
  };
}

export function commandEvidence(events) {
  const commands = new Map();
  for (const event of events) {
    const p = event.payload;
    let id, patch;
    if (p.kind === "host-command") {
      id = "host:" + p.id;
      patch = {
        ...p,
        outcome: p.cancelled
          ? "cancelled"
          : p.timedOut
            ? "timeout"
            : Number.isInteger(p.exitCode)
              ? p.exitCode === 0
                ? "passed"
                : "failed"
              : p.status === "running"
                ? "running"
                : "unknown",
        basis: "Harness execution",
      };
    } else if (
      p.kind === "land-result" &&
      p.result?.landed &&
      p.result.checked
    ) {
      id = "land:" + p.result.commit;
      patch = {
        command: p.result.checked,
        cwd: p.root,
        commit: p.result.commit,
        trackedCheck: true,
        outcome: "passed",
        basis: "Landing check on recorded commit",
      };
    } else if (p.provider === "codex" && p.item?.type === "commandExecution") {
      id = "codex:" + p.item.id;
      const item = p.item;
      patch = {
        command: item.command,
        cwd: item.cwd,
        outcome:
          p.method !== "item/completed"
            ? "running"
            : Number.isInteger(item.exitCode)
              ? item.exitCode === 0
                ? "passed"
                : "failed"
              : "unknown",
        exitCode: item.exitCode,
        basis: "Provider report",
      };
    } else if (
      p.provider === "claude" &&
      p.item?.type === "tool_use" &&
      ["Bash", "PowerShell"].includes(p.item.name)
    ) {
      id = "claude:" + p.item.id;
      patch = {
        command: p.item.input?.command,
        outcome: "running",
        basis: "Provider report",
      };
    } else if (
      p.provider === "claude" &&
      p.kind === "tool-result" &&
      p.toolUseId
    ) {
      id = "claude:" + p.toolUseId;
      if (!commands.has(id)) continue;
      const exitCode = p.item?.exitCode ?? p.item?.exit_code;
      patch = {
        exitCode,
        outcome: p.isError
          ? "failed"
          : Number.isInteger(exitCode)
            ? exitCode === 0
              ? "passed"
              : "failed"
            : "unknown",
      };
    } else if (
      p.provider === "cursor" &&
      p.item?.toolCallId &&
      (p.item.kind === "execute" || commands.has("cursor:" + p.item.toolCallId))
    ) {
      id = "cursor:" + p.item.toolCallId;
      const exitCode = p.item.rawOutput?.exitCode;
      patch = {
        command: p.item.rawInput?.command,
        outcome:
          p.item.status === "in_progress"
            ? "running"
            : Number.isInteger(exitCode)
              ? exitCode === 0
                ? "passed"
                : "failed"
              : "unknown",
        exitCode,
        basis: "Provider report",
      };
    }
    if (!id) continue;
    const previous = commands.get(id) ?? {};
    commands.set(id, {
      ...previous,
      ...Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      ),
      id,
      runId: event.runId,
      eventId: event.id,
      observedAt: event.createdAt,
    });
  }
  return [...commands.values()].filter(
    (c) => c.command && c.outcome !== "running",
  );
}

export function checkFreshness(check, workspace) {
  if (check.commit) return "Checked commit " + check.commit.slice(0, 7);
  const before = check.workspaceBefore,
    after = check.workspaceAfter;
  if (!before?.hash || !after?.hash) return "Freshness unavailable";
  if (before.root !== after.root || before.hash !== after.hash)
    return "Changed during check";
  if (!workspace?.hash || workspace.root !== after.root)
    return "Freshness unavailable";
  return workspace.hash === after.hash
    ? "Workspace matches"
    : "Workspace changed";
}

export function reliabilityProjection({
  chat,
  runs = [],
  events = [],
  actions = [],
  workspace = null,
  provider = chat.provider,
  model = chat.model,
  now = Date.now(),
}) {
  const saved = chat.sessions?.[provider];
  const sessionId = typeof saved === "string" ? saved : saved?.id;
  const runById = new Map(runs.map((r) => [r.id, r]));
  const samples = new Map();
  const transitions = new Map();
  for (const event of events) {
    if (event.type === "reliability-transition") {
      const t = event.payload;
      if (
        (!t.provider || t.provider === provider) &&
        (!t.sessionId || t.sessionId === sessionId)
      ) {
        const earlier = transitions.get(t.key);
        // A later summary keeps the boundary's own time and evidence.
        transitions.set(t.key, earlier && t.summary
          ? { ...earlier, summary: t.summary }
          : { ...t, eventId: event.id, observedAt: event.createdAt });
      }
    }
    if (event.type !== "context-usage") continue;
    const p = event.payload;
    if (
      p.provider !== provider ||
      p.model !== model ||
      p.sessionId !== sessionId ||
      !event.runId
    )
      continue;
    const run = runById.get(event.runId);
    if (run?.status !== "completed" || p.state !== "ready") continue;
    samples.set(event.runId, {
      ...p,
      runId: event.runId,
      eventId: event.id,
      observedAt: p.observedAt ?? event.createdAt,
    });
  }
  const history = [...samples.values()].slice(-30);
  const last = history.at(-1);
  const recent = [];
  for (const p of history.slice(-5).reverse()) {
    if (
      p.generation !== last?.generation ||
      p.basis !== last?.basis ||
      p.source !== last?.source ||
      p.windowTokens !== last?.windowTokens ||
      !Number.isSafeInteger(p.usedTokens)
    )
      break;
    recent.unshift(p);
  }
  const growth =
    recent.length > 1 && recent.at(-1) === last
      ? last.usedTokens - recent[0].usedTokens
      : null;
  const dismissed = new Set(
    actions
      .filter((a) => ["dismiss", "acknowledge"].includes(a.kind))
      .map((a) => a.targetId),
  );
  const tracked = new Set(
    actions.filter((a) => a.kind === "track").map((a) => a.targetId),
  );
  const commandMap = new Map(
    actions
      .filter((a) => a.kind === "track" && a.evidence)
      .map((a) => [a.evidence.id, a.evidence]),
  );
  for (const c of commandEvidence(events)) commandMap.set(c.id, c);
  const commands = [...commandMap.values()].sort(
    (a, b) => a.eventId - b.eventId,
  );
  const checks = commands
    .filter((c) => c.trackedCheck || tracked.has(c.id))
    .map((c) => ({ ...c, freshness: checkFreshness(c, workspace) }));
  const latestChecks = new Map();
  for (const check of checks)
    latestChecks.set(JSON.stringify([check.command, check.cwd]), check);
  const notices = [];
  for (const t of transitions.values())
    notices.push({
      id: t.key,
      type: t.kind,
      title:
        t.kind === "compaction"
          ? "Context compacted. Review important requirements before continuing."
          : t.kind === "interruption"
            ? "The session was interrupted. Review partial work before continuing."
            : "The model session changed. Review continuity before continuing.",
      ...(t.summary && { summary: t.summary }),
      eventId: t.eventId,
      observedAt: t.observedAt,
      acknowledged: actions.some(
        (a) => a.kind === "acknowledge" && a.targetId === t.key,
      ),
    });
  for (const c of latestChecks.values()) {
    if (
      c.outcome === "failed" ||
      c.outcome === "timeout" ||
      c.outcome === "cancelled"
    )
      notices.push({
        id: "check:" + c.id,
        type: "check-failed",
        title: `Recorded check ${c.outcome}: ${c.command}`,
        eventId: c.eventId,
        observedAt: c.observedAt,
      });
    else if (
      c.outcome === "passed" &&
      ["Workspace changed", "Changed during check"].includes(c.freshness)
    )
      notices.push({
        id: "check:" + c.id,
        type: "stale-check",
        title: `${c.freshness} since verification: ${c.command}`,
        eventId: c.eventId,
        observedAt: c.observedAt,
      });
  }
  const resolved = new Set(
    actions.filter((a) => a.kind === "resolve").map((a) => a.targetId),
  );
  const issues = actions
    .filter((a) => a.kind === "report")
    .map((a) => ({
      ...a,
      resolved: resolved.has(a.actionId),
      dismissed: dismissed.has("issue:" + a.actionId),
    }));
  for (const issue of issues.filter((i) => !i.resolved))
    notices.push({
      id: "issue:" + issue.actionId,
      type: "user-report",
      title: `Reported by you: ${issue.category}`,
      note: issue.note,
      eventId: issue.eventId,
      messageId: issue.messageId,
      observedAt: issue.createdAt,
    });
  const activeNotices = notices.filter((n) => !dismissed.has(n.id));
  const compactions = [...transitions.values()].filter(
    (t) => t.kind === "compaction",
  );
  const latestTransition = [...transitions.values()].at(-1);
  const turnsSinceTransition = latestTransition
    ? runs.filter(
        (r) =>
          r.provider === provider &&
          r.model === model &&
          r.status === "completed" &&
          date(r.created_at) > date(latestTransition.observedAt),
      ).length
    : null;
  return {
    provider,
    model,
    sessionId,
    history,
    growth,
    timing: sessionTiming(chat, runs, now),
    compactions: compactions.length,
    latestTransition,
    turnsSinceTransition,
    notices: activeNotices,
    noticeHistory: notices.filter((n) => dismissed.has(n.id)),
    checks: checks.slice(-30).reverse(),
    commands: commands.slice(-40).reverse(),
    issues,
    status: activeNotices.some((n) => n.type === "check-failed")
      ? "Check failed"
      : activeNotices.length
        ? "Review recommended"
        : "Not assessed",
    checksCurrent:
      latestChecks.size > 0 &&
      [...latestChecks.values()].every(
        (c) => c.outcome === "passed" && c.freshness === "Workspace matches",
      ),
    workspace,
    assessedAt: new Date(now).toISOString(),
    coverage:
      "Task requirements and source correctness have not been assessed. Workspace comparisons exclude ignored configuration, dependencies and external services.",
  };
}
