import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { applyWork } from "../src/core/steps.mjs";
import {
  PLAN_REVIEW_SCHEMA,
  parsePlanReview,
} from "../src/core/plan-review.mjs";
import { runClaudeWorker, runCodexWorker } from "../src/providers/workers.mjs";
import { saveReviewSettings } from "../src/core/rules.mjs";

const sound = () => ({
  assessment: "sound",
  summary: "The plan matches the request.",
  concerns: [],
  improvements: [],
  questions: [],
});
const concern = (n = 1) => ({
  severity: "medium",
  confidence: "high",
  title: "Concern " + n,
  scenario: "Following step " + n + " drops the saved file.",
  evidence: "src/app.mjs:" + n,
  suggestion: "Write the file before returning.",
});
const valid = () => ({
  ...sound(),
  assessment: "needs_revision",
  summary: "The save step can drop the file.",
  concerns: [concern()],
  improvements: [{ title: "Name the file", detail: "Say which file is written." }],
  questions: ["Should an existing file be replaced?"],
});
const providers = () =>
  ["codex", "claude"].map((id) => ({
    id,
    connected: true,
    models: [
      {
        id: id + "-model",
        name: id === "codex" ? "Codex model" : "Claude model",
        isDefault: true,
        efforts: ["medium"],
        defaultEffort: "medium",
      },
    ],
  }));
async function waitFor(check) {
  const end = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < end, "Timed out waiting for the plan review");
    await new Promise((done) => setTimeout(done, 5));
  }
}
let actions = 0;
function harness(t, provider = "claude") {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.openReviewer = () => {
    throw new Error("The persistent permission reviewer must not run");
  };
  controller.providers = providers();
  const project = store.addProject("Harness", process.cwd()),
    chat = store.createConversation({
      projectId: project.id,
      provider,
      model: provider + "-model",
      mode: "plan",
    }),
    run = store.createRun({
      conversationId: chat.id,
      actionId: "plan-review-" + ++actions,
      provider,
      model: provider + "-model",
      text: "Add an independent review button",
    });
  store.setRun(run.id, "completed");
  store.addMessage({
    conversationId: chat.id,
    runId: run.id,
    role: "assistant",
    provider,
    model: provider + "-model",
    content: "PLANNER PRIVATE REASONING",
  });
  store.createRun({
    conversationId: chat.id,
    actionId: "plan-review-later-" + actions,
    provider,
    model: provider + "-model",
    text: "LATER USER NOTE",
  });
  const approval = store.addApproval(chat.id, run.id, provider, {
    kind: "plan",
    title: "Review the plan",
    plan: "Add the button and keep confirmation working.",
  });
  t.after(async () => {
    await controller.close();
    store.close();
  });
  return { store, controller, chat, run, approval };
}

test("plan review parser accepts a complete review and rejects padding or malformed output", () => {
  assert.deepEqual(parsePlanReview(JSON.stringify(valid())), valid());
  assert.deepEqual(parsePlanReview(JSON.stringify(sound())), sound());
  const padded = valid();
  padded.concerns = Array.from({ length: 6 }, (_, i) => concern(i + 1));
  assert.throws(() => parsePlanReview(JSON.stringify(padded)), /invalid plan review/);
  for (const broken of [
    { ...valid(), assessment: "maybe" },
    { ...valid(), summary: " " },
    { ...valid(), extra: true },
    { ...valid(), questions: [""] },
  ])
    assert.throws(() => parsePlanReview(JSON.stringify(broken)), /invalid plan review/);
  assert.throws(() => parsePlanReview("not json"), /invalid plan review/);
});

test("a finished plan review is one step in the turn history", () => {
  const steps = applyWork([], {
    kind: "plan-review",
    status: "done",
    item: { id: "run", title: "Independent review: Sound" },
  });
  assert.deepEqual(steps[0].status, "ok");
  assert.equal(steps[0].target, "Independent review: Sound");
});

test("a Claude plan is reviewed by Codex and excludes the planner's own case", async (t) => {
  const { store, controller, chat, run, approval } = harness(t, "claude");
  const calls = [];
  controller.workers = {
    codex: async (job) => {
      calls.push(job);
      return { text: JSON.stringify(sound()), usage: { input: 2, output: 1 } };
    },
    claude: async () => {
      throw new Error("Claude should not review its own plan first");
    },
  };
  const started = controller.reviewPlan({
    chatId: chat.id,
    runId: run.id,
    approvalId: approval.id,
  });
  assert.equal(started.status, "running");
  await waitFor(() => store.planReview(chat.id, run.id)?.status === "done");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, "plan-review");
  assert.equal(calls[0].model, "codex-model");
  assert.match(calls[0].task, /Add an independent review button/);
  assert.match(calls[0].task, /Add the button and keep confirmation working/);
  assert.doesNotMatch(calls[0].task, /PLANNER PRIVATE REASONING/);
  assert.doesNotMatch(calls[0].task, /LATER USER NOTE/);
  assert.equal(store.planReview(chat.id, run.id).result.assessment, "sound");
  assert.equal(store.approval(approval.id).status, "pending");
  assert.equal(store.conversationSnapshot(chat.id).planReviews[run.id].status, "done");
});

