// What can be handed to a low-cost worker, and the arithmetic that decides
// whether doing so is cheaper. The host does this arithmetic from things it can
// measure for free (file sizes, output sizes, past worker runs), so no model
// spends tokens estimating.
import { cost } from "./prices.mjs";

// The actions a user can allow, and the tool each one is offered through.
export const ACTIONS = {
  read: { tool: "delegate_read", label: "Read a file for the relevant parts" },
  extract: { tool: "delegate_read", label: "Extract facts into a list" },
  triage: { tool: "delegate_read", label: "Sort items by relevance" },
  summarise: { tool: "delegate_read", label: "Summarise for orientation" },
  locate: { tool: "delegate_locate", label: "Locate code or files" },
  edit: { tool: "delegate_edit", label: "One specified edit to one file" },
  run: { tool: "delegate_run", label: "Run a command and report" },
  draft: { tool: "delegate_draft", label: "Draft a commit or changelog" },
};
export const ACTION_NAMES = Object.keys(ACTIONS);
export const READ_PURPOSES = ["read", "extract", "triage", "summarise"];

const text = { type: "string" };
export const delegationTools = [
  {
    name: "delegate_read",
    description:
      "Get an answer from files instead of reading them in full: the relevant part, extracted values, items sorted by relevance, or a summary for orientation. Give repository-relative paths or globs and the question. The host returns raw text itself when that is cheaper.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: text },
        question: text,
        purpose: { type: "string", enum: READ_PURPOSES },
      },
      required: ["paths", "question", "purpose"],
      additionalProperties: false,
    },
  },
  {
    name: "delegate_locate",
    description:
      "Find where something lives in this repository when you do not already know the file. Give a symbol or a description. Returns paths and line numbers; a result of not found is not proof of absence.",
    inputSchema: {
      type: "object",
      properties: { query: text },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "delegate_edit",
    description:
      "Make one mechanical change to one file that you can state exactly in a sentence. Give the path, the instruction, about how many lines will change, and whether you have already read the file. Returns the diff to review, or declines when doing it yourself is cheaper.",
    inputSchema: {
      type: "object",
      properties: {
        path: text,
        instruction: text,
        lines: { type: "integer", minimum: 1 },
        have_read: { type: "boolean" },
      },
      required: ["path", "instruction", "lines"],
      additionalProperties: false,
    },
  },
  {
    name: "delegate_run",
    description:
      "Run one command in the repository whose output may be long (tests, a build, a linter). The user approves it. Returns the exit code and the output, or its relevant lines verbatim when the output is long. Say what you are looking for in want.",
    inputSchema: {
      type: "object",
      properties: { command: text, want: text },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "delegate_draft",
    description:
      "Draft a commit message or changelog entry from the repository's current uncommitted diff. Returns text to review, or declines when writing it yourself is cheaper.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["commit", "changelog"] },
        staged: { type: "boolean" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
];
export const isDelegationTool = (name) =>
  delegationTools.some((t) => t.name === name);
export function offeredTools(actions) {
  return delegationTools.filter((tool) =>
    ACTION_NAMES.some((a) => actions[a] && ACTIONS[a].tool === tool.name),
  );
}

export const tokensOf = (chars) => Math.ceil(chars / 4);
// A worker is used only when the whole round trip is estimated to cost less
// than this share of doing the work on the chat's own model.
export const MARGIN = 0.9;
export const MIN_HANDOFF = 2000;
const TOKENS_PER_LINE = 12,
  // The sentence a chat writes to ask for an edit, in output tokens.
  ASKING = 40;
// What a worker run looks like before any has been measured, and what the
// chat's own model is assumed to spend where the host cannot measure it.
const UNMEASURED = {
  inline: { extraInput: 1200 },
  search: { extraInput: 9000, output: 700 },
  edit: { extraInput: 1500 },
};
const ANSWER_SHARE = {
  read: 0.4,
  extract: 0.1,
  triage: 0.1,
  summarise: 0.05,
  run: 0.1,
};
export const ASSUMED = {
  locate: { input: 6000, output: 250 },
  draft: { commit: 120, changelog: 350 },
};

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};
// Turns a worker's recent runs of one kind into the numbers the estimate needs.
export function measure(runs = []) {
  return {
    count: runs.length,
    extraInput: median(runs.map((r) => Math.max(0, r.input - r.content))),
    output: median(runs.map((r) => r.output)),
    share: median(
      runs.filter((r) => r.content > 0).map((r) => r.output / r.content),
    ),
  };
}

// The cost of an action done by the chat's own model against the same action
// handed to a worker: starting the worker, its work, and the chat's model
// reading and checking what comes back. Amounts are dollars at list prices.
//   job: { action, content, lines, haveRead, kind }  (token counts)
export function estimate(job, prices, measured = {}) {
  const { main, worker } = prices,
    { action, content = 0 } = job,
    mode =
      action === "locate" ? "search" : action === "edit" ? "edit" : "inline",
    extra = measured.extraInput ?? UNMEASURED[mode].extraInput;
  let self, workerOut, review;
  if (action === "locate") {
    workerOut = measured.output ?? UNMEASURED.search.output;
    review = workerOut;
    self = cost(main, ASSUMED.locate.input, ASSUMED.locate.output);
  } else if (action === "edit") {
    const change = job.lines * TOKENS_PER_LINE;
    workerOut = change + 150;
    // Reviewing means reading the diff: removed and added lines plus context.
    review = 2 * change + 150;
    self = cost(main, job.haveRead ? 0 : content, change);
  } else if (action === "draft") {
    workerOut = ASSUMED.draft[job.kind];
    review = workerOut;
    // The chat already knows its own change, so its cost is only the writing.
    self = cost(main, 0, workerOut);
  } else {
    const share = measured.share ?? ANSWER_SHARE[action];
    workerOut = Math.max(150, Math.round(content * share));
    review = workerOut;
    self = cost(main, content, 0);
  }
  const workerIn = (mode === "search" ? 0 : content) + extra,
    delegated = cost(worker, workerIn, workerOut) + cost(main, review, 0);
  return {
    self,
    delegated,
    cheaper:
      delegated <= MARGIN * self &&
      // Below this size the saving is a fraction of a cent and not worth the
      // wait or the risk of a worse answer, so the host returns the text itself.
      (mode !== "inline" || action === "draft" || content >= MIN_HANDOFF),
  };
}

// The smallest edit worth offering, counting the sentence the chat must write
// to ask for it. Told to the agent so it does not call for smaller ones.
export function editThreshold(prices, measured) {
  const asking = cost(prices.main, 0, ASKING);
  for (let lines = 1; lines <= 400; lines++) {
    const e = estimate(
      { action: "edit", content: 2000, lines, haveRead: true },
      prices,
      measured,
    );
    if (e.delegated + asking <= MARGIN * e.self) return lines;
  }
  return null;
}
// The largest diff, in tokens, for which a drafted commit message is cheaper.
export function draftLimit(prices, measured, kind = "commit") {
  let limit = 0;
  for (const content of [500, 1000, 2000, 4000, 8000, 16000, 32000, 64000])
    if (estimate({ action: "draft", content, kind }, prices, measured).cheaper)
      limit = content;
  return limit;
}
