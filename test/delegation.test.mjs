import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { saveRules } from "../src/core/rules.mjs";
import { WorkerUnavailable } from "../src/providers/workers.mjs";

const haiku = { provider: "claude", model: "haiku", effort: null },
  mini = { provider: "codex", model: "mini", effort: "low" },
  hasTool = (ctx) => ctx.tools.some((t) => t.name === "delegate_task");

// A controller with stubbed chat runners and workers, so the delegation rule
// is exercised without any provider.
function fixture(workers = [haiku, mini]) {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.providers = [
    {
      id: "claude",
      name: "Claude Code",
      connected: true,
      models: [
        { id: "opus", name: "Opus", efforts: [] },
        { id: "haiku", name: "Haiku", efforts: [] },
      ],
    },
    {
      id: "codex",
      name: "Codex",
      connected: true,
      models: [
        { id: "big", name: "Big", efforts: [] },
        { id: "mini", name: "Mini", efforts: ["low"] },
      ],
    },
    {
      id: "cursor",
      name: "Cursor",
      connected: true,
      models: [{ id: "composer", name: "Composer", efforts: [] }],
    },
  ];
  saveRules(
    store,
    {
      instructions: "Prefer small diffs.",
      delegate: { enabled: true, workers },
    },
    controller.providers,
  );
  const finish = [],
    events = [],
    calls = [],
    refreshes = [];
  let latest = null,
    count = 0;
  for (const provider of ["claude", "codex", "cursor"])
    controller.runners[provider] = async (ctx) => {
      latest = ctx;
      await new Promise((resolve) => finish.push(resolve));
      return { status: "completed" };
    };
  for (const provider of ["claude", "codex"])
    controller.workers[provider] = async (job) => {
      calls.push({ provider, ...job });
      return { text: `${provider} found it`, tokens: 1200, model: job.model };
    };
  controller.refreshProviders = async () => refreshes.push(1);
  controller.on("event", (e) => events.push(e));
  const project = store.addProject("Repo", "C:\\harness-fixture\\rules");
  return {
    store,
    controller,
    project,
    calls,
    refreshes,
    async start(provider, model) {
      const chat = store.createConversation({ projectId: project.id });
      latest = null;
      controller.send(chat.id, {
        actionId: `delegation-turn-${++count}-${provider}`,
        text: "Where is the parser?",
        provider,
        model,
      });
      while (!latest) await new Promise((r) => setTimeout(r, 5));
      return latest;
    },
    titles: () =>
      events
        .filter((e) => /^delegat/.test(e.payload.kind ?? ""))
        .map((e) => e.payload.item.title),
    async close() {
      for (const done of finish) done();
      await controller.close();
      store.close();
    },
  };
}

test("a Codex chat hands a search to the Claude worker and later turns learn what it cost", async () => {
  const f = fixture();
  const ctx = await f.start("codex", "big");
  assert.equal(hasTool(ctx), true);
  assert.match(ctx.instructions, /Prefer small diffs\./);
  assert.match(ctx.instructions, /low-cost worker \(Claude Code · Haiku\)/);
  assert.match(ctx.instructions, /small fixed overhead/);
  const answer = await ctx.history("delegate_task", {
    task: "Find the parser entry point",
    report: "paths and line numbers",
  });
  assert.deepEqual(answer, {
    answer: "claude found it",
    worker: "Claude Code · Haiku",
    tokens: 1200,
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].provider, "claude");
  assert.equal(f.calls[0].model, "haiku");
  assert.equal(f.calls[0].cwd, f.project.path);
  assert.equal(
    f.calls[0].task,
    "Find the parser entry point\n\nReport: paths and line numbers",
  );
  assert.deepEqual(f.titles(), [
    "Delegated to Claude Code · Haiku",
    "Claude Code · Haiku answered",
  ]);
  // A JSON string, as Codex sends its tool arguments, works the same way.
  await ctx.history("delegate_task", JSON.stringify({ task: "Again" }));
  assert.equal(f.calls.length, 2);
  // The other history tools are untouched.
  assert.deepEqual(await ctx.history("workspace_activity", {}), []);
  const next = await f.start("claude", "opus");
  assert.match(next.instructions, /about 1,200 tokens/);
  assert.deepEqual(await next.history("delegate_task", { task: " " }), {
    error: "No task was given.",
    reasons: [],
    instruction: "Describe the whole task.",
  });
  await f.close();
});

test("delegation is not offered when it is off, to Cursor chats, or to a chat already on the worker model", async () => {
  const f = fixture();
  const cursor = await f.start("cursor", "composer");
  assert.equal(hasTool(cursor), false);
  assert.match(cursor.instructions, /Prefer small diffs\./);
  assert.doesNotMatch(cursor.instructions, /delegate_task/);
  const cheap = await f.start("claude", "haiku");
  assert.equal(hasTool(cheap), false);
  assert.doesNotMatch(cheap.instructions, /delegate_task/);
  // A chat on the fallback's model can still use the primary worker.
  const onFallback = await f.start("codex", "mini");
  assert.equal(hasTool(onFallback), true);
  assert.match(onFallback.instructions, /Claude Code · Haiku/);
  saveRules(
    f.store,
    { delegate: { enabled: false, workers: [haiku] } },
    f.controller.providers,
  );
  const off = await f.start("codex", "big");
  assert.equal(hasTool(off), false);
  assert.doesNotMatch(off.instructions, /delegate_task|Prefer small diffs/);
  assert.deepEqual(f.titles(), []);
  await f.close();
});

