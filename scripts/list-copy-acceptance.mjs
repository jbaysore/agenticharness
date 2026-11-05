// Copies of rendered lists keep their numbers and bullets in plain text.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";

const content = [
  "Before the lists.",
  "",
  "1. First ordered",
  "2. Second ordered",
  "",
  "- Bullet one",
  "- Bullet two",
  "",
  "1. Parent",
  "   - Nested child",
  "   - Nested sibling",
  "",
  "- [ ] Open task",
  "- [x] Done task",
  "",
  "3. Third ordered",
  "4. Fourth ordered",
  "",
  '<ol><li value="9">Jumped</li><li>Next</li></ol>',
  "",
  "1. Loose alpha",
  "",
  "2. Loose beta",
  "",
  "After the lists.",
].join("\n");

const expected = [
  "Before the lists.",
  "",
  "1. First ordered",
  "2. Second ordered",
  "",
  "- Bullet one",
  "- Bullet two",
  "",
  "1. Parent",
  "  - Nested child",
  "  - Nested sibling",
  "",
  "- [ ] Open task",
  "- [x] Done task",
  "",
  "3. Third ordered",
  "4. Fourth ordered",
  "",
  "9. Jumped",
  "10. Next",
  "",
  "1. Loose alpha",
  "",
  "2. Loose beta",
  "",
  "After the lists.",
].join("\n");

await mkdir(".local", { recursive: true });
const dataDir = await mkdtemp(resolve(".local/list-copy-acceptance-"));
const app = await createHarness({ dataDir, port: 0, startProviders: false });
let browser;
const errors = [];
try {
  const project = app.store.addProject("List copy fixture", process.cwd());
  const chat = app.store.createConversation({
    projectId: project.id,
    title: "List copy",
    provider: "codex",
    model: "fixture",
  });
  const run = app.store.createRun({
    conversationId: chat.id,
    actionId: "list-copy-steps",
    provider: "codex",
    model: "fixture",
    text: "Seed the list fixture.",
  });
  app.store.appendEvent(chat.id, run.id, "work", {
    kind: "host-command",
    id: "copy-step",
    command: "echo marker-free",
    status: "ok",
    ms: 10,
  });
  app.store.addMessage({
    conversationId: chat.id,
    runId: run.id,
    role: "assistant",
    provider: "codex",
    model: "fixture",
    content,
  });
  app.store.setRun(run.id, "completed");

  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const plain = (value) => value.replaceAll("\r\n", "\n").replace(/\n+$/, "");
  const readClipboard = () =>
    page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const out = {};
      for (const item of items)
        for (const type of item.types)
          out[type] = await (await item.getType(type)).text();
      return out;
    });
  const copySelection = async () => {
    await page.evaluate(() => document.execCommand("copy"));
    return readClipboard();
  };

  await page.goto(
    `${app.runtime.origin}/?chat=${chat.id}#pair=${app.auth.pairing()}`,
  );
  const markdown = page.locator(".message.assistant .markdown");
  await expect(markdown).toContainText("Loose beta");
  await markdown.selectText();
  const whole = await copySelection();
  expect(plain(whole["text/plain"])).toBe(expected);
  expect(whole["text/html"]).toContain("<ol");
  expect(whole["text/html"]).toContain("<ul");
  expect(whole["text/html"]).toContain("<li");

  await page.evaluate(() => {
    const root = document.querySelector(".message.assistant .markdown");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let first, second, node;
    while ((node = walker.nextNode())) {
      if (!first && node.data.includes("First ordered")) first = node;
      if (!second && node.data.includes("Second ordered")) second = node;
    }
    const range = document.createRange();
    range.setStart(first, first.data.indexOf("ordered"));
    range.setEnd(second, second.data.length);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const partial = plain((await copySelection())["text/plain"]);
  expect(partial.startsWith("1.")).toBe(false);
  expect(partial).not.toContain("1. First");
  expect(partial).toContain("2. Second ordered");

  await page.evaluate(() => {
    const root = document.querySelector(".message.assistant .markdown");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.data.indexOf("Before the lists.");
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + "Before the lists.".length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error("missing paragraph");
  });
  const paragraph = plain((await copySelection())["text/plain"]);
  expect(paragraph).toBe("Before the lists.");

  const field = page.getByLabel("Message your coding agent");
  await field.fill("1. keep this line");
  await field.evaluate((element) => element.select());
  const typed = plain((await copySelection())["text/plain"]);
  expect(typed).toBe("1. keep this line");

  await page.locator(".steps-line").click();
  const steps = page.locator(".steps-list");
  await expect(steps).toBeVisible();
  await steps.selectText();
  const stepsText = plain((await copySelection())["text/plain"]);
  expect(stepsText).toContain("echo marker-free");
  expect(stepsText).not.toMatch(/(^|\n)\s*\d+\. /);
  expect(stepsText).not.toMatch(/(^|\n)\s*- /);

  expect(errors).toEqual([]);
  console.log(
    "List copy checks passed: whole lists, partial items, paragraphs, the composer, and marker-free steps.",
  );
} finally {
  await browser?.close();
  await app.close();
}
