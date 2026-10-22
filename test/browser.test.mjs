import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import {
  Browser,
  browserTitle,
  capBrowserResult,
  validateToolInput,
} from "../src/core/browser.mjs";

// A stand-in Playwright MCP server: three tools, one of them withheld by Harness.
const fakeServer = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const say = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") say({ id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake" } } });
  else if (m.method === "tools/list") say({ id: m.id, result: { tools: [
    { name: "browser_snapshot", description: "Read the page", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
    { name: "browser_navigate", description: "Go to a URL", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    { name: "browser_run_code_unsafe", description: "Run code", inputSchema: { type: "object", properties: {} } },
  ] } });
  else if (m.method === "tools/call") setTimeout(() => say({ id: m.id, result: { content: [{ type: "text", text: m.params.name + " " + JSON.stringify(m.params.arguments) }] } }), m.params.arguments.delay ?? 0);
});`;

test("the browser lists Playwright's tools without the host-code one, and runs calls one at a time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-browser-")),
    browser = new Browser(dir, { args: ["-e", fakeServer] });
  try {
    const tools = await browser.tools();
    assert.deepEqual(
      tools.map((t) => [t.name, t.readOnly]),
      [
        ["browser_snapshot", true],
        ["browser_navigate", false],
      ],
    );
    assert.equal(await browser.needsApproval("browser_snapshot"), false);
    assert.equal(await browser.needsApproval("browser_navigate"), true);
    await assert.rejects(browser.call("browser_run_code_unsafe", {}));
    const order = [];
    await Promise.all([
      browser
        .call("browser_navigate", { url: "a", delay: 50 })
        .then(() => order.push("slow")),
      browser.call("browser_snapshot", {}).then(() => order.push("fast")),
    ]);
    assert.deepEqual(order, ["slow", "fast"]);
  } finally {
    browser.close();
    // Windows can retain the child's working directory briefly after close.
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a page-changing browser action asks the user; reading the page does not", async () => {
  const store = new Store(":memory:"),
    calls = [],
    fake = {
      tools: async () => [
        {
          name: "browser_snapshot",
          description: "",
          inputSchema: {},
          readOnly: true,
        },
        {
          name: "browser_navigate",
          description: "",
          inputSchema: {},
          readOnly: false,
        },
      ],
      needsApproval: async (name) => name !== "browser_snapshot",
      call: async (name, input) => {
        calls.push([name, input]);
        return { content: [{ type: "text", text: "ok" }] };
      },
      close() {},
    },
    controller = new Controller(store, { browser: fake });
  controller.providers = [{ id: "codex", models: [{ id: "m", efforts: [] }] }];
  const answers = [false, true],
    approvals = [];
  controller.on("event", (e) => {
    if (e.type === "approval") {
      approvals.push(e.payload.request?.title ?? e.payload.title);
      controller.answer(e.payload.id, { allow: answers.shift() });
    }
  });
  let offered, results;
  controller.runners.codex = async (ctx) => {
    offered = ctx.tools.filter((t) => t.name === "browser");
    results = [
      await ctx.browser("browser_snapshot", {}),
      await ctx.browser("browser_navigate", '{"url":"https://example.com"}'),
      await ctx.browser("browser_navigate", { url: "https://example.com" }),
    ];
    return { status: "completed" };
  };
  const p = store.addProject("fixture", "C:\\fixture"),
    chat = store.createConversation({ projectId: p.id });
  controller.send(chat.id, {
    actionId: "browser-approval-check",
    text: "Open example.com",
    provider: "codex",
    model: "m",
  });
  await controller.active.get(chat.id).task;
  assert.deepEqual(
    offered.map((t) => Object.keys(t).sort()),
    [["description", "inputSchema", "name"]],
  );
  assert.deepEqual(offered[0].inputSchema.properties.action.enum, [
    "browser_snapshot",
    "browser_navigate",
  ]);
  assert.equal(approvals.length, 2);
  assert.match(
    String(approvals[0]),
    /Browser: navigate · https:\/\/example\.com/,
  );
  assert.equal(results[1].isError, true);
  assert.deepEqual(calls, [
    ["browser_snapshot", {}],
    ["browser_navigate", { url: "https://example.com" }],
  ]);
  store.close();
});

test("browser arguments are checked and long page text is capped", () => {
  const schema = {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
    additionalProperties: false,
  };
  assert.equal(validateToolInput(schema, { url: "https://example.com" }), null);
  assert.match(validateToolInput(schema, {}), /Missing url/);
  assert.match(
    validateToolInput(schema, { url: "https://example.com", extra: 1 }),
    /Unexpected extra/,
  );
  const capped = capBrowserResult({
    content: [{ type: "text", text: "x".repeat(13000) }],
  });
  assert.ok(capped.content[0].text.length < 13000);
  assert.match(capped.content[0].text, /page is still open/);
});

test("approval titles name the action and its target", () => {
  assert.equal(
    browserTitle("browser_click", { element: "Sign in button", target: "e12" }),
    "Browser: click · Sign in button",
  );
  assert.equal(browserTitle("browser_navigate_back"), "Browser: navigate back");
});
