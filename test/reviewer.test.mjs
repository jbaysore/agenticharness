import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import {
  runCodexWorker,
  WorkerUnavailable,
} from "../src/providers/workers.mjs";
import { REVIEW_SCHEMA } from "../src/core/review-policy.mjs";
import { saveRules } from "../src/core/rules.mjs";
import { renameInstructions } from "../src/core/history.mjs";

const waitFor = async (condition) => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(
      Date.now() < deadline,
      "Timed out waiting for the review fixture",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const action = (
  command = "npm test",
  method = "session/request_permission",
) => ({
  kind: "permission",
  method,
  title: command,
  details: { kind: "execute", rawInput: { command }, toolCallId: command },
});
const decision = (value, reason = "A review reason.") => ({
  text: JSON.stringify({ decision: value, reason }),
});

async function fixture(t, permissions = "auto", provider = "cursor") {
  const root = await mkdtemp(join(tmpdir(), "harness-review-"));
  await writeFile(
    join(root, "AGENTS.md"),
    "Preserve other chats' changes. Commit and push task changes.",
  );
  const store = new Store(":memory:"),
    controller = new Controller(store, {}),
    chat = store.createConversation({
      projectId: store.addProject("Review fixture", root).id,
      permissions,
    }),
    jobs = [],
    contexts = [];
  controller.providers = [
    {
      id: "cursor",
      connected: true,
      models: [{ id: "cursor-model", efforts: [] }],
    },
    {
      id: "codex",
      name: "Codex",
      connected: true,
      models: [{ id: "review-model", name: "Reviewer", isDefault: true }],
    },
    // A Claude chat; otherwise Claude stays out so fallback tests choose it.
    ...(provider === "claude"
      ? [{ id: "claude", connected: true, models: [{ id: "review-model" }] }]
      : []),
  ];
  controller.workers.codex = async (job) => {
    jobs.push(job);
    return decision("allow");
  };
  controller.runners[provider] = async (ctx) => {
    contexts.push(ctx);
    if (!ctx.signal.aborted)
      await new Promise((resolve) =>
        ctx.signal.addEventListener("abort", resolve, { once: true }),
      );
    return { status: "cancelled" };
  };
  const run = controller.send(chat.id, {
    actionId: "review-fixture-action",
    text: "Run the tests",
    provider,
    model: provider === "cursor" ? "cursor-model" : "review-model",
  });
  await waitFor(() => contexts.length === 1);
  t.after(async () => {
    await controller.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    controller,
    chat,
    run,
    jobs,
    contexts,
    ctx: contexts[0],
  };
}

test("Cursor auto-review allows routine work with task/rules context and records its decision", async (t) => {
  const f = await fixture(t);
  f.store.setting("agent-rules", { instructions: "Keep edits small." });
  f.store.addMessage({
    conversationId: f.chat.id,
    role: "assistant",
    content: "ASSISTANT_PRIVATE_CONTEXT",
  });
  const prior = f.store.addApproval(
    f.chat.id,
    f.run.id,
    "cursor",
    action("erase unrelated work"),
  );
  f.store.resolveApproval(prior.id, { allow: false });
  const answer = await f.ctx.approve(action());
  assert.equal(answer.allow, true);
  assert.equal(f.store.pendingApprovals(f.chat.id).length, 0);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].model, "review-model");
  assert.equal(f.jobs[0].mode, "review");
  const context = JSON.parse(f.jobs[0].task);
  assert.equal(context.currentRequest, "Run the tests");
  assert.equal(context.standingInstructions, "Keep edits small.");
  // Naming the chat is the working agent's job, not the reviewer's.
  assert.equal(
    context.turnInstructions + renameInstructions("cursor"),
    f.ctx.instructions,
  );
  assert.match(context.projectRules, /Commit and push/);
  assert.equal(context.userRefusals[0].request.title, "erase unrelated work");
  assert.equal(context.proposedAction.details.rawInput.command, "npm test");
  assert.doesNotMatch(f.jobs[0].task, /ASSISTANT_PRIVATE_CONTEXT/);
  assert.deepEqual(f.store.conversation(f.chat.id).sessions, {});
  const events = f.store
    .events()
    .filter((e) => e.payload.kind === "permission-review");
  assert.deepEqual(
    events.map((e) => e.payload.status),
    ["running", "allow"],
  );
  assert.equal(events[0].payload.item.id, events[1].payload.item.id);
  assert.equal(f.store.steps(f.chat.id)[f.run.id][0].status, "ok");
});

