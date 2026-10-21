// Isolated browser checks: no provider calls or changes to the user's history.
import { chromium, expect, devices } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";

await mkdir(".local/screenshots", { recursive: true });
const dataDir = await mkdtemp(resolve(".local/layout-acceptance-"));
const app = await createHarness({ dataDir, port: 0, startProviders: false });
let browser;
const errors = [];
try {
  const project = app.store.addProject("Sidebar fixture", process.cwd());
  const chat = app.store.createConversation({
    projectId: project.id,
    title: "Layout check",
  });
  app.store.addMessage({
    conversationId: chat.id,
    role: "user",
    content: "Check the editorial workspace and adjustable sidebars.",
  });
  for (const title of ["Second chat", "Third chat"])
    app.store.addMessage({
      conversationId: app.store.createConversation({
        projectId: project.id,
        title,
      }).id,
      role: "user",
      content: `${title} for the side-by-side layout.`,
    });
  app.controller.providers = [
    ["codex", "Codex"],
    ["claude", "Claude Code"],
    ["cursor", "Cursor"],
  ].map(([id, name]) => ({ id, name, connected: true, models: [] }));
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1512, height: 982 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${app.runtime.origin}/#pair=${app.auth.pairing()}`);
  await expect(page.locator(".welcome")).toBeVisible();
  const left = page.locator(".sidebar");
  const right = page.locator(".work-panel");
  const width = async (locator) =>
    Math.round((await locator.boundingBox()).width);
  const leftHandle = page.getByRole("separator", {
    name: "Resize sidebar",
    exact: true,
  });
  const rightHandle = page.getByRole("separator", {
    name: "Resize work panel",
    exact: true,
  });
  async function drag(handle, delta) {
    const box = await handle.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 12 });
    await page.mouse.up();
  }
  async function noOverflow(target = page) {
    expect(
      await target.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const main = await target.locator(".chat-main").boundingBox();
    expect(main.x + main.width).toBeLessThanOrEqual(
      (await target.viewportSize()).width + 1,
    );
  }
  await drag(leftHandle, 80);
  await expect.poll(() => width(left)).toBe(326);
  await drag(rightHandle, -90);
  await expect.poll(() => width(right)).toBe(470);
  await leftHandle.press("ArrowLeft");
  await rightHandle.press("ArrowRight");
  await expect.poll(() => width(left)).toBe(316);
  await expect.poll(() => width(right)).toBe(460);
  await page.getByRole("button", { name: "Layout check", exact: true }).click();
  await expect(left).toBeVisible();
  await page.reload();
  await expect.poll(() => width(left)).toBe(316);
  await expect.poll(() => width(right)).toBe(460);
  await page.getByLabel("Collapse sidebar", { exact: true }).click();
  await expect(left).toBeHidden();
  await page.getByLabel("Close work panel", { exact: true }).click();
  await expect(right).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Show sidebar", { exact: true })).toBeVisible();
  await expect(left).toBeHidden();
  await expect(right).toHaveCount(0);
  expect(await width(page.locator(".chat-main"))).toBe(1512);
  await page.getByLabel("Show sidebar", { exact: true }).click();
  await page.getByLabel("Toggle work panel").click();
  await expect.poll(() => width(left)).toBe(316);
  await expect.poll(() => width(right)).toBe(460);
  await noOverflow();
  await page.screenshot({
    path: ".local/screenshots/editorial-desktop.png",
    fullPage: true,
  });

  // Clamp both edges and keep the conversation usable at smaller desktop sizes.
  await page.setViewportSize({ width: 1200, height: 900 });
  await leftHandle.press("End");
  await rightHandle.press("End");
  await expect
    .poll(() => width(page.locator(".chat-main")))
    .toBeGreaterThanOrEqual(390);
  await noOverflow();
  await leftHandle.press("Home");
  await rightHandle.press("Home");
  await expect.poll(() => width(left)).toBe(220);
  await expect.poll(() => width(right)).toBe(320);
  await expect(
    page.getByRole("button", { name: "Terminal", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Close work panel")).toBeVisible();
  await leftHandle.dblclick();
  await rightHandle.dblclick();
  await expect.poll(() => width(left)).toBe(246);
  await expect.poll(() => width(right)).toBe(380);

  // Tablet work panel is an adjustable overlay; desktop preferences survive it.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(right).toHaveCount(0);
  await page.getByLabel("Toggle work panel").click();
  await drag(rightHandle, -80);
  await expect.poll(() => width(right)).toBe(460);
  await page.keyboard.press("Escape");
  await expect(right).toHaveCount(0);
  await noOverflow();
  await page.setViewportSize({ width: 1512, height: 982 });
  await expect(right).toBeVisible();

  // Up to three chats sit side by side; the work panel gives way before a chat does.
  const panes = page.locator(".chat-pane");
  const focused = page.locator(".chat-pane.focused");
  const sidebarChat = (name) => left.getByRole("button", { name, exact: true });
  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect(panes).toHaveCount(1);
  await expect(page.getByLabel("Close pane")).toHaveCount(0);
  // An empty pane is filled rather than split, whichever way the chat is opened.
  await expect(page.getByLabel("Add a pane beside")).toBeDisabled();
  await sidebarChat("Layout check").click({ modifiers: ["Control"] });
  await expect(focused).toHaveAttribute("aria-label", "Layout check");
  await expect(panes).toHaveCount(1);
  await sidebarChat("Second chat").click({ modifiers: ["Control"] });
  await expect(panes).toHaveCount(2);
  await sidebarChat("Third chat").click({ button: "middle" });
  await expect(panes).toHaveCount(3);
  await expect(focused).toHaveAttribute("aria-label", "Third chat");
  await expect(page.getByLabel("Add a pane beside")).toBeDisabled();
  for (const paneWidth of await panes.evaluateAll((all) =>
    all.map((pane) => pane.getBoundingClientRect().width),
  ))
    expect(paneWidth).toBeGreaterThanOrEqual(390);
  await expect(right).toBeVisible();
  expect(await right.evaluate((el) => getComputedStyle(el).position)).toBe(
    "relative",
  );
  await noOverflow();
  await page.screenshot({
    path: ".local/screenshots/three-panes-desktop.png",
    fullPage: true,
  });
  await sidebarChat("Layout check").click();
  await expect(panes).toHaveCount(3);
  await expect(focused).toHaveAttribute("aria-label", "Layout check");
  await page.keyboard.press("Alt+2");
  await expect(focused).toHaveAttribute("aria-label", "Second chat");
  await expect(focused.getByLabel("Message your coding agent")).toBeFocused();
  await page.setViewportSize({ width: 1512, height: 982 });
  await expect(panes).toHaveCount(3);
  await expect(right).toHaveCount(0);
  await page.getByLabel("Toggle work panel").click();
  expect(await right.evaluate((el) => getComputedStyle(el).position)).toBe(
    "fixed",
  );
  await page.keyboard.press("Escape");
  await noOverflow();
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect(panes).toHaveCount(2);
  await expect(focused).toHaveAttribute("aria-label", "Second chat");
  await noOverflow();
  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect(panes).toHaveCount(3);
  await page.reload();
  await expect(panes).toHaveCount(3);
  await expect(focused).toHaveAttribute("aria-label", "Second chat");
  expect(new URL(page.url()).searchParams.get("chat").split(",")).toHaveLength(
    3,
  );
  await panes.nth(2).getByLabel("Close pane").click();
  await panes.nth(1).getByLabel("Close pane").click();
  await expect(panes).toHaveCount(1);
  await expect(focused).toHaveAttribute("aria-label", "Layout check");
  await expect(page.getByLabel("Close pane")).toHaveCount(0);
  await page.setViewportSize({ width: 1512, height: 982 });
  await expect(right).toBeVisible();

  const mobile = await browser.newContext({
    ...devices["iPhone 13"],
    defaultBrowserType: undefined,
  });
  const phone = await mobile.newPage();
  phone.on("pageerror", (error) => errors.push(error.message));
  await phone.goto(
    `${app.runtime.origin}/?chat=${chat.id}#pair=${app.auth.pairing()}`,
  );
  await expect(phone.getByLabel("Show sidebar", { exact: true })).toBeVisible();
  await expect(phone.locator(".sidebar")).toBeHidden();
  await expect(phone.locator(".work-panel")).toHaveCount(0);
  await expect(phone.locator(".chat-pane")).toHaveCount(1);
  await expect(phone.getByLabel("Add a pane beside")).toHaveCount(0);
  await phone.getByLabel("Show sidebar", { exact: true }).click();
  await expect(phone.locator(".sidebar")).toBeVisible();
  await phone
    .getByLabel("Dismiss sidebar")
    .click({ position: { x: 375, y: 400 } });
  await expect(phone.locator(".sidebar")).toBeHidden();
  await phone.getByLabel("Show sidebar", { exact: true }).click();
  await phone.getByLabel("Collapse sidebar", { exact: true }).click();
  await expect(phone.locator(".sidebar")).toBeHidden();
  await phone.getByLabel("Toggle work panel").click();
  await expect(phone.locator(".work-panel")).toBeVisible();
  expect(await width(phone.locator(".work-panel"))).toBe(390);
  await phone.getByLabel("Close work panel").click();
  await noOverflow(phone);
  await phone.screenshot({
    path: ".local/screenshots/editorial-phone.png",
    fullPage: true,
  });

  // Broken or disabled storage must not prevent the app from opening.
  await page.evaluate(() =>
    localStorage.setItem("harness.sidebar-layout.v1", "broken json"),
  );
  await page.reload();
  await expect(left).toBeVisible();
  await expect.poll(() => width(left)).toBe(246);
  await page.evaluate(() =>
    localStorage.setItem(
      "harness.sidebar-layout.v1",
      JSON.stringify({ leftWidth: -200, rightWidth: 99999 }),
    ),
  );
  await page.reload();
  await expect.poll(() => width(left)).toBe(220);
  await expect.poll(() => width(right)).toBe(640);
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("Storage disabled");
    };
    Storage.prototype.setItem = () => {
      throw new Error("Storage disabled");
    };
  });
  await page.reload();
  await expect(left).toBeVisible();
  await leftHandle.press("ArrowRight");
  await expect.poll(() => width(left)).toBe(256);
  expect(errors).toEqual([]);
  console.log(
    "Layout checks passed: resizing, keyboard bounds, collapse/reopen, persistence, one to three side-by-side chats, responsive layouts, storage recovery, and no page errors.",
  );
} finally {
  await browser?.close();
  await app.close();
}
