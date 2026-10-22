import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import {
  askUserTool,
  checkQuestions,
  claudeQuestionAnswers,
  codexQuestionAnswers,
} from "../src/core/questions.mjs";
import { proposalText, taggedProposal } from "../src/core/plans.mjs";
import { readClaudePlan } from "../src/providers/claude.mjs";
import { createHarness } from "../src/server.mjs";

const questions = [
  {
    id: "checks",
    question: "Which checks?",
    multiSelect: true,
    options: [
      { label: "Browser, desktop", description: "Check the desktop." },
      { label: "Unit", description: "Check mappings." },
    ],
  },
];
async function waitFor(check) {
  const end = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < end, "Timed out waiting for fixture");
    await new Promise((done) => setTimeout(done, 5));
  }
}
function fixture(t, provider = "codex", mode = "plan", permissions = "manual") {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  const chat = store.createConversation({
    projectId: store.addProject("Questions", process.cwd()).id,
    provider,
    mode,
    permissions,
  });
  controller.providers = [
    { id: provider, models: [{ id: "fixture", efforts: [] }] },
  ];
  t.after(async () => {
    await controller.close();
    store.close();
  });
  let action = 0;
  const start = (runner) => {
    controller.runners[provider] = runner;
    const run = controller.send(chat.id, {
      text: "Review the proposal",
      provider,
      model: "fixture",
      actionId: "interface-fixture-" + ++action,
    });
    return { run, task: controller.active.get(chat.id).task };
  };
  return { store, controller, chat, start };
}

test("questions validate distinct IDs and usable options before waiting", () => {
  assert.equal(checkQuestions({ questions }), questions);
  assert.throws(() => checkQuestions({ questions: [] }), /one to three/);
  assert.throws(
    () => checkQuestions({ questions: [questions[0], questions[0]] }),
    /unique/,
  );
  assert.throws(
    () =>
      checkQuestions({ questions: [{ ...questions[0], multiSelect: "yes" }] }),
    /boolean/,
  );
  assert.throws(
    () =>
      checkQuestions({ questions: [{ ...questions[0], options: ["a", "b"] }] }),
    /labels/,
  );
});

test("native provider conversions preserve arrays and comma-containing labels", () => {
  const values = ["Browser, desktop", "Unit", "Mobile"];
  assert.deepEqual(
    codexQuestionAnswers(questions, {
      allow: true,
      answers: { checks: values },
    }),
    {
      checks: { answers: values },
    },
  );
  assert.deepEqual(codexQuestionAnswers(questions, { allow: false }), {
    checks: { answers: ["Cancelled by user"] },
  });
  assert.deepEqual(
    codexQuestionAnswers(questions, {
      allow: true,
      answers: { checks: "Legacy answer" },
    }),
    {
      checks: { answers: ["Legacy answer"] },
    },
  );
  assert.deepEqual(
    claudeQuestionAnswers({ checks: values, notes: "Keep focus" }),
    {
      checks: "Browser, desktop, Unit, Mobile",
      notes: "Keep focus",
    },
  );
});

for (const provider of ["codex", "claude", "cursor"])
  for (const mode of [
    "default",
    "ask",
    "plan",
    ...(provider === "cursor" ? [] : ["goal"]),
  ])
    test(`${provider}/${mode}: shared questions wait and return multiple selections intact`, async (t) => {
      const { store, controller, chat, start } = fixture(
        t,
        provider,
        mode,
        "override",
      );
      let received;
      const { task } = start(async (ctx) => {
        assert.ok(ctx.tools.some((tool) => tool.name === askUserTool.name));
        received = await ctx.history("ask_user", { questions });
        return { status: "completed" };
      });
      await waitFor(() => store.pendingApprovals(chat.id).length);
      assert.equal(received, undefined);
      controller.answer(store.pendingApprovals(chat.id)[0].id, {
        allow: true,
        answers: { checks: ["Browser, desktop", "Unit", "Mobile"] },
      });
      await task;
      assert.equal(store.conversation(chat.id).mode, mode);
      assert.deepEqual(received, {
        allow: true,
        answers: { checks: ["Browser, desktop", "Unit", "Mobile"] },
      });
      assert.equal(controller.bridgeQuestions.size, 0);
    });

test("cancelling a shared question releases its tool and bridge", async (t) => {
  const { store, controller, chat, start } = fixture(t);
  let received;
  const { task } = start(async (ctx) => {
    received = await ctx.history("ask_user", { questions });
    return { status: "completed" };
  });
  await waitFor(() => store.pendingApprovals(chat.id).length);
  controller.cancel(chat.id);
  await task;
  assert.equal(received.allow, false);
  assert.equal(controller.bridgeQuestions.size, 0);
});

test("proposal extraction keeps the last complete proposal and ignores partial tags", () => {
  assert.equal(taggedProposal("Checking the code."), null);
  assert.equal(taggedProposal("<proposed_plan>Partial"), null);
  assert.equal(
    taggedProposal(
      "<proposed_plan>Old</proposed_plan>\n<proposed_plan>New</proposed_plan>",
    ),
    "New",
  );
  assert.equal(
    proposalText("  ## Build a parser\n\nTest it.  "),
    "## Build a parser\n\nTest it.",
  );
});

