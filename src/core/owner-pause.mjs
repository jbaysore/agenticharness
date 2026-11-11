export const ownerPauseTool = {
  name: "pause_for_owner",
  description:
    "Pause this Goal until the owner finishes something only they can do, such as merging a pull request or running a command on a machine you cannot reach. Keep the statement short: the first line is the action itself, then only what they need to do it. Set expects to done, or omit it, when confirmation that the action is finished is enough. Set expects to text and prompt to a short field label when you need a specific output, such as a code, URL, or pasted result. A text pause collects that value and does not offer I've done this. The turn ends without further model calls. When they confirm, send the value, or deny or choose Other with a reason, the Goal resumes automatically with that answer. This request's pending watchers with resumeOn complete stay armed, so whichever answers first resumes the Goal; call this instead of yield_to_watch when you need both. Never ask the owner for an action in plain text. Use only in Goal mode, and only when you cannot proceed without them. Do not use this for a choice you can make, a timed question, or to wait only on CI or a background process.",
  inputSchema: {
    type: "object",
    properties: {
      statement: {
        type: "string",
        minLength: 1,
        maxLength: 600,
        description:
          "Line 1: the action, one imperative sentence under 100 characters, such as \"Merge PR #42 in agentic-harness.\" Optionally a blank line, then at most three short lines with only what they need to do it: a link, the exact command and where to run it, or what you will do once it is done. Do not recap progress, reasoning or what you tried, and do not restate the Goal.",
      },
      expects: {
        type: "string",
        enum: ["done", "text"],
        description:
          "done confirms the action is finished. text collects the value named by prompt. Omit for done.",
      },
      prompt: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        description:
          "Required when expects is text. Short label for the field, such as \"Device code\".",
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
  if (!statement || statement.length > 600)
    throw new Error(
      "Describe the owner action in 1–600 characters: one action line, then only the details they need.",
    );
  const expects = input?.expects ?? "done";
  if (expects !== "done" && expects !== "text")
    throw new Error("Set expects to done or text.");
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  if (input?.prompt !== undefined && typeof input.prompt !== "string")
    throw new Error("Name the value you need in 1–120 characters.");
  if (expects === "text") {
    if (!prompt || prompt.length > 120)
      throw new Error("Name the value you need in 1–120 characters.");
    return { statement, expects, prompt };
  }
  if (prompt)
    throw new Error("A done confirmation does not take a prompt.");
  return { statement, expects: "done" };
}

export function checkOwnerAnswer(choice, reason, expects = "done") {
  const text = typeof reason === "string" ? reason.trim() : "";
  const kind = expects === "text" ? "text" : "done";
  if (kind === "text" && choice === "done")
    throw new Error("Enter the requested value.");
  if (kind === "done" && choice === "text")
    throw new Error("Choose done, deny, or other.");
  if (!["done", "deny", "other", "text"].includes(choice))
    throw new Error(
      kind === "text"
        ? "Send the value, or choose deny or other."
        : "Choose done, deny, or other.",
    );
  if (choice === "text" && !text) throw new Error("Enter the requested value.");
  if ((choice === "deny" || choice === "other") && !text)
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
        : answer.choice === "text"
          ? `The owner provided:\n${answer.reason}`
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
