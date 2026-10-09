import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { saveRules } from "../src/core/rules.mjs";
import { WorkerUnavailable } from "../src/providers/workers.mjs";

const haiku = { provider: "claude", model: "haiku", effort: null },
  luna = { provider: "codex", model: "gpt-6-luna", effort: "high" },
  toolNames = (ctx) =>
    ctx.tools.map((t) => t.name).filter((name) => name.startsWith("delegate_"));
const bigFile = Array.from(
  { length: 900 },
  (_, i) => `export function step${i}(value) { return value + ${i}; } // TODO`,
).join("\n");

// A real Git project in a temporary folder, with a controller whose chat
// runners, workers and command runner are stubs. No provider is contacted.
async function fixture({ workers = [luna, haiku], actions } = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "harness-delegate-")));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "big.js"), bigFile);
  await writeFile(
    join(root, "src", "small.js"),
    "export const uniqueMarkerValue = 42;\n",
  );
  await writeFile(join(root, ".env"), "SECRET=1\n");
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("add", "src");
  git("commit", "-q", "-m", "Initial");

  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.providers = [
    {
      id: "claude",
      name: "Claude Code",
      connected: true,
      models: [
        {
          id: "opus",
          name: "Opus",
          efforts: [],
          resolvedModel: "claude-opus-5-5",
        },
        {
          id: "haiku",
          name: "Haiku",
          efforts: [],
          resolvedModel: "claude-haiku-5-5",
        },
      ],
    },
    {
      id: "codex",
      name: "Codex",
      connected: true,
      models: [
        { id: "gpt-6.1-sol", name: "Sol", efforts: [] },
        { id: "gpt-6-luna", name: "Luna", efforts: ["low", "high"] },
        { id: "gpt-5.6-terra", name: "Terra", efforts: [] },
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
      delegate: { enabled: true, workers, actions },
    },
    controller.providers,
  );
  const finish = [],
    events = [],
    jobs = [],
    refreshes = [],
    commands = [];
  let latest = null,
    count = 0;
  for (const provider of ["claude", "codex", "cursor"])
    controller.runners[provider] = async (ctx) => {
      latest = ctx;
      await new Promise((resolve) => finish.push(resolve));
      return { status: "completed" };
    };
  // A stub worker answers at once. In edit mode it makes the change itself,
  // to the first thirty lines so that the whole diff fits in the reply.
  const worker = (provider) => async (job) => {
    jobs.push({ provider, ...job });
    let changed = 0;
    if (job.mode === "edit")
      await writeFile(
        job.editPath,
        (await readFile(job.editPath, "utf8")).replace(/\/\/ TODO/g, (found) =>
          changed++ < 30 ? "// DONE" : found,
        ),
      );
    return {
      text: `${provider} ${job.mode} answer`,
      usage: { input: 900, output: 120 },
    };
  };
  controller.workers = { claude: worker("claude"), codex: worker("codex") };
  controller.refreshProviders = async () => refreshes.push(1);
  controller.waitApproval = async () => ({ allow: true });
  controller.runCommand = async (request) => {
    commands.push(request);
    return { exitCode: 1, output: "FAIL one\n" + "ok\n".repeat(20_000) };
  };
  controller.on("event", (e) => events.push(e));
  const project = store.addProject("Repo", root);
  return {
    root,
    store,
    controller,
    jobs,
    refreshes,
    commands,
    git,
    async start(provider, model) {
      const chat = store.createConversation({ projectId: project.id });
      latest = null;
      controller.send(chat.id, {
        actionId: `delegation-turn-${++count}-${provider}`,
        text: "Do the work",
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
    last: () =>
      events.filter((e) => /^delegat/.test(e.payload.kind ?? "")).at(-1),
    async close() {
      for (const done of finish) done();
      await controller.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a large file is read by the worker, a small one comes back as text, and the cost is recorded", async () => {
  const f = await fixture();
  const ctx = await f.start("claude", "opus");
  assert.deepEqual(toolNames(ctx), [
    "delegate_read",
    "delegate_locate",
    "delegate_edit",
    "delegate_run",
    "delegate_draft",
  ]);
  assert.match(ctx.instructions, /Prefer small diffs\./);
  assert.match(ctx.instructions, /low-cost worker \(Codex · Luna\)/);
  assert.match(ctx.instructions, /Do not estimate costs yourself/);
  assert.match(ctx.instructions, /touches about 17 or more lines/);
  assert.match(ctx.instructions, /every usage, nothing calls this/);

  const big = await ctx.history("delegate_read", {
    paths: ["src/big.js"],
    question: "Which function adds 400?",
    purpose: "read",
  });
  assert.deepEqual(big, { answer: "codex inline answer", by: "Codex · Luna" });
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].mode, "inline");
  assert.equal(f.jobs[0].model, "gpt-6-luna");
  assert.equal(f.jobs[0].effort, "high");
  assert.match(f.jobs[0].task, /Question: Which function adds 400\?/);
  assert.match(
    f.jobs[0].task,
    /=== src\/big\.js ===\n1\texport function step0/,
  );
  assert.deepEqual(f.titles(), [
    "Delegated to Codex · Luna",
    "Codex · Luna answered",
  ]);
  assert.match(
    f.last().payload.item.description,
    /1,020 tokens, about \d+% of/,
  );
  assert.ok(f.last().payload.spent < f.last().payload.estimate.self);

  // A small file is cheaper to hand straight to the chat: no worker starts.
  const small = await ctx.history("delegate_read", {
    paths: [join(f.root, "src", "small.js")],
    question: "What is the marker?",
    purpose: "extract",
  });
  assert.deepEqual(small, {
    files: [
      { path: "src/small.js", text: "export const uniqueMarkerValue = 42;\n" },
    ],
  });
  assert.equal(f.jobs.length, 1);
  assert.equal(f.titles().at(-1), "Returned the file text itself");

  // A glob gathers files; anything private or outside the project is refused.
  const both = await ctx.history("delegate_read", {
    paths: ["src/*.js"],
    question: "Summarise",
    purpose: "summarise",
  });
  assert.equal(both.by, "Codex · Luna");
  assert.match(f.jobs[1].task, /=== src\/small\.js ===/);
  for (const paths of [[".env"], ["../outside.txt"], ["src/missing.js"], []])
    assert.ok(
      (
        await ctx.history("delegate_read", {
          paths,
          question: "?",
          purpose: "read",
        })
      ).error,
      JSON.stringify(paths),
    );
  assert.equal(f.jobs.length, 2);
  // The next turn's estimate uses what the worker really spent.
  const again = await f.start("claude", "opus");
  await again.history("delegate_read", {
    paths: ["src/big.js"],
    question: "Again",
    purpose: "read",
  });
  assert.ok(f.last().payload.estimate.delegated < 0.005);
  await f.close();
});

test("an exact name is found with no model, and a description goes to the worker", async () => {
  const f = await fixture({ workers: [haiku, luna] });
  const ctx = await f.start("codex", "gpt-6.1-sol");
  assert.match(ctx.instructions, /low-cost worker \(Claude Code · Haiku\)/);
  const exact = await ctx.history("delegate_locate", {
    query: "uniqueMarkerValue",
  });
  assert.deepEqual(exact.matches, [
    "src/small.js:1:export const uniqueMarkerValue = 42;",
  ]);
  assert.equal(f.jobs.length, 0);
  assert.equal(f.titles().at(-1), "Found by exact search");
  const described = await ctx.history(
    "delegate_locate",
    JSON.stringify({ query: "where values are incremented by an index" }),
  );
  assert.deepEqual(described, {
    answer: "claude search answer",
    by: "Claude Code · Haiku",
  });
  assert.equal(f.jobs[0].mode, "search");
  // A name that appears nowhere, or too often to list, also goes to the worker.
  await ctx.history("delegate_locate", { query: "noSuchSymbolAnywhere" });
  await ctx.history("delegate_locate", { query: "export" });
  assert.equal(f.jobs.length, 3);
  assert.match(f.jobs[2].task, /appears on 901 lines/);
  assert.ok((await ctx.history("delegate_locate", { query: " " })).error);
  await f.close();
});

test("a large mechanical edit goes to the worker and comes back as a diff; a small one is declined", async () => {
  const f = await fixture();
  const ctx = await f.start("claude", "opus");
  const declined = await ctx.history("delegate_edit", {
    path: "src/big.js",
    instruction: "Change one TODO to DONE",
    lines: 1,
    have_read: true,
  });
  assert.equal(declined.declined, true);
  assert.match(declined.reason, /yourself is estimated to be cheaper/);
  assert.equal(f.jobs.length, 0);

  const edited = await ctx.history("delegate_edit", {
    path: "src/big.js",
    instruction: "Replace the first thirty // TODO comments with // DONE",
    lines: 30,
  });
  assert.equal(edited.by, "Codex · Luna");
  assert.match(edited.diff, /^-export function step0\(value\).*\/\/ TODO$/m);
  assert.match(edited.diff, /^\+export function step0\(value\).*\/\/ DONE$/m);
  assert.equal(f.jobs[0].mode, "edit");
  assert.equal(f.jobs[0].editPath, join(f.root, "src", "big.js"));
  assert.equal(
    f.jobs[0].task,
    "File: src/big.js\nChange: Replace the first thirty // TODO comments with // DONE",
  );
  assert.match(await readFile(join(f.root, "src", "big.js"), "utf8"), /DONE/);

  // A worker that changes nothing, or fails part-way, leaves the file as it was.
  const before = await readFile(join(f.root, "src", "big.js"), "utf8");
  f.controller.workers.codex = async (job) => {
    f.jobs.push({ provider: "codex", ...job });
    return { text: "nothing to do", usage: { input: 10, output: 5 } };
  };
  f.controller.workers.claude = async (job) => {
    f.jobs.push({ provider: "claude", ...job });
    await writeFile(job.editPath, "half finished");
    throw new Error("crashed");
  };
  const failed = await ctx.history("delegate_edit", {
    path: "src/big.js",
    instruction: "Rename every function",
    lines: 900,
  });
  assert.match(failed.error, /The file is unchanged/);
  assert.deepEqual(failed.reasons, [
    "Codex · Luna: it made no change to the file",
    "Claude Code · Haiku: crashed",
  ]);
  assert.equal(await readFile(join(f.root, "src", "big.js"), "utf8"), before);
  assert.ok(
    (
      await ctx.history("delegate_edit", {
        path: ".env",
        instruction: "x",
        lines: 50,
      })
    ).error,
  );
  await f.close();
});

test("a command needs approval; short output comes back whole and long output as its relevant lines", async () => {
  const f = await fixture();
  const ctx = await f.start("claude", "opus");
  const long = await ctx.history("delegate_run", {
    command: "npm test",
    want: "failing tests",
  });
  assert.deepEqual(f.commands[0].command, "npm test");
  assert.equal(f.commands[0].cwd, f.root);
  assert.equal(long.exitCode, 1);
  assert.equal(long.relevant, "codex inline answer");
  assert.match(long.note, /full output was about [\d,]+ tokens/);
  assert.match(f.jobs[0].task, /Wanted: failing tests\./);
  assert.match(f.jobs[0].task, /Exit code: 1\n\n1\tFAIL one\n2\tok/);

  f.controller.runCommand = async () => ({ exitCode: 0, output: "3 passed\n" });
  assert.deepEqual(await ctx.history("delegate_run", { command: "npm test" }), {
    exitCode: 0,
    output: "3 passed\n",
  });
  assert.equal(f.jobs.length, 1);

  let ran = false;
  f.controller.waitApproval = async (run, request) => {
    assert.equal(request.title, "rm -rf build");
    assert.equal(request.details.requestedThrough, "delegate_run");
    return { allow: false };
  };
  f.controller.runCommand = async () => (ran = true);
  const refused = await ctx.history("delegate_run", {
    command: "rm -rf build",
  });
  assert.equal(refused.declined, true);
  assert.equal(ran, false);
  await f.close();
});

test("a commit message is drafted from the uncommitted diff", async () => {
  const f = await fixture();
  const ctx = await f.start("claude", "opus");
  assert.match(
    (await ctx.history("delegate_draft", { kind: "commit" })).error,
    /no uncommitted change/,
  );
  await writeFile(
    join(f.root, "src", "small.js"),
    "export const uniqueMarkerValue = 43;\n",
  );
  assert.deepEqual(await ctx.history("delegate_draft", { kind: "commit" }), {
    draft: "codex inline answer",
    by: "Codex · Luna",
  });
  assert.match(f.jobs[0].task, /^Write a commit message for this diff/);
  assert.match(f.jobs[0].task, /\+export const uniqueMarkerValue = 43;/);
  assert.match(
    (await ctx.history("delegate_draft", { kind: "commit", staged: true }))
      .error,
    /no uncommitted change/,
  );
  await ctx.history("delegate_draft", { kind: "changelog" });
  assert.match(f.jobs[1].task, /^Write a changelog entry/);
  await f.close();
});

test("nothing is offered when the rule is off, to Cursor, on the worker model, or without a price", async () => {
  const f = await fixture({ workers: [haiku, luna] });
  const cursor = await f.start("cursor", "composer");
  assert.deepEqual(toolNames(cursor), []);
  assert.match(cursor.instructions, /Prefer small diffs\./);
  assert.doesNotMatch(cursor.instructions, /delegate_/);
  assert.deepEqual(toolNames(await f.start("claude", "haiku")), []);
  assert.deepEqual(f.titles(), []);
  // Without a price for the chat's model nothing can be compared.
  const unpriced = await f.start("codex", "gpt-5.6-terra");
  assert.deepEqual(toolNames(unpriced), []);
  assert.equal(
    f.titles().at(-1),
    "Nothing is handed off this turn; this chat does its own work",
  );
  assert.match(
    f.last().payload.item.description,
    /No list price is known for Codex · Terra/,
  );
  assert.deepEqual(
    await unpriced.history("delegate_locate", { query: "anything" }),
    {
      error: "Nothing can be handed off this turn.",
      instruction: "Do this yourself.",
    },
  );
  // The user can switch actions off one by one.
  saveRules(
    f.store,
    {
      delegate: {
        enabled: true,
        workers: [haiku],
        actions: { edit: false, run: false, read: false, extract: false },
      },
    },
    f.controller.providers,
  );
  const fewer = await f.start("codex", "gpt-6.1-sol");
  assert.deepEqual(toolNames(fewer), [
    "delegate_read",
    "delegate_locate",
    "delegate_draft",
  ]);
  assert.match(
    fewer.instructions,
    /delegate_read \(purpose triage, summarise\)/,
  );
  assert.doesNotMatch(fewer.instructions, /delegate_edit|delegate_run/);
  // A purpose that is switched off is served as plain text, never by a worker.
  const plain = await fewer.history("delegate_read", {
    paths: ["src/big.js"],
    question: "?",
    purpose: "read",
  });
  assert.equal(plain.files.length, 1);
  assert.equal(f.jobs.length, 0);
  saveRules(
    f.store,
    { delegate: { enabled: false, workers: [haiku] } },
    f.controller.providers,
  );
  const off = await f.start("codex", "gpt-6.1-sol");
  assert.deepEqual(toolNames(off), []);
  assert.doesNotMatch(off.instructions, /delegate_|Prefer small diffs/);
  await f.close();
});

test("a worker out of usage gives way to the fallback, at the start of a turn or during it", async () => {
  const f = await fixture({ workers: [haiku, luna] }),
    [claude] = f.controller.providers,
    read = (ctx) =>
      ctx.history("delegate_read", {
        paths: ["src/big.js"],
        question: "?",
        purpose: "read",
      });
  claude.blockReason = "A Claude included-usage limit is exhausted.";
  const ctx = await f.start("codex", "gpt-6.1-sol");
  assert.match(ctx.instructions, /low-cost worker \(Codex · Luna\)/);
  assert.equal(f.titles().at(-1), "Hand-offs go to Codex · Luna");
  assert.match(
    f.last().payload.item.description,
    /Claude Code · Haiku: A Claude included-usage limit is exhausted./,
  );
  assert.equal((await read(ctx)).by, "Codex · Luna");
  // A limit reached during a turn: the worker is dropped and the next one tried.
  claude.blockReason = null;
  f.jobs.length = 0;
  const opus = await f.start("claude", "opus");
  f.controller.workers.claude = async () => {
    f.jobs.push({ provider: "claude" });
    throw new WorkerUnavailable("A Claude included-usage limit is exhausted.");
  };
  assert.equal((await read(opus)).by, "Codex · Luna");
  assert.deepEqual(
    f.jobs.map((j) => j.provider),
    ["claude", "codex"],
  );
  assert.equal(f.refreshes.length, 1);
  assert.deepEqual(f.titles().slice(-4), [
    "Delegated to Claude Code · Haiku",
    "Claude Code · Haiku could not run",
    "Delegated to Codex · Luna",
    "Codex · Luna answered",
  ]);
  await read(opus);
  assert.deepEqual(
    f.jobs.map((j) => j.provider),
    ["claude", "codex", "codex"],
  );
  // With every worker out, the host still serves the read: the chat is never worse off.
  f.controller.workers.codex = async () => {
    throw new WorkerUnavailable("Included Codex usage is exhausted.");
  };
  const served = await read(opus);
  assert.equal(served.files[0].path, "src/big.js");
  const none = await opus.history("delegate_locate", { query: "where it is" });
  assert.equal(none.error, "No worker could search.");
  assert.match(none.instruction, /do not use the delegate tools again/);
  assert.equal(none.reasons.length, 2);
  await f.close();
});

test("a slow worker gives way, a stopped turn stops its worker, and worker runs are capped", async () => {
  const f = await fixture({ workers: [haiku, luna] }),
    read = (ctx) =>
      ctx.history("delegate_read", {
        paths: ["src/big.js"],
        question: "?",
        purpose: "summarise",
      });
  f.controller.workerTimeoutMs = 30;
  let aborted = 0;
  const hang = ({ signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => {
        aborted++;
        reject(new Error("stopped"));
      }),
    );
  f.controller.workers.claude = hang;
  const ctx = await f.start("codex", "gpt-6.1-sol");
  // The fallback here is the chat's own provider on a cheaper model.
  assert.equal((await read(ctx)).by, "Codex · Luna");
  assert.equal(aborted, 1);
  assert.equal(f.refreshes.length, 0);

  f.controller.workerTimeoutMs = 60_000;
  const held = [];
  f.controller.workers.claude = () =>
    new Promise((resolve) =>
      held.push(() =>
        resolve({ text: "done", usage: { input: 9, output: 1 } }),
      ),
    );
  f.controller.workers.codex = f.controller.workers.claude;
  const running = [1, 2, 3].map(() => read(ctx));
  await new Promise((r) => setTimeout(r, 50));
  // A fourth at once is served by the host instead of waiting.
  assert.equal((await read(ctx)).files.length, 1);
  for (const release of held) release();
  assert.deepEqual(
    (await Promise.all(running)).map((r) => r.answer),
    ["done", "done", "done"],
  );
  f.controller.workers.claude = async () => ({
    text: "ok",
    usage: { input: 9, output: 1 },
  });
  let last;
  for (let i = 0; i < 12; i++) last = await read(ctx);
  assert.equal(last.files.length, 1);

  const stopped = await f.start("codex", "gpt-6.1-sol");
  f.controller.workers.claude = hang;
  const pending = read(stopped);
  await new Promise((r) => setTimeout(r, 50));
  f.controller.cancel(stopped.chat.id);
  await assert.rejects(pending, /stopped/);
  await f.close();
});
