export const askUserTool = {
  name: "ask_user",
  description:
    "Ask the user one or more questions in Harness. Use multiSelect for independent choices the user can combine; omit it for mutually exclusive choices. Include short option labels and descriptions. Harness supplies Other automatically. Waits for an explicit answer or cancellation.",
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

export const QUESTION_INSTRUCTIONS =
  "For user questions, prefer Harness ask_user. Set multiSelect: true when choices can be combined; leave it false for mutually exclusive decisions. Multiple selections are returned as an array, including any Other response. Never preselect or submit an answer on the user's behalf. Native question tools remain available.";

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
    if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean")
      throw new Error("multiSelect must be a boolean");
    if (
      q.options !== undefined &&
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
