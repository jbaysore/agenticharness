export const ownerPauseTool = {
  name: "pause_for_owner",
  description:
    "Pause this Goal until the owner finishes something only they can do, such as merging a pull request or running a command on a machine you cannot reach. State what they need to do. The turn ends without further model calls. When they confirm it is done, or deny or choose Other with a reason, the Goal resumes automatically with that answer. Use only in Goal mode, and only when you cannot proceed without them. Do not use this for a choice you can make, a timed question, CI, or background process completion.",
  inputSchema: {
    type: "object",
    properties: {
      statement: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description:
          "What the owner needs to do before the Goal can continue.",
      },
    },
    required: ["statement"],
    additionalProperties: false,
  },
};

export const OWNER_PAUSE_STOP =
  "Stop task work. Harness is closing this turn and will pause the Goal until the owner answers. Do not keep working.";

export function checkOwnerPause(input) {
  const statement =
    typeof input?.statement === "string" ? input.statement.trim() : "";
  if (!statement || statement.length > 2000)
    throw new Error("Describe the owner action in 1–2,000 characters.");
  return { statement };
}

export function checkOwnerAnswer(choice, reason) {
  if (!["done", "deny", "other"].includes(choice))
    throw new Error("Choose done, deny, or other.");
  const text = typeof reason === "string" ? reason.trim() : "";
  if (choice !== "done" && !text)
    throw new Error("Deny and Other need a reason.");
  if (text.length > 4000)
    throw new Error("Keep the reason under 4,000 characters.");
  return { choice, reason: text };
}

export function ownerAnswerDisplay(answer) {
  if (answer.choice === "done")
    return "Done. The owner confirmed this is complete.";
  if (answer.choice === "deny") return `Denied: ${answer.reason}`;
  return answer.reason;
}

export function ownerAnswerPrompt(statement, answer) {
  const line =
    answer.choice === "done"
      ? "Done. The owner confirmed this is complete."
      : answer.choice === "deny"
        ? `Denied.\n${answer.reason}`
        : answer.choice === "other"
          ? `Other.\n${answer.reason}`
          : `The owner wrote:\n${answer.reason}`;
  return [
    "The owner answered the pause that was blocking this Goal. Continue the objective from saved progress and do not repeat completed work.",
    "You asked the owner to:",
    statement,
    "Answer:",
    line,
  ].join("\n\n");
}
