import { isBrowserTool } from "./browser.mjs";

// How a turn runs. default works as usual. ask answers questions and cannot
// change the project. plan proposes work before changing anything. goal keeps
// working until the message's condition is met.
export const CHAT_MODES = ["default", "ask", "plan", "goal"];

export const modeSuggestionTool = {
  name: "suggest_mode",
  description:
    "Suggest a more appropriate chat mode for the current task. Explain why; for Goal, include a concrete objective. Always waits for the user's manual approval, including under Auto-review or Override. Approval resumes this task in the chosen mode; a decline keeps the current mode. Do not repeat a declined suggestion unless the user's needs change.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: CHAT_MODES },
      reason: { type: "string", minLength: 1, maxLength: 4000 },
      objective: {
        type: "string",
        minLength: 1,
        maxLength: 250000,
        description:
          "Required for Goal: the condition to work until it is met.",
      },
    },
    required: ["mode", "reason"],
    additionalProperties: false,
  },
};

export const MODE_SUGGESTION_INSTRUCTIONS = `You may call suggest_mode when another chat mode would better suit the current task: Default performs work normally; Ask answers read-only questions; Plan proposes work before implementation; Goal keeps working until a concrete condition is met. Explain the benefit and include the objective for Goal. Harness always asks the user to approve a mode suggestion manually, even under Auto-review or Override. Stay within the current mode until approved; after a decline, continue in the current mode and do not repeat the suggestion unless the user's needs change. Changing modes does not approve a proposed plan or expand the user's task scope.`;

// Goal stays on until the objective is met. The agent is not offered a way out.
export const GOAL_INSTRUCTIONS = `Goal mode: stay in Goal until the objective is met. Do not suggest another mode and do not enter plan mode. You may ask a question when only the user can decide. Harness shows it for 60 seconds. If nobody answers, choose the path that best completes the objective and continue, and do not ask that question again. A permission request that needs the user is declined so you can continue without it. When the objective is blocked on an action only the owner can perform, such as merging a pull request or running a command on a machine you cannot reach, call pause_for_owner with a clear statement of what they need to do, then stop. That pauses the Goal without further model calls. When they confirm it is done, or deny or choose Other with a reason, the Goal resumes with that answer. Do not use pause_for_owner for a choice you can make, a timed question, or CI.`;

// The message a resumed Goal's turn starts with when the user adds none.
export const GOAL_RESUME_TEXT =
  "Resume the paused goal. Pick up from this session's saved progress and do not repeat completed work.";

// The user message stored when a usage stop continues on another provider.
// The host still attaches the usual transcript handoff.
export function usageContinuationText({ from, mode, objective } = {}) {
  const who = from || "the previous provider";
  const base = `Included usage ran out on ${who}. Continue this task from the latest progress. Do not repeat completed work. Inspect the repository before assuming what already changed.`;
  if (mode === "goal" && objective)
    return `${base}\n\nThe goal is still:\n${objective}`;
  if (mode === "ask" || mode === "plan")
    return `${base}\n\nStay in ${mode} mode.`;
  return base;
}
// What the new provider's Goal is set to. The saved objective stays intact;
// the extra line is only the prompt that asks the new provider to pick up.
export function usageGoalPrompt({ from, objective, fallback } = {}) {
  const who = from || "the previous provider";
  const line = `Included usage ran out on ${who}. Continue this goal from the latest progress and do not repeat completed work.`;
  if (objective) return `${objective}\n\n${line}`;
  return fallback || line;
}

export const GOAL_QUESTION_TIMEOUT_MS = 60_000;
export const GOAL_QUESTION_LIMIT = 3;
export const GOAL_QUESTION_TIMEOUT =
  "The user did not answer in time. This is not a refusal of the goal. Choose the path that best completes the objective and continue.";

export function questionKey(request) {
  const text = (request?.questions ?? [])
    .map((q) => String(q.question ?? q.header ?? q.prompt ?? "").trim())
    .filter(Boolean)
    .join("\n");
  return text || String(request?.title ?? "").trim();
}

export function goalQuestionAnswers(questions = []) {
  return Object.fromEntries(
    questions.map((q, index) => [
      q.id ?? q.question ?? q.header ?? `question-${index + 1}`,
      GOAL_QUESTION_TIMEOUT,
    ]),
  );
}

export function checkMode(mode, provider) {
  if (!CHAT_MODES.includes(mode))
    throw new Error("Choose the default, ask, plan or goal mode");
  if (mode === "goal" && provider === "cursor")
    throw new Error("Cursor has no goal mode. Choose Codex or Claude Code.");
  if (mode === "goal" && provider === "openrouter")
    throw new Error("OpenRouter supports Default, Ask and Plan. Choose Codex or Claude Code for Goal mode.");
}

export const ASK_INSTRUCTIONS = `Ask mode: this turn is read-only. Answer questions and explain how the project works. You may read and search files, and you may use read-only history and browser tools. Creating, editing, or deleting files, running commands, landing commits, and changing a page are unavailable. You may suggest a mode change with suggest_mode; stay in Ask mode unless the user approves it.`;

export const ASK_DENY =
  "Ask mode is read-only. This action is unavailable. Use read and search tools to answer the question.";

// Host tools that cannot change the project. Browser tools are decided from
// the read-only flag on each tool, because their names change with Playwright.
const ASK_HOST_TOOLS = new Set([
  "history_search",
  "history_read",
  "memory_search",
  "memory_read",
  "workspace_activity",
  "rename_chat",
  "suggest_mode",
  "ask_user",
  "delegate_read",
  "delegate_locate",
  "watch_github_ci",
  "list_watches",
  "cancel_watch",
]);

export function askHostAllowed(name) {
  return ASK_HOST_TOOLS.has(name);
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
