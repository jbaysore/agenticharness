// Isolated browser checks with saved session fixtures; no provider calls.
import { chromium, expect, devices } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";

await mkdir(".local/screenshots", { recursive: true });
const app = await createHarness({
  dataDir: await mkdtemp(resolve(".local/history-settings-")),
  port: 0,
  startProviders: false,
});
const project = app.store.addProject("History fixture", process.cwd());
const existing = app.store.createConversation({
  projectId: project.id,
  title: "Existing conversation",
  scope: "project",
});
const sessions = { codex: { id: "keep-existing-session" } };
app.store.updateConversation(existing.id, { sessions });
app.store.createRun({
  conversationId: existing.id,
  actionId: "history-ui-active-fixture",
  provider: "codex",
  model: "fixture",
  text: "Continue the existing conversation",
});
const errors = [];
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const desktop = await browser.newContext({
    viewport: { width: 1512, height: 982 },
  });
  const page = await desktop.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const visit = async (target) => {
    await target.goto(`${app.runtime.origin}/?chat=${existing.id}`);
    await expect(target.locator(".context-trigger")).toBeVisible();
    await expect(target.locator(".history-scope")).toHaveCount(0);
    await expect(target.getByLabel("Shared history scope")).toHaveCount(0);
  };
  const settings = (target) =>
    target.getByLabel("History for new conversations");
  const openSettings = async (target) => {
    const sidebar = target.getByRole("button", {
      name: "Show sidebar",
      exact: true,
    });
    if (await sidebar.isVisible()) await sidebar.click();
    await target.getByRole("button", { name: "Connections & usage" }).click();
    await expect(settings(target)).toBeVisible();
  };
  const noOverflow = async (target) => {
    expect(
      await target.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  };
  await visit(page);
  await openSettings(page);
  await expect(settings(page)).toHaveValue("all");
  await expect(page.getByText(/Existing conversations keep/)).toBeVisible();

  // Another open browser receives the saved default without refreshing.
  const other = await desktop.newPage();
  other.on("pageerror", (error) => errors.push(error.message));
  await visit(other);
  await openSettings(other);
  await settings(page).selectOption("none");
  await expect(settings(page)).toBeEnabled();
  await expect(settings(other)).toHaveValue("none");
  expect(app.store.conversation(existing.id).scope).toBe("project");
  expect(app.store.conversation(existing.id).sessions).toEqual(sessions);
  expect(app.store.activeRun(existing.id)).toBeTruthy();
  await noOverflow(page);
  await page.screenshot({
    path: ".local/screenshots/history-settings-desktop.png",
  });
  await other.close();

  await page.reload();
  await openSettings(page);
  await expect(settings(page)).toHaveValue("none");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.locator(".new-chat").click();
  await expect(page.locator(".context-trigger")).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("chat"))
    .not.toBe(existing.id);
  expect(
    app.store.conversation(new URL(page.url()).searchParams.get("chat")).scope,
  ).toBe("none");

  const mobile = await browser.newContext({ ...devices["iPhone 13"] });
  const phone = await mobile.newPage();
  phone.on("pageerror", (error) => errors.push(error.message));
  await visit(phone);
  await openSettings(phone);
  await expect(settings(phone)).toHaveValue("none");
  await settings(phone).selectOption("project");
  await expect(settings(phone)).toBeEnabled();
  await expect(settings(phone)).toHaveValue("project");
  await noOverflow(phone);
  await phone.screenshot({
    path: ".local/screenshots/history-settings-mobile.png",
  });
  await phone.getByRole("button", { name: "Close dialog" }).click();
  await phone.locator(".new-chat").click();
  await expect(phone.locator(".context-trigger")).toBeVisible();
  await expect
    .poll(() => new URL(phone.url()).searchParams.get("chat"))
    .not.toBe(existing.id);
  const newId = new URL(phone.url()).searchParams.get("chat");
  expect(newId).not.toBe(existing.id);
  expect(app.store.conversation(newId).scope).toBe("project");
  await openSettings(phone);
  await settings(phone).selectOption("all");
  await expect(settings(phone)).toBeEnabled();
  await expect(settings(phone)).toHaveValue("all");
  await phone.getByRole("button", { name: "Close dialog" }).click();
  expect(app.store.conversation(newId).scope).toBe("project");
  await expect(phone.locator(".context-trigger")).toBeVisible();
  expect(app.store.conversation(existing.id).sessions).toEqual(sessions);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      historySettings: "passed",
      desktop: true,
      mobile: true,
      liveSettingsSync: true,
      browserRefresh: true,
      newConversationDefaults: true,
      existingSessionsPreserved: true,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
