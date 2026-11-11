export const askUserTool = {
  name: "ask_user",
  description:
    "Ask the user one or more questions in Harness. Set each question's answer to choice, text, or done so the card matches the ask. choice: include short option labels and descriptions; set multiSelect when choices can be combined, and leave it false for mutually exclusive decisions. Harness supplies Other automatically. text: ask for a specific written output and omit options; placeholder names what to enter. done: the user performs an action and confirms with I've done this; omit options, and use it only when confirmation is enough. A text question shows a field for the output, not a done button. Waits for an explicit answer or cancellation.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            question: { type: "string", minLength: 1 },
            answer: { type: "string", enum: ["choice", "text", "done"] },
            placeholder: { type: "string", minLength: 1, maxLength: 120 },
            multiSelect: { type: "boolean" },
            options: {
              type: "array",
              minItems: 2,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", minLength: 1 },
                  description: { type: "string", minLength: 1 },
                },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
          },
          required: ["id", "question"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};

export const questionIdentity = (q) => q?.id ?? q?.question ?? q?.header;

// Options mean a decision. No options means a written answer. An explicit
// answer wins, including a done confirmation that carries no options.
export function questionKind(q) {
  if (q?.answer === "choice" || q?.answer === "text" || q?.answer === "done")
    return q.answer;
  return q?.options?.length ? "choice" : "text";
}

const multipleChoice = (q) => q.multiple || q.multiSelect;
const optionValue = (q, option) =>
  q.selectionOnly ? option.id : (option.label ?? option);

export function questionAnswer(q, response = {}) {
  const kind = questionKind(q);
  if (kind === "done") return response?.done ? "Done" : undefined;
  if (kind === "text") {
    const text = typeof response?.text === "string" ? response.text.trim() : "";
    return text || undefined;
  }
  if (response?.other && !response.text?.trim()) return undefined;
  const values = (response?.selected ?? []).map((i) =>
    optionValue(q, q.options[i]),
  );
  if (response?.other && response.text?.trim()) values.push(response.text.trim());
  if (!values.length) return undefined;
  return multipleChoice(q) ? values : values[0];
}

// One question per page once a turn asks more than one. Answers are the
// values already accepted for each question; an unanswered one is undefined.
// A done question is ready to submit from its confirmation button.
export function questionPage(questions, answers, page = 0) {
  const list = Array.isArray(questions) ? questions : [];
  const paged = list.length > 1;
  const index = paged
    ? Math.min(Math.max(0, page | 0), list.length - 1)
    : 0;
  const ready = (q) => answers?.[questionIdentity(q)] !== undefined;
  const last = !paged || index >= list.length - 1;
  const confirm = questionKind(list[index]) === "done";
  const othersReady = list.every((q, i) => i === index || ready(q));
  return {
    paged,
    index,
    label: paged ? `Question ${index + 1} of ${list.length}` : "",
    canBack: paged && index > 0,
    primary: last ? "send" : "next",
    confirm,
    primaryEnabled: confirm
      ? last
        ? othersReady
        : true
      : last
        ? list.every(ready)
        : ready(list[index]),
  };
}

export const QUESTION_INSTRUCTIONS =
  "For user questions, prefer Harness ask_user. Set answer to choice, text, or done so the card matches the ask. choice needs options: set multiSelect true when choices can be combined, and leave it false for mutually exclusive decisions. Harness supplies Other automatically. Multiple selections are returned as an array, including any Other response. text asks for a specific written output and shows a field for it; set placeholder to name what to enter. done asks the user to perform an action and confirm, and shows I've done this. Use done only when confirmation is enough. Use text when you need the value itself, and do not offer a done button for that. Omit answer to keep the default: options mean choice, and no options means text. Never preselect or submit an answer on the user's behalf. Native question tools remain available. A Goal question still times out after 60 seconds, and an unanswered timeout is not a confirmation; when the owner must leave to act, use pause_for_owner instead.";

export function checkQuestions(input) {
  const questions = input?.questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 3)
    throw new Error("Ask one to three questions");
  const ids = new Set();
  for (const q of questions) {
    if (!q || typeof q.id !== "string" || !q.id.trim() || ids.has(q.id))
      throw new Error("Give each question a unique, nonempty ID");
    ids.add(q.id);
    if (typeof q.question !== "string" || !q.question.trim())
      throw new Error("Include the question text");
    if (q.answer !== undefined && !["choice", "text", "done"].includes(q.answer))
      throw new Error("Set answer to choice, text, or done");
    if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean")
      throw new Error("multiSelect must be a boolean");
    const kind =
      q.answer ?? (q.options !== undefined ? "choice" : "text");
    const placeholder =
      typeof q.placeholder === "string" ? q.placeholder.trim() : "";
    if (
      q.placeholder !== undefined &&
      (typeof q.placeholder !== "string" ||
        !placeholder ||
        placeholder.length > 120)
    )
      throw new Error("Keep the placeholder to 1–120 characters");
    if (placeholder && kind !== "text")
      throw new Error("Only a text answer takes a placeholder");
    if (kind !== "choice" && q.multiSelect)
      throw new Error("multiSelect applies only to a choice");
    if (kind === "text" && q.options !== undefined)
      throw new Error("A text answer does not take options");
    if (kind === "done" && q.options !== undefined)
      throw new Error("A done confirmation does not take options");
    if (
      kind === "choice" &&
      (!Array.isArray(q.options) ||
        q.options.length < 2 ||
        q.options.some(
          (o) =>
            !o ||
            typeof o.label !== "string" ||
            !o.label.trim() ||
            typeof o.description !== "string" ||
            !o.description.trim(),
        ))
    )
      throw new Error(
        "Include at least two options with labels and descriptions",
      );
  }
  return questions;
}

// Provider formats belong at the boundary, never in the question form.
export function claudeQuestionAnswers(answers = {}) {
  return Object.fromEntries(
    Object.entries(answers).map(([id, value]) => [
      id,
      Array.isArray(value) ? value.join(", ") : value,
    ]),
  );
}

export function codexQuestionAnswers(questions, answer) {
  return Object.fromEntries(
    questions.map((q) => {
      const value = answer.allow ? answer.answers?.[q.id] : undefined;
      return [
        q.id,
        {
          answers:
            value === undefined
              ? ["Cancelled by user"]
              : Array.isArray(value)
                ? value
                : [value],
        },
      ];
    }),
  );
}