test("a Codex or Cursor plan is reviewed by Claude, then Codex if Claude is unavailable", async (t) => {
  for (const provider of ["codex", "cursor"]) {
    const { store, controller, chat, run, approval } = harness(t, provider);
    const order = [];
    controller.workers = {
      claude: async () => {
        order.push("claude");
        throw Object.assign(new Error("Claude is unavailable"), { unavailable: true });
      },
      codex: async () => {
        order.push("codex");
        return { text: JSON.stringify(sound()), usage: {} };
      },
    };
    controller.reviewPlan({
      chatId: chat.id,
      runId: run.id,
      approvalId: approval.id,
    });
    await waitFor(() => store.planReview(chat.id, run.id)?.status === "done");
    assert.deepEqual(order, ["claude", "codex"]);
    assert.equal(store.approval(approval.id).status, "pending");
  }
});

test("plan review uses its own provider, model and effort even when they match the planner", async (t) => {
  const { store, controller, chat, run, approval } = harness(t, "claude");
  controller.providers[1].models.push({ id: "plan-model", efforts: ["high"] });
  saveReviewSettings(store, { primaryProvider: "codex", plan: {
    primaryProvider: "claude", fallbackEnabled: false,
    claude: { model: "plan-model", effort: "high" },
  } }, controller.providers);
  const jobs = [];
  controller.workers.claude = async (job) => {
    jobs.push(job);
    return { text: JSON.stringify(sound()) };
  };
  controller.workers.codex = async () => { throw new Error("Wrong provider"); };
  controller.reviewPlan({ chatId: chat.id, runId: run.id, approvalId: approval.id });
  await waitFor(() => store.planReview(chat.id, run.id)?.status === "done");
  assert.equal(jobs[0].model, "plan-model");
  assert.equal(jobs[0].effort, "high");
});

for (const transient of [false, true])
  test(`plan fallback off skips the other provider and bounds retries (${transient})`, async (t) => {
    const { store, controller, chat, run, approval } = harness(t);
    saveReviewSettings(store, { plan: { primaryProvider: "claude", fallbackEnabled: false } }, controller.providers);
    let calls = 0;
    controller.workers.claude = async () => {
      calls++;
      throw Object.assign(new Error(transient ? "Connection closed" : "Usage exhausted"), { unavailable: !transient });
    };
    controller.workers.codex = async () => { throw new Error("Must not try fallback"); };
    controller.reviewPlan({ chatId: chat.id, runId: run.id, approvalId: approval.id });
    await waitFor(() => store.planReview(chat.id, run.id)?.status === "failed");
    assert.equal(calls, transient ? 2 : 1);
    assert.doesNotMatch(store.planReview(chat.id, run.id).error, /Must not try fallback/);
    assert.equal(store.approval(approval.id).status, "pending");
  });

test("one transient failure is retried after the other provider has been tried", async (t) => {
  const { store, controller, chat, run, approval } = harness(t);
  let codexTries = 0;
  controller.workers = {
    codex: async () => {
      codexTries++;
      if (codexTries === 1) throw new Error("The plan reviewer timed out.");
      return { text: JSON.stringify(sound()), usage: {} };
    },
    claude: async () => {
      throw Object.assign(new Error("Claude is unavailable"), { unavailable: true });
    },
  };
  controller.reviewPlan({
    chatId: chat.id,
    runId: run.id,
    approvalId: approval.id,
  });
  await waitFor(() => store.planReview(chat.id, run.id)?.status === "done");
  assert.equal(codexTries, 2);
  assert.equal(store.approval(approval.id).status, "pending");
});

test("concurrent reviews of one plan share one run and leave the approval pending", async (t) => {
  const { store, controller, chat, run, approval } = harness(t);
  let started = 0,
    release = () => {};
  controller.workers = {
    codex: () => {
      started++;
      return new Promise((resolve) => {
        release = () => resolve({ text: JSON.stringify(sound()), usage: {} });
      });
    },
    claude: async () => {
      throw new Error("Claude should not start");
    },
  };
  const first = controller.reviewPlan({
    chatId: chat.id,
    runId: run.id,
    approvalId: approval.id,
  });
  await waitFor(() => started === 1);
  const second = controller.reviewPlan({
    chatId: chat.id,
    runId: run.id,
    approvalId: approval.id,
  });
  assert.equal(first.status, "running");
  assert.equal(second.status, "running");
  assert.equal(started, 1);
  assert.equal(store.approval(approval.id).status, "pending");
  release();
  await waitFor(() => store.planReview(chat.id, run.id)?.status === "done");
  assert.equal(started, 1);
  assert.equal(store.approval(approval.id).status, "pending");
});

test("a host restart fails a review that was still running", (t) => {
  const { store, chat, run } = harness(t);
  store.savePlanReview({
    conversationId: chat.id,
    runId: run.id,
    status: "running",
    reviewer: null,
    result: null,
    error: null,
  });
  store.recover();
  const review = store.planReview(chat.id, run.id);
  assert.equal(review.status, "failed");
  assert.match(review.error, /Host restarted/);
});

