// Everything Harness says in its own voice lives here, so the tone stays consistent.
export const OWNER = "Josh";

const names = { codex: "Codex", claude: "Claude Code", cursor: "Cursor", openrouter: "OpenRouter" };
export const providerName = (id) => names[id] ?? id ?? "Agent";

export function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 4) return `Still up, ${OWNER}?`;
  if (hour < 12) return `Morning, ${OWNER}.`;
  if (hour < 17) return `Afternoon, ${OWNER}.`;
  return `Evening, ${OWNER}.`;
}

export const workingLine = (provider, waiting) =>
  waiting
    ? `${providerName(provider)} needs you`
    : `${providerName(provider)} is on it`;

export function elapsed(since, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

// How long a finished turn took and when it ended, for the hover on its
// byline. The time drops the date while it is still today.
export function turnTiming(run, now = new Date()) {
  if (!run?.ended_at || !run.created_at) return null;
  const ended = new Date(run.ended_at),
    took = elapsed(run.created_at, ended.getTime()),
    verb =
      run.status === "completed"
        ? "Worked for"
        : run.status === "failed"
          ? "Failed after"
          : "Stopped after",
    time = ended.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    sameDay = ended.toDateString() === now.toDateString();
  return {
    label: `${verb} ${took} · ${sameDay ? time : `${ended.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`}`,
    title: ended.toLocaleString(),
  };
}
