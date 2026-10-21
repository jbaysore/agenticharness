// Refresh and streaming checks with isolated history and no provider calls.
import { chromium, expect, devices } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";

await mkdir(".local", { recursive: true });
const dataDir = await mkdtemp(resolve(".local/scroll-acceptance-"));
const app = await createHarness({ dataDir, port: 0, startProviders: false });
let browser;
const errors = [];
try {
  const project = app.store.addProject("Scroll fixture", process.cwd());
  const chats = ["First scroll chat", "Second scroll chat"].map((title) => {
    const chat = app.store.createConversation({ projectId: project.id, title });
    for (let i = 0; i < 24; i++)
      app.store.addMessage({
        conversationId: chat.id,
        role: i % 2 ? "assistant" : "user",
        provider: "codex",
        model: "fixture",
        content:
          `Message ${i + 1}\n\n` +
          "A paragraph to read in this conversation.\n\n".repeat(5),
      });
    return chat;
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1000 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const messages = (target, title = chats[0].title) =>
    target.locator(`.chat-pane[aria-label="${title}"] .messages`);
  const top = (element) => element.evaluate((e) => Math.round(e.scrollTop));
  const scroll = (element, value) =>
    element.evaluate((e, y) => {
      e.scrollTop = y;
    }, value);
  const at = async (element, value) => {
    await expect.poll(() => top(element)).toBe(value);
  };
  const atBottom = async (element) => {
    await expect
      .poll(() =>
        element.evaluate((e) =>
          Math.round(e.scrollHeight - e.clientHeight - e.scrollTop),
        ),
      )
      .toBe(0);
  };
  await page.goto(
    `${app.runtime.origin}/?chat=${chats[0].id}#pair=${app.auth.pairing()}`,
  );
  await expect(messages(page).locator(".message")).toHaveCount(24);
  // Save even if a refresh arrives before the browser dispatches onscroll.
  await scroll(messages(page), 900);
  await page.reload();
  await at(messages(page), 900);
  await scroll(messages(page), 0);
  await page.reload();
  await at(messages(page), 0);
  await scroll(messages(page), 1e9);
  await page.reload();
  await atBottom(messages(page));

  // Different conversations and side-by-side panes retain separate positions.
  const sidebarChat = (title) =>
    page.locator(".sidebar").getByRole("button", { name: title, exact: true });
  await sidebarChat(chats[1].title).click();
  await at(messages(page, chats[1].title), 0);
  await scroll(messages(page, chats[1].title), 600);
  await sidebarChat(chats[0].title).click();
  await atBottom(messages(page));
  await sidebarChat(chats[1].title).click({ modifiers: ["Control"] });
  await expect(page.locator(".chat-pane")).toHaveCount(2);
  await at(messages(page, chats[1].title), 600);
  await scroll(messages(page), 450);
  await scroll(messages(page, chats[1].title), 1000);
  await page.reload();
  await at(messages(page), 450);
  await at(messages(page, chats[1].title), 1000);
  await page
    .locator(`.chat-pane[aria-label="${chats[1].title}"]`)
    .getByLabel("Close pane")
    .click();

  // An active reply must not replace a restored reading position with the end.
  const run = app.store.createRun({
    conversationId: chats[0].id,
    actionId: "scroll-fixture-active-turn",
    provider: "codex",
    model: "fixture",
    text: "Simulate a reply without contacting a provider.",
  });
  app.store.setRun(run.id, "running");
  const replyId = app.store.addMessage({
    conversationId: chats[0].id,
    runId: run.id,
    role: "assistant",
    provider: "codex",
    model: "fixture",
    content: "Streaming fixture.",
  });
  await page.reload();
  await expect(messages(page).locator(".working-indicator")).toBeVisible();
  await at(messages(page), 450);
  const stream = async (text) => {
    app.store.appendMessage(replyId, text);
    app.controller.event(chats[0].id, run.id, "text", {
      messageId: replyId,
      delta: text,
    });
    await expect(messages(page).locator(".message").last()).toContainText(
      text.trim(),
    );
  };
  await stream("\n\nNew text while reading earlier messages.");
  await at(messages(page), 450);
  await scroll(messages(page), 1e9);
  await page.reload();
  await atBottom(messages(page));
  await stream("\n\n" + "More streamed text.\n\n".repeat(30));
  await atBottom(messages(page));
  await scroll(messages(page), 0);
  await page.reload();
  await at(messages(page), 0);
  await stream("\n\nStay at the top when the reader chose it.");
  await at(messages(page), 0);

  const mobile = await browser.newContext({
    ...devices["iPhone 13"],
    defaultBrowserType: undefined,
  });
  const phone = await mobile.newPage();
  phone.on("pageerror", (error) => errors.push(error.message));
  await phone.goto(
    `${app.runtime.origin}/?chat=${chats[1].id}#pair=${app.auth.pairing()}`,
  );
  await expect(messages(phone, chats[1].title).locator(".message")).toHaveCount(
    24,
  );
  await scroll(messages(phone, chats[1].title), 700);
  await phone.reload();
  await at(messages(phone, chats[1].title), 700);

  // Corrupt or unavailable browser storage must leave chats usable.
  const corrupted = await context.newPage();
  corrupted.on("pageerror", (error) => errors.push(error.message));
  await corrupted.addInitScript(
    (id) =>
      sessionStorage.setItem("harness.chat-scroll.v1:" + id, "broken json"),
    chats[0].id,
  );
  await corrupted.goto(`${app.runtime.origin}/?chat=${chats[0].id}`);
  await atBottom(messages(corrupted));
  await corrupted.close();
  await page.addInitScript(() => {
    Storage.prototype.getItem = Storage.prototype.setItem = () => {
      throw new Error("Storage disabled");
    };
  });
  await page.reload();
  await expect(messages(page).locator(".working-indicator")).toBeVisible();
  await scroll(messages(page), 300);
  await at(messages(page), 300);
  await stream("\n\nScrolling still works without storage.");
  await at(messages(page), 300);
  expect(errors).toEqual([]);
  console.log(
    "Scroll checks passed: refresh at the middle/top/end, independent panes, active replies, mobile refresh, and unavailable storage.",
  );
} finally {
  await browser?.close();
  await app.close();
}
