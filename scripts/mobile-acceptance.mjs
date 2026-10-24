// Isolated phone UI checks: simulated providers, no inference or real history.
import { chromium, devices, expect } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";

await mkdir(".local/screenshots", { recursive: true });
const app = await createHarness({
  dataDir: await mkdtemp(resolve(".local/mobile-acceptance-")),
  port: 0,
  startProviders: false,
});
const project = app.store.addProject("Phone layout fixture", process.cwd());
const chat = app.store.createConversation({
  projectId: project.id,
  title: "A long conversation title that should fit on a small phone",
  provider: "codex",
  model: "fixture",
});
app.store.addMessage({
  conversationId: chat.id,
  role: "assistant",
  provider: "codex",
  content:
    "The conversation should stay readable while the controls remain reachable.\n\n" +
    "| Screen | Result |\n| --- | --- |\n| Conversation | Checked |\n\n" +
    '```js\nconst message = "A long line of code scrolls inside its own block without widening the phone page";\n```',
});
const plan = app.store.createConversation({
  projectId: project.id,
  title: "Review a plan on the phone",
  provider: "codex",
  model: "fixture",
});
const run = app.store.createRun({
  conversationId: plan.id,
  actionId: crypto.randomUUID(),
  provider: "codex",
  model: "fixture",
  text: "Plan the mobile changes",
});
app.store.addApproval(plan.id, run.id, "codex", {
  kind: "plan",
  title: "Review the proposed changes",
  plan: "Keep the conversation readable and make every action reachable.",
});
app.store.setRun(run.id, "waiting");
app.controller.providers = ["codex", "claude", "cursor"].map((id, i) => ({
  id,
  name: ["Codex", "Claude Code", "Cursor"][i],
  connected: true,
  route: "Native subscription",
  plan: "Included usage",
  models: [
    { id: "fixture", name: "A model with a long display name", efforts: [] },
  ],
  usage:
    id === "cursor"
      ? null
      : {
          authoritative: true,
          windows: [
            { label: "Session", windowMinutes: 300, usedPercent: 38 },
            { label: "Weekly", windowMinutes: 10080, usedPercent: 22 },
          ],
        },
}));
let sent = 0;
app.controller.runners.codex = async (ctx) => {
  sent++;
  ctx.emit("text", { nativeId: "reply", text: "Received the phone message." });
  return { status: "completed" };
};
const errors = [];
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    defaultBrowserType: undefined,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async (id = chat.id) => {
    await page.goto(
      `${app.runtime.origin}/?chat=${id}#pair=${app.auth.pairing()}`,
    );
    await expect(page.locator(".chat-pane")).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
  };
  const fits = async (selector) => {
    const dimensions = await page.locator(selector).evaluate((element) => ({
      width: element.clientWidth,
      content: element.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(page.viewportSize().width);
  };
  const screenshot = async (name) => {
    await page.screenshot({ path: `.local/screenshots/mobile-${name}.png` });
  };
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 360, height: 740 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await open();
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.getByLabel("Add a pane beside")).toHaveCount(0);
    await fits(".topbar");
    await fits(".composer-controls");
    await fits(".composer-footer");
    const composer = await page.locator(".composer-area").boundingBox();
    expect(composer.y + composer.height).toBeLessThanOrEqual(
      viewport.height + 1,
    );
    const chips = await page
      .locator(".usage-chip")
      .evaluateAll((elements) =>
        elements.map((element) =>
          Math.round(element.getBoundingClientRect().top),
        ),
      );
    expect(new Set(chips).size).toBe(1);
    await screenshot(`chat-${viewport.width}`);
    await page.locator(".model-trigger").click();
    const menu = await page.locator(".model-popup").boundingBox();
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width);
    expect(menu.y).toBeGreaterThanOrEqual(0);
    expect(menu.y + menu.height).toBeLessThanOrEqual(viewport.height);
    await screenshot(`models-${viewport.width}`);
    await page.locator('.model-popup [role^="menuitem"]').first().click();
    await fits(".model-popup");
    await screenshot(`model-list-${viewport.width}`);
    await page.keyboard.press("Escape");
    await page.locator(".usage-glance-trigger").click();
    await fits(".usage-popover");
    await screenshot(`usage-${viewport.width}`);
    await page.getByRole("button", { name: /Connections & usage/ }).click();
    await fits(".modal");
    await screenshot(`connections-${viewport.width}`);
    await page.getByLabel("Close dialog").click();
    await page.getByLabel("Show sidebar", { exact: true }).click();
    await screenshot(`sidebar-${viewport.width}`);
    for (const name of ["Agent rules", "Skills", "Search conversations"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await fits(".modal");
      await screenshot(
        `${name === "Skills" ? "skills" : name === "Agent rules" ? "rules" : "search"}-${viewport.width}`,
      );
      await page.locator(".modal").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await fits(".modal");
      // Return to the header before closing a long, scrollable dialog.
      await page.locator(".modal").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.getByLabel("Close dialog").click();
    }
    await page.locator("button.new-chat").click();
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.locator(".chat-pane")).toHaveCount(1);
    await fits(".composer-footer");
    await fits(".messages");
    for (const card of await page.locator(".provider-card").all()) {
      expect(
        await card.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
    }
    await screenshot(`welcome-${viewport.width}`);
    await page.getByLabel("Toggle work panel").click();
    await fits(".work-panel");
    await screenshot(`work-${viewport.width}`);
    await page.getByLabel("Close work panel").click();
    await open(plan.id);
    await fits(".messages");
    await fits(".approval-buttons");
    await screenshot(`plan-${viewport.width}`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  const input = page.getByLabel("Message your coding agent");
  await input.fill("First line");
  await input.press("End");
  await input.press("Enter");
  await input.pressSequentially("Second line");
  await expect(input).toHaveValue("First line\nSecond line");
  expect(sent).toBe(0);
  expect(
    (await page.getByLabel("Send message").boundingBox()).height,
  ).toBeGreaterThanOrEqual(44);
  await page.getByLabel("Send message").click();
  await expect.poll(() => sent).toBe(1);
  await expect(input).toHaveValue("");

  // Model a keyboard that shrinks/pans visualViewport while innerHeight stays
  // unchanged, as on iOS. Device emulation alone does not open a real keyboard.
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 430 },
      offsetTop: { configurable: true, value: 24 },
    });
    window.visualViewport.dispatchEvent(new Event("resize"));
    window.visualViewport.dispatchEvent(new Event("scroll"));
  });
  const visibleBounds = async (selector) => {
    const box = await page.locator(selector).boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(24);
    expect(box.y + box.height).toBeLessThanOrEqual(455);
  };
  await visibleBounds(".workspace");
  await visibleBounds(".composer-area");
  await screenshot("keyboard");
  await page.getByLabel("Toggle work panel").click();
  await visibleBounds(".work-panel");
  await page.getByLabel("Close work panel").click();
  await page.getByLabel("Show sidebar", { exact: true }).click();
  await visibleBounds(".sidebar");
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await visibleBounds(".modal");
  await screenshot("keyboard-dialog");
  expect(errors).toEqual([]);
  console.log(
    "Mobile checks passed: single-chat portrait/landscape layouts at 320–844px, menus, settings, approvals, touch targets, Return/newline, explicit sending, and simulated keyboard bounds. No page errors.",
  );
} finally {
  await browser?.close();
  await app.close();
}
