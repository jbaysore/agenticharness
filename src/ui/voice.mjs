// Everything Harness says in its own voice lives here, so the tone stays consistent.
export const OWNER = "Josh";

const names = { codex: "Codex", claude: "Claude Code", cursor: "Cursor" };
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
