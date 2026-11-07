// Goal phases describe the whole objective, rather than the tools in one turn.
// Both providers already have native planning tools, including in older sessions.
const statuses = {
  pending: "pending",
  inProgress: "in_progress",
  in_progress: "in_progress",
  completed: "completed",
};

function phases(items, label) {
  if (!Array.isArray(items) || !items.length || items.length > 50) return null;
  const result = items.map((item) => ({
    label: typeof item?.[label] === "string" ? item[label].trim() : "",
    status: Object.hasOwn(statuses, item?.status) ? statuses[item.status] : null,
  }));
  return result.every((item) => item.label && item.label.length <= 500 && item.status)
    ? result
    : null;
}

export const goalProgressTool = {
  name: "update_goal_progress",
  description: "Record phases for the current Goal, preserving completed work. Call after discovery and at meaningful milestones. This reports progress; it does not complete or replace the Goal.",
  inputSchema: {
    type: "object",
    properties: {
      phases: { type: "array", minItems: 1, maxItems: 50, items: {
        type: "object", properties: {
          label: { type: "string", minLength: 1, maxLength: 500 },
          status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        }, required: ["label", "status"], additionalProperties: false,
      } },
      explanation: { type: "string", maxLength: 4000 },
    },
    required: ["phases"], additionalProperties: false,
  },
};

export const completeGoalTool = {
  name: "complete_goal",
  description: "Claude Code only: finish the current Harness Goal once the full objective and every acceptance condition are met. First record phases covering the entire objective and verify all phases are completed. Supply the saved goalId and concrete verification evidence. Never use for a finished question or subtask, an owner dependency, a wait, or exhausted usage. Codex must use its native update_goal instead.",
  inputSchema: { type: "object", properties: {
    goalId: { type: "string", minLength: 1 },
    evidence: { type: "string", minLength: 1, maxLength: 4000 },
  }, required: ["goalId", "evidence"], additionalProperties: false },
};

export function checkGoalProgress(input) {
  const plan = phases(input?.phases, "label");
  if (!plan || (input.explanation !== undefined &&
      (typeof input.explanation !== "string" || input.explanation.length > 4000)))
    throw new Error("Supply 1–50 Goal phases with a label and pending, in_progress, or completed status.");
  return { phases: plan, explanation: input.explanation?.trim() ?? "" };
}

export function goalPlanTracker(provider) {
  const todos = new Map();
  let sequence = 0, accepted = 0;
  return (work) => {
    if (!work || work.parentId || work.agentId || work.kind === "native-subagent") return null;
    if (provider === "codex" && work.kind === "plan") {
      const plan = phases(work.plan, "step");
      return plan ? {
        phases: plan,
        explanation: typeof work.explanation === "string" ? work.explanation.trim().slice(0, 4000) : "",
      } : null;
    }
    if (provider !== "claude" || work.provider !== "claude") return null;
    if (work.kind === "tool" && work.item?.name === "TodoWrite") {
      const plan = phases(work.item.input?.todos, "content");
      if (plan && work.item.id) todos.set(work.item.id, { plan, sequence: ++sequence });
    }
    if (work.kind === "tool-result" && todos.has(work.toolUseId)) {
      const update = todos.get(work.toolUseId);
      todos.delete(work.toolUseId);
      if (!work.isError && update.sequence > accepted) {
        accepted = update.sequence;
        return { phases: update.plan, explanation: "" };
      }
    }
    return null;
  };
}

export const GOAL_PROGRESS_INSTRUCTIONS = `Record Goal progress with Codex update_plan or Harness update_goal_progress. Claude Code must use update_goal_progress: TodoWrite can be disabled. After initial discovery, record a short list of phases covering the entire Goal, including verification and delivery when needed, before starting implementation or a long wait. This is progress reporting within Goal mode; do not enter Plan mode. Keep the whole checklist across native turns, mark the current phase in progress, and update it at meaningful milestones. Preserve completed work. If new work changes the remaining phases, revise the checklist and briefly explain the change in your progress commentary (and the plan explanation when available). On resume or handoff, continue from the saved Goal phases below. Do not invent percentages or time estimates from phase counts.`;

export function goalProgressContext(progress) {
  if (!progress) return "";
  if (!progress.phases.length)
    return `Current Goal progress (${progress.goalId}): no phases recorded yet. Create a fresh checklist after initial discovery.`;
  return [
    `Current Goal progress (${progress.goalId}).`,
    "Saved Goal phases (continue this checklist; do not repeat completed work):",
    ...progress.phases.map((phase) => `- [${phase.status}] ${phase.label}`),
    progress.explanation,
  ].filter(Boolean).join("\n");
}
