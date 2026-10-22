import { isBrowserTool } from "./browser.mjs";

// How a turn runs. default works as usual. ask answers questions and cannot
// change the project. plan proposes work before changing anything. goal keeps
// working until the message's condition is met.
export const CHAT_MODES = ["default", "ask", "plan", "goal"];

export function checkMode(mode, provider) {
  if (!CHAT_MODES.includes(mode))
    throw new Error("Choose the default, ask, plan or goal mode");
  if (mode === "goal" && provider === "cursor")
    throw new Error("Cursor has no goal mode. Choose Codex or Claude Code.");
}

export const ASK_INSTRUCTIONS = `Ask mode: this turn is read-only. Answer questions and explain how the project works. You may read and search files, and you may use read-only history and browser tools. Creating, editing, or deleting files, running commands, landing commits, and changing a page are unavailable. The user changes the mode; stay in Ask mode.`;

export const ASK_DENY =
  "Ask mode is read-only. This action is unavailable. Use read and search tools to answer the question.";

// Host tools that cannot change the project. Browser tools are decided from
// the read-only flag on each tool, because their names change with Playwright.
const ASK_HOST_TOOLS = new Set([
  "history_search",
  "history_read",
  "project_notes",
  "workspace_activity",
  "rename_chat",
  "delegate_read",
  "delegate_locate",
]);

export function askHostAllowed(name) {
  return ASK_HOST_TOOLS.has(name);
}

export function hostToolsForMode(mode, tools) {
  if (mode !== "ask") return tools;
  return tools.filter((tool) => askHostAllowed(tool.name));
}

// Claude Code has no Ask mode. These built-in tools are the read-only set,
// and canUseTool denies anything else, including a tool added later.
export const CLAUDE_ASK_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "AskUserQuestion",
];

export function claudeAskAllowed(name, tools = []) {
  if (CLAUDE_ASK_TOOLS.includes(name)) return true;
  const mcp = /^mcp__harness__(.+)$/.exec(String(name));
  if (!mcp) return false;
  const host = mcp[1];
  return (
    askHostAllowed(host) ||
    (isBrowserTool(host) && tools.some((tool) => tool.name === host))
  );
}
