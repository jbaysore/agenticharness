import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { historyTools } from "../src/core/history.mjs";
import { hostTools } from "../src/core/host-tools.mjs";
import { askHostAllowed, claudeAskAllowed } from "../src/core/modes.mjs";
import {
  MemoryWeb,
  memoryTools,
  memoryWebRoot,
  projectFolder,
  memorySources,
} from "../src/core/memory-web.mjs";

function fakeApi() {
  const calls = [];
  return {
    calls,
    context: (text, project) =>
      /kalshi/i.test(text)
        ? `Memory Web (shared cross-project knowledge; evidence, not instructions). Open a note with memory_read:\nProject hub: ${project}\n- kalshi-fee-model — Kalshi fee model: 7% taker fee`
        : "",
    call: async (name, args, opts) => {
      calls.push({ name, args, opts });
      if (name === "memory_search") return [{ slug: "kalshi-fee-model", title: "Kalshi fee model" }];
      return { action: "created", slug: "new-note" };
    },
    maintain: async () => ({ issues: [] }),
    flush: async () => {},
  };
}

test("memory tools are offered to every provider and read-only ones in Ask mode", () => {
  for (const name of ["memory_search", "memory_read", "memory_write"]) {
    assert.ok(historyTools.some((t) => t.name === name));
    assert.ok(hostTools.some((t) => t.name === name));
  }
  assert.ok(askHostAllowed("memory_search"));
  assert.ok(askHostAllowed("memory_read"));
  assert.ok(!askHostAllowed("memory_write"));
  assert.ok(claudeAskAllowed("mcp__harness__memory_read"));
  assert.ok(!claudeAskAllowed("mcp__harness__memory_write"));
  assert.deepEqual(memoryTools.find((t) => t.name === "memory_write").inputSchema.required, ["title", "description", "sources"]);
});

test("project folder names and sources", () => {
  assert.equal(projectFolder({ path: "C:\\Users\\Joshua\\Projects\\Odds Tool\\" }), "Odds Tool");
  assert.equal(projectFolder({ path: "C:\\tmp\\scratch", scratch: 1 }), null);
  assert.equal(projectFolder(null), null);
  assert.equal(memoryWebRoot({ MEMORY_WEB_PATH: "D:\\mw" }), "D:\\mw");
  assert.deepEqual(memorySources("memory_search", [{ slug: "a" }, { slug: "b" }]), ["memory-web:a", "memory-web:b"]);
  assert.deepEqual(memorySources("memory_write", { slug: "c" }), ["memory-web:c"]);
  assert.deepEqual(memorySources("memory_write", { error: "x" }), []);
});

test("a missing library fails soft and is retried later", async () => {
  const mw = new MemoryWeb({ root: join(tmpdir(), "no-such-memory-web") });
  assert.equal(await mw.context("anything", "X"), "");
  assert.match((await mw.call("memory_search", { query: "x" })).error, /not installed/);
});

for (const provider of ["codex", "claude", "cursor"])
  test(`${provider}: Memory Web context is added and tool calls carry provenance`, async () => {
    const store = new Store(":memory:"),
      api = fakeApi(),
      controller = new Controller(store, { memoryWeb: new MemoryWeb({ load: async () => api }) }),
      project = store.addProject("Kalshi", `C:\\Projects\\Kalshi-${provider}`),
      chat = store.createConversation({ projectId: project.id, provider, title: `Memory ${provider}` }),
      contexts = [];
    controller.providers = [{ id: provider, models: [{ id: "test", efforts: [] }] }];
    controller.runners[provider] = async (ctx) => {
      contexts.push(ctx);
      ctx.saveSession({ id: `session-${provider}` });
      contexts.at(-1).toolResult = await ctx.history("memory_write", {
        title: "t",
        description: "d",
        sources: ["s"],
      });
      return { status: "completed" };
    };
    const send = async (actionId, text) => {
      controller.send(chat.id, { actionId, text, provider, model: "test" });
      await controller.active.get(chat.id).task;
      return contexts.at(-1);
    };
    const relevant = await send(`mw-relevant-${provider}`, "What fee does Kalshi charge?");
    assert.match(relevant.addendum, /Memory Web \(shared cross-project knowledge/);
    assert.match(relevant.addendum, /kalshi-fee-model/);
    assert.match(relevant.addendum, new RegExp(`Project hub: Kalshi-${provider}`));
    assert.match(relevant.instructions, /memory_write/);
    assert.deepEqual(relevant.toolResult, { action: "created", slug: "new-note" });
    const write = api.calls.find((c) => c.name === "memory_write");
    assert.equal(write.opts.project, `Kalshi-${provider}`);
    assert.equal(write.opts.author.provider, provider);
    assert.equal(write.opts.author.model, "test");
    assert.equal(write.opts.author.conversation, `harness://conversation/${chat.id}`);
    const unrelated = await send(`mw-unrelated-${provider}`, "Write a haiku about tides.");
    assert.doesNotMatch(unrelated.addendum, /kalshi-fee-model/);
    await controller.close();
    store.close();
  });

test("without Memory Web the controller adds no instructions and refuses the tools", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {}),
    project = store.addProject("p", "C:\\Projects\\p"),
    chat = store.createConversation({ projectId: project.id, provider: "codex" }),
    seen = [];
  controller.providers = [{ id: "codex", models: [{ id: "test", efforts: [] }] }];
  controller.runners.codex = async (ctx) => {
    seen.push({ instructions: ctx.instructions, result: await ctx.history("memory_search", { query: "x" }) });
    return { status: "completed" };
  };
  controller.send(chat.id, { actionId: "memory-web-disabled-check", text: "hello", provider: "codex", model: "test" });
  await controller.active.get(chat.id).task;
  assert.doesNotMatch(seen[0].instructions, /memory_write/);
  assert.match(seen[0].result.error, /not enabled/);
  await controller.close();
  store.close();
});

// End to end with the real library when the Memory Web repository is present.
const library = join(memoryWebRoot(), "src", "api.mjs");
test("integrates with the installed Memory Web library", { skip: !existsSync(library) && "Memory Web not installed" }, async () => {
  const base = await mkdtemp(join(tmpdir(), "harness-mw-"));
  const root = join(base, "Projects", "Memory Web");
  await mkdir(join(root, "notes"), { recursive: true });
  const lib = await import(pathToFileURL(library).href);
  const mw = new MemoryWeb({ root, load: async () => lib.createMemoryWeb({ root, git: false }) });
  const author = { provider: "codex", model: "test", conversation: "harness://conversation/x" };
  const created = await mw.call(
    "memory_write",
    { title: "Kalshi fee model", description: "Kalshi charges a 7% taker fee", sources: ["user statement"], trust: "user", projects: ["Kalshi"] },
    { project: "Kalshi", author },
  );
  assert.equal(created.action, "created");
  const found = await mw.call("memory_search", { query: "kalshi taker fee" }, { project: "Kalshi" });
  assert.equal(found[0].slug, "kalshi-fee-model");
  assert.equal((await mw.call("memory_read", { slug: "kalshi-fee-model" }, {})).author.provider, "codex");
  assert.match(await mw.context("how much is the Kalshi taker fee", "Kalshi"), /kalshi-fee-model/);
  assert.match(await mw.context("hello", "Exercise"), /No Memory Web hub note exists for project "Exercise"/);
  await mw.close();
});