test("proposals survive snapshots, revisions replace them, and runs cannot borrow old plans", async (t) => {
  const { store, controller, chat, start } = fixture(t);
  const first = start(async (ctx) => {
    ctx.emit("text", {
      nativeId: "final",
      text: "<proposed_plan>First plan</proposed_plan>",
    });
    ctx.emit("text", {
      nativeId: "final",
      text: "<proposed_plan>Revised plan</proposed_plan>",
    });
    return { status: "completed" };
  });
  await first.task;
  assert.equal(
    store.conversationSnapshot(chat.id).proposedPlans[first.run.id],
    "Revised plan",
  );
  const next = start(async (ctx) => {
    await ctx.approve({ kind: "plan", title: "Confirm?" });
    return { status: "completed" };
  });
  await waitFor(() => store.pendingApprovals(chat.id).length);
  const approval = store.pendingApprovals(chat.id)[0];
  assert.equal(approval.request.plan, undefined);
  assert.throws(
    () => controller.answer(approval.id, { allow: true }),
    /complete plan/,
  );
  controller.answer(approval.id, { allow: false });
  await next.task;
  assert.equal(store.proposedPlans(chat.id)[next.run.id], undefined);
});

test("native approval uses and persists the current proposal", async (t) => {
  const { store, controller, chat, start } = fixture(t);
  const { run, task } = start(async (ctx) => {
    const answer = await ctx.approve({
      kind: "plan",
      title: "Build?",
      plan: "<proposed_plan>Native plan</proposed_plan>",
    });
    if (answer.allow) ctx.planApproved();
    return { status: "completed" };
  });
  await waitFor(() => store.pendingApprovals(chat.id).length);
  const approval = store.pendingApprovals(chat.id)[0];
  assert.equal(approval.request.plan, "Native plan");
  assert.equal(
    store.conversationSnapshot(chat.id).proposedPlans[run.id],
    "Native plan",
  );
  controller.answer(approval.id, { allow: true });
  await task;
  assert.equal(store.conversation(chat.id).mode, "default");
});

test("a proposal streamed in chunks is captured only when its closing tag arrives", async (t) => {
  const { store, chat, start } = fixture(t, "cursor");
  const { run, task } = start(async (ctx) => {
    ctx.emit("text", {
      nativeId: "streamed",
      delta: "<proposed_plan>Streamed proposal</proposed_",
    });
    assert.deepEqual(store.proposedPlans(chat.id), {});
    ctx.emit("text", { nativeId: "streamed", delta: "plan>" });
    ctx.emit("text", { nativeId: "streamed", delta: "\n" });
    return { status: "completed" };
  });
  await task;
  assert.equal(
    store.conversationSnapshot(chat.id).proposedPlans[run.id],
    "Streamed proposal",
  );
  const count = store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM events WHERE run_id=? AND type='proposed-plan'",
    )
    .get(run.id).n;
  assert.equal(count, 1);
});

test("Claude reads only current-run markdown in its chat's plan directory", async (t) => {
  await mkdir(resolve(".local"), { recursive: true });
  const dir = await mkdtemp(resolve(".local/claude-plans-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const since = Date.now() - 1000;
  await writeFile(join(dir, "old.md"), "Old plan");
  await utimes(join(dir, "old.md"), new Date(0), new Date(0));
  await writeFile(join(dir, "notes.txt"), "Not a plan");
  await mkdir(join(dir, "directory.md"));
  assert.equal(await readClaudePlan(dir, since), null);
  await writeFile(
    join(dir, "current.md"),
    "<proposed_plan>Current plan</proposed_plan>",
  );
  assert.equal(await readClaudePlan(dir, since), "Current plan");
  assert.equal(await readClaudePlan(join(dir, "missing"), since), null);
});

test("Cursor's authenticated HTTP bridge offers questions, waits, returns arrays, and expires", async (t) => {
  await mkdir(".local", { recursive: true });
  const dataDir = await mkdtemp(resolve(".local/question-bridge-"));
  const projectPath = join(dataDir, "project");
  await mkdir(projectPath);
  const app = await createHarness({ dataDir, port: 0, startProviders: false });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const chat = app.store.createConversation({
    projectId: app.store.addProject("Bridge", projectPath).id,
    provider: "cursor",
    mode: "ask",
  });
  app.controller.providers = [
    { id: "cursor", models: [{ id: "fixture", efforts: [] }] },
  ];
  let headers, received;
  app.controller.runners.cursor = async (ctx) => {
    const env = Object.fromEntries(
      ctx.mcpServers[0].env.map(({ name, value }) => [name, value]),
    );
    headers = {
      Authorization: "Bearer " + env.HARNESS_BRIDGE_TOKEN,
      "Content-Type": "application/json",
    };
    const list = await fetch(app.runtime.origin + "/internal/tools", {
      headers,
    });
    assert.ok(
      (await list.json()).tools.some((tool) => tool.name === "ask_user"),
    );
    const result = await fetch(app.runtime.origin + "/internal/history", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "ask_user", arguments: { questions } }),
    });
    assert.equal(result.status, 200);
    received = await result.json();
    return { status: "completed" };
  };
  app.controller.send(chat.id, {
    text: "Ask about environments",
    provider: "cursor",
    model: "fixture",
    actionId: "bridge-question-fixture",
  });
  const task = app.controller.active.get(chat.id).task;
  await waitFor(() => app.store.pendingApprovals(chat.id).length);
  assert.equal(received, undefined);
  const approval = app.store.pendingApprovals(chat.id)[0];
  const answer = await fetch(
    app.runtime.origin + "/api/approvals/" + approval.id,
    {
      method: "POST",
      headers: { "X-Harness-Client": "1", "Content-Type": "application/json" },
      body: JSON.stringify({
        allow: true,
        answers: { checks: ["Browser, desktop", "Unit"] },
      }),
    },
  );
  assert.equal(answer.status, 200);
  await task;
  assert.deepEqual(received, {
    allow: true,
    answers: { checks: ["Browser, desktop", "Unit"] },
  });
  assert.equal(
    (await fetch(app.runtime.origin + "/internal/tools", { headers })).status,
    401,
  );
});
