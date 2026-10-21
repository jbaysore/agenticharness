// Screenshots of the main screens against seeded chats, for reviewing the look.
// Isolated like the acceptance checks: no provider calls or changes to real history.
import { chromium, devices } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";

const out = ".local/screenshots";
await mkdir(out, { recursive: true });
const dataDir = await mkdtemp(resolve(".local/design-preview-"));
const app = await createHarness({ dataDir, port: 0, startProviders: false });
const { store } = app;
let browser;
try {
  const project = store.addProject("Agentic Harness", process.cwd());
  const codexCommand = (id, type, command, durationMs, action = {}) => ({
    kind: "tool",
    provider: "codex",
    method: "item/completed",
    item: { type: "commandExecution", id, command, commandActions: [{ type, command, ...action }], status: "completed", exitCode: 0, durationMs },
  });
  const claudeTool = (id, name, input) => ({ kind: "tool", provider: "claude", item: { type: "tool_use", id, name, input } });
  const claudeDone = (id) => ({ kind: "tool-result", provider: "claude", toolUseId: id, item: {} });
  const turn = (chat, provider, model, text, replies, status = "completed", work = []) => {
    const run = store.createRun({
      conversationId: chat.id,
      actionId: crypto.randomUUID(),
      provider,
      model,
      text,
    });
    for (const payload of work) store.appendEvent(chat.id, run.id, "work", payload);
    for (const content of replies)
      store.addMessage({
        conversationId: chat.id,
        runId: run.id,
        role: "assistant",
        provider,
        model,
        content,
      });
    store.setRun(run.id, status);
    return run;
  };

  const codex = store.createConversation({
    projectId: project.id,
    title: "Remove the permissions label",
    provider: "codex",
  });
  turn(codex, "codex", "gpt-6.1-sol", "Please remove the \"permissions\" text, and just keep the actual permission dropdown", [
    "I'll find the permission dropdown, remove its text label, and check the layout before committing and pushing the change.",
    "I found the label beside the dropdown in the chat composer. I'll remove that visible text and keep the dropdown's accessible name.",
    "Removed the \"Permissions\" text, keeping the dropdown and its accessible label. Build and layout checks passed. Committed and pushed to `main`: `03c011e`.",
  ], "completed", [
    codexCommand("1", "read", "Get-Content src/ui/chat-pane.jsx", 38, { name: "chat-pane.jsx" }),
    codexCommand("2", "search", "rg \"Permissions\" src/ui", 52, { query: "Permissions" }),
    { kind: "tool", provider: "codex", method: "item/completed", item: { type: "fileChange", id: "3", status: "completed", changes: [{ path: "src/ui/chat-pane.jsx", diff: "@@\n-          Permissions\n-          <select\n+          <select\n-        </label>\n+        </label>" }] } },
    codexCommand("4", "unknown", "npm run build", 4100),
    codexCommand("5", "unknown", "npm run test:layout", 21900),
    codexCommand("6", "unknown", "git commit -m \"Remove visible permissions dropdown label\"", 310),
  ]);
  turn(codex, "codex", "gpt-6.1-sol", "How does the outbox keep a message from being sent twice?", [
    [
      "Every send carries an **action ID** that the host remembers. The flow has three parts:",
      "",
      "1. The browser saves the draft and its action ID in session storage before posting.",
      "2. The host refuses a second run for the same action ID and returns the first one instead.",
      "3. After a reload, the pane asks the host about the pending action before restoring the draft.",
      "",
      "```js",
      "const prior = readPending(c.id);",
      "const body = prior && prior.text === text ? prior : { actionId: crypto.randomUUID(), text };",
      "savePending(c.id, body);",
      "```",
      "",
      "| State | What the pane shows |",
      "| --- | --- |",
      "| Host has the run | The accepted turn |",
      "| Host never saw it | The restored draft |",
      "",
      "> Sending again after a restore reuses the same action ID, so it can never run twice.",
    ].join("\n"),
  ]);

  const claude = store.createConversation({
    projectId: project.id,
    title: "Fix scroll restore after refresh",
    provider: "claude",
  });
  const waiting = turn(claude, "claude", "claude-opus-5-5", "Scroll position is lost when I refresh with two panes open. Fix it and push.", [
    "The saved offset is keyed by chat, but both panes write it on unmount, so the second pane overwrites the first. I've keyed it by pane and chat, and the scroll check passes. Ready to push.",
  ], "waiting", [
    claudeTool("a", "Read", { file_path: "src/ui/chat-scroll.jsx" }),
    claudeDone("a"),
    claudeTool("b", "Edit", { file_path: "src/ui/chat-scroll.jsx", old_string: "const storageKey = (id) => id;", new_string: "const storageKey = (pane, id) =>\n  pane + \":\" + id;" }),
    claudeDone("b"),
    claudeTool("c", "Bash", { command: "npm run test:scroll", description: "Run the scroll checks" }),
    claudeDone("c"),
    claudeTool("d", "Bash", { command: "git push origin main", description: "Push to main" }),
  ]);
  store.addApproval(claude.id, waiting.id, "claude", {
    kind: "permission",
    title: "Run git push origin main",
    details: { command: "git push origin main", cwd: process.cwd() },
  });

  const cursor = store.createConversation({
    projectId: project.id,
    title: "Tidy the model picker",
    provider: "cursor",
  });
  turn(cursor, "cursor", "standard", [
    "The model picker has grown a few rough edges. Please go through it and:",
    "- keep the provider, model and effort in one menu",
    "- show unavailable models greyed out with the reason",
    "- make the keyboard behaviour match the sidebar menus",
    "- keep the summary format the acceptance tests expect",
    "- don't change how the selection is saved",
    "- check it at phone width",
    "Commit when the model-picker checks pass.",
  ].join("\n"), ["I'll start with the keyboard handling, since the other changes build on it."], "failed", [
    { kind: "tool_call", provider: "cursor", item: { sessionUpdate: "tool_call", toolCallId: "r", title: "Read model-picker.jsx", kind: "read", status: "completed", locations: [{ path: "src/ui/model-picker.jsx" }] } },
    { kind: "tool_call", provider: "cursor", item: { sessionUpdate: "tool_call", toolCallId: "t", title: "`npm run test:models`", kind: "execute", status: "failed", rawInput: { command: "npm run test:models" } } },
  ]);
  store.setRun(store.db.prepare("SELECT id FROM runs WHERE conversation_id=?").get(cursor.id).id, "failed", null, "Cursor stopped responding after 10 minutes.");

  const model = (id, name, efforts = []) => ({ id, name, efforts });
  app.controller.providers = [
    ["codex", "Codex", model("gpt-6.1-sol", "GPT-6.1-Sol", ["medium", "high", "xhigh"])],
    ["claude", "Claude Code", model("claude-opus-5-5", "Opus 5.5", ["high"])],
    ["cursor", "Cursor", model("standard", "Standard preset")],
  ].map(([id, name, m]) => ({ id, name, connected: true, models: [m] }));

  browser = await chromium.launch({ channel: "msedge", headless: true });
  const shoot = async (name, url, options, before) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.goto(`${app.runtime.origin}${url}#pair=${app.auth.pairing()}`);
    await page.waitForSelector(".chat-pane");
    await page.evaluate(() => document.fonts.ready);
    await before?.(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/design-${name}.png` });
    await context.close();
    console.log(`${out}/design-${name}.png`);
  };
  await shoot("conversation", `/?chat=${codex.id}`, { viewport: { width: 1440, height: 900 } }, async (page) => {
    await page.locator(".messages").evaluate((e) => (e.scrollTop = 0));
    await page.locator(".steps-line").first().click();
  });
  await shoot("three-panes", `/?chat=${codex.id},${claude.id},${cursor.id}`, { viewport: { width: 1920, height: 1000 } });
  await shoot("welcome", "/", { viewport: { width: 1536, height: 730 } });
  await shoot("phone", `/?chat=${claude.id}`, { ...devices["iPhone 13"], defaultBrowserType: undefined });
} finally {
  await browser?.close();
  await app.close();
}