test("Claude plan review may read, search and list, and cannot edit or run commands", async () => {
  let options;
  const q = {
    close() {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      await q.prompt.next();
      yield {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
      };
      yield {
        type: "result",
        is_error: false,
        structured_output: sound(),
        modelUsage: {},
      };
    },
  };
  await runClaudeWorker(
    {
      cwd: process.cwd(),
      model: "claude-model",
      task: "Review this plan",
      mode: "plan-review",
      signal: new AbortController().signal,
    },
    {
      queryFn: (args) => {
        options = args.options;
        q.prompt = args.prompt;
        return q;
      },
      baseOptions: () => ({ settings: {} }),
      readAuth: async () => ({}),
      readUsage: async () => ({}),
      usageForAccount: () => ({ read: async () => ({ reason: null }) }),
      pollIntervalMs: 60_000,
    },
  );
  assert.deepEqual(options.tools, ["Read", "Grep", "Glob"]);
  assert.equal(options.permissionMode, "dontAsk");
  assert.deepEqual(options.outputFormat, {
    type: "json_schema",
    schema: PLAN_REVIEW_SCHEMA,
  });
  for (const name of ["Read", "Grep", "Glob", "StructuredOutput"])
    assert.equal((await options.canUseTool(name, {})).behavior, "allow");
  for (const name of ["Edit", "Bash", "Write"])
    assert.equal((await options.canUseTool(name, {})).behavior, "deny");
});

const includedUsage = () => ({
  ordinaryUsageAllowed: true,
  rateLimits: {
    primary: { usedPercent: 20, windowDurationMins: 300 },
    credits: { hasCredits: false, unlimited: false },
    spendControlReached: false,
    rateLimitReachedType: null,
  },
});
class FakeCodex extends EventEmitter {
  closed = false;
  calls = [];
  responses = [];
  constructor(command = false) {
    super();
    this.command = command;
  }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "account/rateLimits/read") return includedUsage();
    if (method === "config/read") return { config: { model_provider: "openai" } };
    if (method === "thread/start") return { thread: { id: "plan-review" } };
    if (method === "turn/start") {
      queueMicrotask(() => {
        this.emit("notification", {
          method: "turn/started",
          params: { turn: { id: "turn" } },
        });
        if (this.command) {
          this.emit("notification", {
            method: "item/started",
            params: { item: { type: "commandExecution", command: "npm test" } },
          });
          return;
        }
        this.emit("notification", {
          method: "item/started",
          params: { item: { type: "dynamicToolCall", tool: "read_file" } },
        });
        this.emit("request", {
          id: "read",
          method: "item/tool/call",
          params: {
            tool: "read_file",
            arguments: { path: "package.json", lineCount: 2 },
          },
        });
        this.emit("request", {
          id: "cmd",
          method: "item/commandExecution/requestApproval",
          params: { command: "npm test" },
        });
        setTimeout(() => {
          this.emit("notification", {
            method: "item/completed",
            params: {
              item: { type: "agentMessage", text: JSON.stringify(sound()) },
            },
          });
          this.emit("notification", {
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          });
        }, 200);
      });
      return { turn: { id: "turn" } };
    }
    if (method === "turn/interrupt") return {};
    throw new Error("Unexpected Codex method: " + method);
  }
  respond(id, result) {
    this.responses.push({ id, result });
  }
  reject(id) {
    this.responses.push({ id, rejected: true });
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.emit("closed", new Error("Closed"));
    }
  }
}

test("Codex plan review is read-only, schema-constrained, and can read repository files", async () => {
  const rpc = new FakeCodex();
  const answer = await runCodexWorker(
    {
      cwd: process.cwd(),
      model: "codex-model",
      task: "Review this plan",
      mode: "plan-review",
      signal: new AbortController().signal,
    },
    { open: async () => rpc },
  );
  assert.equal(answer.text, JSON.stringify(sound()));
  const thread = rpc.calls.find((call) => call.method === "thread/start").params,
    turn = rpc.calls.find((call) => call.method === "turn/start").params;
  assert.equal(thread.sandbox, "read-only");
  assert.equal(thread.approvalPolicy, "never");
  assert.equal(thread.config.features.shell_tool, false);
  assert.deepEqual(
    thread.dynamicTools.map((tool) => tool.name),
    ["read_file", "list_files", "search_files"],
  );
  assert.deepEqual(turn.outputSchema, PLAN_REVIEW_SCHEMA);
  assert.equal(rpc.responses.find((item) => item.id === "cmd").result.decision, "decline");
  const read = rpc.responses.find((item) => item.id === "read");
  assert.equal(read.result.success, true);
  assert.match(read.result.contentItems[0].text, /agentic-harness/);
});

test("Codex plan review rejects a command instead of running it", async () => {
  const rpc = new FakeCodex(true);
  await assert.rejects(
    runCodexWorker(
      {
        cwd: process.cwd(),
        model: "codex-model",
        task: "Review this plan",
        mode: "plan-review",
        signal: new AbortController().signal,
      },
      { open: async () => rpc },
    ),
    /attempted to use a tool/,
  );
  assert.equal(rpc.closed, true);
});