test("the reviewer sees the agent's earlier actions this turn, but not its prose", async (t) => {
  const f = await fixture(t);
  const work = (item) =>
    f.controller.event(f.chat.id, f.run.id, "work", {
      kind: item.sessionUpdate,
      provider: "cursor",
      item,
    });
  work({
    sessionUpdate: "tool_call",
    toolCallId: "build",
    title: "`npm run build`",
    kind: "execute",
    status: "pending",
    rawInput: { command: "npm run build" },
  });
  work({
    sessionUpdate: "tool_call_update",
    toolCallId: "build",
    status: "completed",
  });
  work({
    sessionUpdate: "tool_call",
    toolCallId: "mcp",
    title: "MCP: tool",
    kind: "other",
    status: "pending",
    rawInput: {},
  });
  work({
    sessionUpdate: "tool_call_update",
    toolCallId: "mcp",
    title: "harness-history: browser_navigate",
    rawInput: {
      toolName: "browser_navigate",
      args: { url: "http://localhost:5173" },
    },
  });
  // The request under review is not listed as an earlier step.
  work({
    sessionUpdate: "tool_call",
    toolCallId: "npm test",
    title: "`npm test`",
    kind: "execute",
  });
  f.controller.event(f.chat.id, f.run.id, "text", { delta: "AGENT_PROSE" });
  assert.equal((await f.ctx.approve(action())).allow, true);
  const context = JSON.parse(f.jobs[0].task);
  assert.deepEqual(context.recentSteps, [
    {
      title: "`npm run build`",
      kind: "execute",
      status: "completed",
      input: '{"command":"npm run build"}',
    },
    {
      title: "harness-history: browser_navigate",
      kind: "other",
      status: "pending",
      input:
        '{"toolName":"browser_navigate","args":{"url":"http://localhost:5173"}}',
    },
  ]);
  assert.doesNotMatch(f.jobs[0].task, /AGENT_PROSE/);
});

test("the reviewer decides command permissions from every agent, while questions and plans still reach the user", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.controller.workers.codex = async () => {
    calls++;
    return decision("deny", "This erases unrelated work.");
  };
  assert.deepEqual(await f.ctx.approve(action("erase other work")), {
    allow: false,
    reason: "This erases unrelated work.",
  });
  assert.equal(f.store.pendingApprovals(f.chat.id).length, 0);
  await f.ctx.approve(action("Proposed plan", "cursor/create_plan"));
  // Codex and Claude escalations have no Cursor method; they are still reviewed.
  assert.deepEqual(
    await f.ctx.approve(
      action("npm test", "item/commandExecution/requestApproval"),
    ),
    { allow: false, reason: "This erases unrelated work." },
  );
  assert.deepEqual(
    await f.ctx.approve({
      kind: "permission",
      title: "Bash",
      details: { command: "npm test" },
    }),
    { allow: false, reason: "This erases unrelated work." },
  );
  assert.equal(calls, 4);
  assert.equal(f.store.pendingApprovals(f.chat.id).length, 0);
  for (const request of [
    { kind: "question", title: "Which file?" },
    { kind: "plan", title: "Review the plan", plan: "1. Keep the cache." },
  ]) {
    const result = f.ctx.approve(request);
    await waitFor(() => f.store.pendingApprovals(f.chat.id).length === 1);
    f.controller.answer(f.store.pendingApprovals(f.chat.id)[0].id, {
      allow: true,
    });
    assert.equal((await result).allow, true);
  }
  assert.equal(calls, 4);
});

// A stand-in browser: snapshots are read-only, everything else changes a page.
const fakeBrowser = (f) => {
  const calls = [];
  f.controller.browser = {
    needsApproval: async (name) => name !== "browser_snapshot",
    call: async (name, input) => {
      calls.push(name);
      return { content: [{ type: "text", text: `${name} done` }] };
    },
    close() {},
  };
  return calls;
};