test("a turn that starts while the worker is out of usage uses the fallback, or searches for itself", async () => {
  const f = fixture(),
    [claude, codex] = f.controller.providers;
  claude.blockReason = "A Claude included-usage limit is exhausted.";
  const ctx = await f.start("codex", "big");
  assert.equal(hasTool(ctx), true);
  assert.match(ctx.instructions, /low-cost worker \(Codex · Mini\)/);
  assert.deepEqual(f.titles(), ["Searches go to Codex · Mini"]);
  await ctx.history("delegate_task", { task: "Find it" });
  assert.deepEqual(
    f.calls.map((c) => [c.provider, c.model, c.effort]),
    [["codex", "mini", "low"]],
  );
  codex.models[1].disabled = true;
  const alone = await f.start("codex", "big");
  assert.equal(hasTool(alone), false);
  assert.doesNotMatch(alone.instructions, /delegate_task/);
  assert.equal(
    f.titles().at(-1),
    "No worker is available; this chat will search for itself",
  );
  await f.close();
});

test("a worker that hits its limit mid-turn gives way to the fallback and is not tried again", async () => {
  const f = fixture();
  f.controller.workers.claude = async () => {
    f.calls.push({ provider: "claude" });
    throw new WorkerUnavailable("A Claude included-usage limit is exhausted.");
  };
  const ctx = await f.start("codex", "big");
  const first = await ctx.history("delegate_task", { task: "Find it" });
  assert.equal(first.answer, "codex found it");
  assert.equal(first.worker, "Codex · Mini");
  assert.deepEqual(
    f.calls.map((c) => c.provider),
    ["claude", "codex"],
  );
  assert.equal(f.refreshes.length, 1);
  assert.deepEqual(f.titles(), [
    "Delegated to Claude Code · Haiku",
    "Claude Code · Haiku could not run",
    "Delegated to Codex · Mini",
    "Codex · Mini answered",
  ]);
  await ctx.history("delegate_task", { task: "Find another" });
  assert.deepEqual(
    f.calls.map((c) => c.provider),
    ["claude", "codex", "codex"],
  );
  // With every worker out, the chat is told to carry on alone and no process starts.
  f.controller.workers.codex = async () => {
    f.calls.push({ provider: "codex" });
    throw new WorkerUnavailable("Included Codex usage is exhausted.");
  };
  const none = await ctx.history("delegate_task", { task: "Find a third" });
  assert.equal(none.error, "No worker could finish this task.");
  assert.match(none.instruction, /do not call delegate_task again/);
  assert.deepEqual(none.reasons, [
    "Claude Code · Haiku: A Claude included-usage limit is exhausted.",
    "Codex · Mini: Included Codex usage is exhausted.",
  ]);
  const before = f.calls.length;
  const again = await ctx.history("delegate_task", { task: "Find a fourth" });
  assert.equal(again.error, "No worker is available.");
  assert.equal(f.calls.length, before);
  await f.close();
});

test("a slow worker falls through, a stopped turn stops its worker, and delegations are capped", async () => {
  const f = fixture();
  f.controller.workerTimeoutMs = 30;
  let aborted = 0;
  f.controller.workers.claude = ({ signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => {
        aborted++;
        reject(new Error("stopped"));
      }),
    );
  const ctx = await f.start("codex", "big");
  const slow = await ctx.history("delegate_task", { task: "Find it" });
  assert.equal(slow.worker, "Codex · Mini");
  assert.equal(aborted, 1);
  assert.equal(f.titles()[1], "Claude Code · Haiku could not run");
  // A timeout is not a usage limit: the worker stays available and nothing is refreshed.
  assert.equal(f.refreshes.length, 0);

  f.controller.workerTimeoutMs = 60_000;
  const held = [];
  f.controller.workers.claude = () =>
    new Promise((resolve) =>
      held.push(() => resolve({ text: "done", tokens: 10 })),
    );
  const running = [1, 2, 3].map((n) =>
    ctx.history("delegate_task", { task: "Parallel " + n }),
  );
  const fourth = await ctx.history("delegate_task", { task: "Parallel 4" });
  assert.match(fourth.error, /3 delegations are already running/);
  for (const release of held) release();
  assert.deepEqual(
    (await Promise.all(running)).map((r) => r.answer),
    ["done", "done", "done"],
  );
  f.controller.workers.claude = async () => ({ text: "ok", tokens: 5 });
  let last;
  for (let i = 0; i < 12; i++)
    last = await ctx.history("delegate_task", { task: "Serial " + i });
  assert.match(last.error, /used its 12 delegations/);

  const stopped = await f.start("codex", "big");
  f.controller.workers.claude = ({ signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("stopped"))),
    );
  const pending = stopped.history("delegate_task", { task: "Never finishes" });
  f.controller.cancel(stopped.chat.id);
  await assert.rejects(pending, /stopped/);
  await f.close();
});