for (const provider of ["codex", "claude", "cursor"])
  test(`${provider} browser actions in Auto-review go to the reviewer, not the user`, async (t) => {
    const f = await fixture(t, "auto", provider),
      calls = fakeBrowser(f);
    const result = await f.ctx.browser("browser_click", {
      element: "Save",
      target: "#save",
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, ["browser_click"]);
    assert.equal(f.store.pendingApprovals(f.chat.id).length, 0);
    assert.equal(f.jobs.length, 1);
    const context = JSON.parse(f.jobs[0].task);
    assert.equal(
      context.agent,
      { codex: "Codex", claude: "Claude Code", cursor: "Cursor" }[provider],
    );
    assert.equal(context.proposedAction.title, "Browser: click · Save");
    assert.deepEqual(context.proposedAction.details, {
      tool: "browser_click",
      input: { element: "Save", target: "#save" },
    });
    const review = f.store
      .events()
      .filter((e) => e.payload.kind === "permission-review")
      .at(-1).payload;
    assert.equal(review.provider, provider);
    // Read-only browser tools are never reviewed.
    await f.ctx.browser("browser_snapshot", {});
    assert.equal(f.jobs.length, 1);
  });

test("a declined browser action tells the agent why, and its earlier browser steps inform the next review", async (t) => {
  const f = await fixture(t, "auto", "codex"),
    calls = fakeBrowser(f);
  await f.ctx.browser("browser_navigate", { url: "http://localhost:5173" });
  f.controller.workers.codex = async (job) => {
    f.jobs.push(job);
    return decision("deny", "Submitting the payment form was not requested.");
  };
  const result = await f.ctx.browser("browser_click", { element: "Pay now" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Auto-review declined.*payment form/);
  assert.deepEqual(calls, ["browser_navigate"]);
  assert.deepEqual(JSON.parse(f.jobs[1].task).recentSteps, [
    {
      verb: "browse",
      target: "Browser: navigate · http://localhost:5173",
      status: "ok",
    },
  ]);
});

test("a browser action the reviewer cannot decide asks the user with its reason", async (t) => {
  const f = await fixture(t, "auto", "claude"),
    calls = fakeBrowser(f);
  f.controller.workers.codex = async () =>
    decision("ask", "Signing in was not requested.");
  const result = f.ctx.browser("browser_type", { text: "password" });
  await waitFor(() => f.store.pendingApprovals(f.chat.id).length === 1);
  const pending = f.store.pendingApprovals(f.chat.id)[0];
  assert.equal(pending.request.reviewReason, "Signing in was not requested.");
  f.controller.answer(pending.id, { allow: true });
  assert.equal((await result).isError, undefined);
  assert.deepEqual(calls, ["browser_type"]);
});

test("in Manual, browser actions still ask the user and skip the reviewer", async (t) => {
  const f = await fixture(t, "manual", "codex"),
    calls = fakeBrowser(f);
  const result = f.ctx.browser("browser_click", { element: "Save" });
  await waitFor(() => f.store.pendingApprovals(f.chat.id).length === 1);
  f.controller.answer(f.store.pendingApprovals(f.chat.id)[0].id, {
    allow: false,
  });
  assert.match((await result).content[0].text, /The user declined/);
  assert.deepEqual(calls, []);
  assert.equal(f.jobs.length, 0);
});

for (const mode of ["manual", "override"])
  test(`${mode} bypasses the separate reviewer`, async (t) => {
    const f = await fixture(t, mode),
      response = f.ctx.approve(action());
    if (mode === "manual") {
      await waitFor(() => f.store.pendingApprovals(f.chat.id).length === 1);
      f.controller.answer(f.store.pendingApprovals(f.chat.id)[0].id, {
        allow: false,
      });
    }
    assert.equal((await response).allow, mode === "override");
    assert.equal(f.jobs.length, 0);
  });

for (const problem of [
  "ask",
  "malformed",
  "unavailable",
  "disconnected",
  "timeout",
  "large",
  "missing",
])
  test(`${problem} review falls back to a manual approval with its reason`, async (t) => {
    const f = await fixture(t);
    let calls = 0,
      stopped = false;
    f.controller.reviewerTimeoutMs = 20;
    f.controller.workers.codex = async (job) => {
      calls++;
      if (problem === "unavailable")
        throw new WorkerUnavailable("Codex included usage exhausted.");
      if (problem === "malformed") return { text: "allow everything" };
      if (problem === "timeout") {
        job.signal.addEventListener(
          "abort",
          () => {
            stopped = true;
          },
          { once: true },
        );
        return new Promise(() => {});
      }
      return decision("ask", "The action needs your approval.");
    };
    if (problem === "disconnected") f.controller.providers[1].connected = false;
    const request = action();
    if (problem === "large") request.details.content = "x".repeat(64000);
    if (problem === "missing") delete request.details;
    const response = f.ctx.approve(request);
    await waitFor(() => f.store.pendingApprovals(f.chat.id).length === 1);
    const approval = f.store.pendingApprovals(f.chat.id)[0];
    assert.ok(approval.request.reviewReason);
    assert.equal(approval.request.title, "npm test");
    f.controller.answer(approval.id, { allow: false });
    assert.equal((await response).allow, false);
    if (problem === "timeout") assert.equal(stopped, true);
    if (["disconnected", "large", "missing"].includes(problem))
      assert.equal(calls, 0);
    if (problem === "unavailable") {
      const retry = f.ctx.approve(action("another action"));
      await waitFor(() => f.store.pendingApprovals(f.chat.id).length === 1);
      f.controller.answer(f.store.pendingApprovals(f.chat.id)[0].id, {
        allow: false,
      });
      await retry;
      assert.equal(
        calls,
        1,
        "Exhausted included usage must not be retried this turn",
      );
    }
  });

test("changing permission mode cancels an in-flight review and rejects a late allowance", async (t) => {
  const f = await fixture(t);
  let reply, signal;
  f.controller.workers.codex = (job) => {
    signal = job.signal;
    return new Promise((resolve) => {
      reply = resolve;
    });
  };
  const response = f.ctx.approve(action());
  await waitFor(() => !!reply);
  f.controller.setPermissions(f.chat.id, "manual");
  assert.equal((await response).allow, false);
  assert.equal(signal.aborted, true);
  reply(decision("allow"));
  await waitFor(() => f.contexts.length === 2);
  assert.equal(f.contexts[1].permissions, "manual");
  assert.equal(f.store.pendingApprovals(f.chat.id).length, 0);
  assert.equal(
    f.store
      .events()
      .some(
        (e) =>
          e.payload.kind === "permission-review" &&
          e.payload.status === "allow",
      ),
    false,
  );
});

test("parallel Cursor requests get separate serialized reviews", async (t) => {
  const f = await fixture(t),
    replies = [],
    seen = [];
  f.controller.workers.codex = (job) => {
    seen.push(JSON.parse(job.task).proposedAction.title);
    return new Promise((resolve) => replies.push(resolve));
  };
  const first = f.ctx.approve(action("first")),
    second = f.ctx.approve(action("second"));
  await waitFor(() => replies.length === 1);
  assert.deepEqual(seen, ["first"]);
  replies[0](decision("allow"));
  assert.equal((await first).allow, true);
  await waitFor(() => replies.length === 2);
  replies[1](decision("deny"));
  assert.equal((await second).allow, false);
  assert.deepEqual(seen, ["first", "second"]);
});

function addClaude(f) {
  const calls = [];
  f.controller.providers.push({
    id: "claude",
    name: "Claude Code",
    connected: true,
    models: [
      {
        id: "claude-review",
        name: "Claude reviewer",
        efforts: ["low", "high"],
        isDefault: true,
      },
    ],
  });
  f.controller.workers.claude = async (job) => {
    calls.push(job);
    return decision("allow");
  };
  return calls;
}

for (const problem of [
  "quota",
  "disconnected",
  "blocked",
  "timeout",
  "malformed",
  "error",
  "missing-model",
])
  test(`Codex ${problem} uses the selected Claude fallback`, async (t) => {
    const f = await fixture(t),
      claude = addClaude(f);
    f.controller.reviewerTimeoutMs = 20;
    f.store.setting("agent-rules", {
      review: {
        codex:
          problem === "missing-model"
            ? { model: "unavailable", effort: null }
            : null,
        claude: { model: "claude-review", effort: "high" },
        claudeFallback: true,
      },
    });
    let starts = 0,
      stopped = false;
    f.controller.workers.codex = async (job) => {
      starts++;
      if (problem === "quota")
        throw new WorkerUnavailable("Included quota exhausted");
      if (problem === "timeout") {
        job.signal.addEventListener(
          "abort",
          () => {
            stopped = true;
          },
          { once: true },
        );
        return new Promise(() => {});
      }
      if (problem === "malformed") return { text: "not a verdict" };
      throw new Error("Primary failed");
    };
    if (problem === "disconnected") f.controller.providers[1].connected = false;
    if (problem === "blocked")
      f.controller.providers[1].blockReason = "No included usage";
    assert.equal((await f.ctx.approve(action())).allow, true);
    assert.equal(f.store.pendingApprovals(f.chat.id).length, 0);
    assert.equal(claude[0].model, "claude-review");
    assert.equal(claude[0].effort, "high");
    assert.equal(claude[0].mode, "review");
    assert.equal(JSON.parse(claude[0].task).currentRequest, "Run the tests");
    if (problem === "timeout") assert.equal(stopped, true);
    if (problem === "quota") {
      await f.ctx.approve(action("another action"));
      assert.equal(starts, 1);
      assert.equal(claude.length, 2);
    }
    const final = f.store
      .events()
      .filter((e) => e.payload.decision === "allow")
      .at(-1);
    assert.equal(final.payload.reviewer.provider, "claude");
  });

for (const verdict of ["deny", "ask"])
  test(`a valid Codex ${verdict} never asks Claude for a different answer`, async (t) => {
    const f = await fixture(t),
      claude = addClaude(f);
    f.controller.workers.codex = async () => decision(verdict);
    const response = f.ctx.approve(action());
    if (verdict === "ask") {
      await waitFor(() => f.store.pendingApprovals(f.chat.id).length === 1);
      f.controller.answer(f.store.pendingApprovals(f.chat.id)[0].id, {
        allow: false,
      });
    }
    assert.equal((await response).allow, false);
    assert.equal(claude.length, 0);
  });

test("both providers exhausted ask the user and are not retried that turn", async (t) => {
  const f = await fixture(t);
  addClaude(f);
  let calls = 0;
  for (const provider of ["codex", "claude"])
    f.controller.workers[provider] = async () => {
      calls++;
      throw new WorkerUnavailable(provider + " exhausted");
    };
  for (let n = 0; n < 2; n++) {
    const response = f.ctx.approve(action());
    await waitFor(() => f.store.pendingApprovals(f.chat.id).length === 1);
    const approval = f.store.pendingApprovals(f.chat.id)[0];
    assert.match(approval.request.reviewReason, /could not run/);
    assert.match(approval.request.reviewReason, /codex exhausted/);
    assert.match(approval.request.reviewReason, /claude exhausted/);
    assert.match(approval.request.reviewReason, /Decline this unless/);
    f.controller.answer(approval.id, { allow: false });
    assert.equal((await response).allow, false);
  }
  assert.equal(calls, 2);
});

test("Claude fallback can be switched off", async (t) => {
  const f = await fixture(t),
    claude = addClaude(f);
  saveRules(
    f.store,
    { review: { claudeFallback: false } },
    f.controller.providers,
  );
  f.controller.providers[1].blockReason = "No Codex quota";
  const response = f.ctx.approve(action());
  await waitFor(() => f.store.pendingApprovals(f.chat.id).length === 1);
  f.controller.answer(f.store.pendingApprovals(f.chat.id)[0].id, {
    allow: false,
  });
  await response;
  assert.equal(claude.length, 0);
});

test("saving a pinned model and effort affects the next review of the same active turn", async (t) => {
  const f = await fixture(t);
  f.controller.providers[1].models.push({
    id: "chosen",
    name: "Chosen",
    efforts: ["low", "high"],
    isDefault: false,
  });
  saveRules(
    f.store,
    { review: { codex: { model: "chosen", effort: "high" } } },
    f.controller.providers,
  );
  await f.ctx.approve(action());
  assert.equal(f.jobs[0].model, "chosen");
  assert.equal(f.jobs[0].effort, "high");
  f.controller.providers[1].models[0].isDefault = true;
  saveRules(
    f.store,
    { review: { codex: { model: "chosen", effort: "low" } } },
    f.controller.providers,
  );
  await f.ctx.approve(action());
  assert.equal(f.jobs[1].model, "chosen");
  assert.equal(f.jobs[1].effort, "low");
  assert.equal(f.store.activeRun(f.chat.id).id, f.run.id);
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
  quotaReads = 0;
  constructor(options = {}) {
    super();
    this.options = options;
  }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === "account/read")
      return { account: { type: this.options.apiKey ? "apiKey" : "chatgpt" } };
    if (method === "account/rateLimits/read") {
      this.quotaReads++;
      const usage = includedUsage();
      if (
        this.options.exhausted ||
        (this.options.exhaustAfter && this.quotaReads > 1)
      )
        usage.ordinaryUsageAllowed = false;
      return usage;
    }
    if (method === "config/read")
      return {
        config: {
          model_provider: "openai",
          mcp_servers: { external: { enabled: true } },
          apps: { external: { enabled: true } },
          plugins: { external: { enabled: true } },
          ...(this.options.customRoute && {
            chatgpt_base_url: "https://invalid.example",
          }),
        },
      };
    if (method === "thread/start")
      return { thread: { id: "ephemeral-review" } };
    if (method === "turn/start") {
      queueMicrotask(() => {
        this.emit("notification", {
          method: "item/started",
          params: { item: { type: "userMessage" } },
        });
        this.emit("notification", {
          method: "turn/started",
          params: { turn: { id: "review-turn" } },
        });
        if (this.options.tool) {
          this.emit("notification", {
            method: "item/started",
            params: {
              item: { type: "commandExecution", command: "must not run" },
            },
          });
          return;
        }
        for (const method of [
          "item/fileChange/requestApproval",
          "item/commandExecution/requestApproval",
          "item/tool/call",
        ])
          this.emit("request", { id: method, method, params: {} });
        this.emit("notification", {
          method: "item/completed",
          params: {
            item: { type: "agentMessage", text: decision("allow").text },
          },
        });
        this.emit("notification", {
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        });
      });
      return { turn: { id: "review-turn" } };
    }
    if (method === "turn/interrupt") return {};
    throw new Error("Unexpected fake Codex method: " + method);
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
const nativeReview = (rpc) =>
  runCodexWorker(
    {
      cwd: process.cwd(),
      model: "review-model",
      task: "Synthetic review fixture",
      mode: "review",
      signal: new AbortController().signal,
    },
    { open: async () => rpc },
  );

test("the native reviewer is ephemeral, read-only, schema-constrained and refuses tool requests", async () => {
  const rpc = new FakeCodex();
  assert.equal((await nativeReview(rpc)).text, decision("allow").text);
  const thread = rpc.calls.find((c) => c.method === "thread/start").params,
    turn = rpc.calls.find((c) => c.method === "turn/start").params;
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.sandbox, "read-only");
  assert.equal(thread.approvalPolicy, "never");
  assert.equal(thread.config.forced_login_method, "chatgpt");
  assert.equal(thread.serviceTier, "default");
  assert.equal(thread.config.features.shell_tool, false);
  assert.equal(thread.config.mcp_servers.external.enabled, false);
  assert.equal(thread.config.apps.external.enabled, false);
  assert.equal(thread.config.plugins.external.enabled, false);
  assert.deepEqual(thread.dynamicTools, []);
  assert.deepEqual(turn.outputSchema, REVIEW_SCHEMA);
  assert.equal(
    rpc.responses.filter((r) => r.result?.decision === "decline").length,
    2,
  );
  assert.equal(
    rpc.responses.find((r) => r.id === "item/tool/call").rejected,
    true,
  );
  assert.equal(rpc.quotaReads, 2);
  assert.equal(rpc.closed, true);
});

for (const option of [
  "apiKey",
  "exhausted",
  "customRoute",
  "exhaustAfter",
  "tool",
])
  test(`the native reviewer fails closed for ${option}`, async () => {
    const rpc = new FakeCodex({ [option]: true });
    await assert.rejects(nativeReview(rpc));
    assert.equal(rpc.closed, true);
    if (["apiKey", "exhausted", "customRoute"].includes(option))
      assert.equal(
        rpc.calls.some((c) => c.method === "turn/start"),
        false,
      );
  });

test("a read-only Git command is allowed without a reviewer session unless the user refused something", async (t) => {
  const f = await fixture(t);
  const git = {
    ...action("`git status --short`"),
    details: {
      kind: "execute",
      title: "`git status --short`",
      toolCallId: "g",
    },
  };
  assert.equal((await f.ctx.approve(git)).allow, true);
  assert.equal(f.jobs.length, 0);
  assert.deepEqual(
    f.store
      .events()
      .filter((e) => e.payload.kind === "permission-review")
      .map((e) => e.payload.status),
    ["allow"],
  );
  const prior = f.store.addApproval(f.chat.id, f.run.id, "cursor", action("x"));
  f.store.resolveApproval(prior.id, { allow: false });
  assert.equal((await f.ctx.approve(git)).allow, true);
  assert.equal(f.jobs.length, 1);
});
