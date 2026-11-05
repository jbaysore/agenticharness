// Browser reconnection with a simulated provider; no inference or live data.
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm, stat, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const dataDir = await mkdtemp(join(tmpdir(), "harness-restart-browser-"));
const client = resolve("dist/app.js"),
  original = await stat(client);
let app, browser, releaseWorkspace;
const start = async (port = 0) => {
  const host = await createHarness({
    dataDir,
    port,
    startProviders: false,
    seedProject: dataDir,
  });
  host.controller.providers = [
    {
      id: "codex",
      name: "Restart fixture",
      connected: true,
      models: [{ id: "fixture", name: "No inference", efforts: [] }],
      capabilities: {},
    },
  ];
  host.controller.runners.codex = async (ctx) => {
    ctx.emit("text", { nativeId: randomUUID(), text: "Fixture complete." });
    return { status: "completed" };
  };
  return host;
};
try {
  app = await start();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage(),
    errors = [];
  let allowUse = true,
    delayWorkspace = false,
    waitingLoads = 0;
  const workspaceReady = new Promise((resolve) => {
    releaseWorkspace = resolve;
  });
  await page.route("**/health", async (route) => {
    try {
      const response = await route.fetch();
      const health = await response.json();
      await route.fulfill({
        response,
        json: { ...health, acceptingWork: allowUse && health.acceptingWork },
      });
    } catch {
      await route.abort().catch(() => {});
    }
  });
  await page.route("**/api/state", async (route) => {
    if (delayWorkspace) {
      waitingLoads++;
      await workspaceReady;
    }
    await route.continue().catch(() => {});
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.runtime.origin);
  await chooseModel(page, app.controller.providers, "codex", "fixture");
  const input = page.getByLabel("Message your coding agent");
  await input.fill("Create a fixture chat");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText("Fixture complete.", { exact: true }).first(),
  ).toBeVisible();
  await input.fill("Unsent draft survives a Harness update");
  const goalChat = app.store.conversations()[0];
  app.store.setGoalState(goalChat.id, "codex", app.store.conversationSnapshot(goalChat.id).runs[0].id, "unknown");
  app.store.updateConversation(goalChat.id, { sessions: { codex: { ...app.store.conversation(goalChat.id).sessions.codex, id: "fixture-goal" } } });
  app.controller.pauseRunners.codex = async () => "paused";
  app.controller.event(
    goalChat.id,
    null,
    "chat",
    app.store.conversation(goalChat.id),
  );
  await expect(
    page.getByText("This Goal has not been confirmed stopped", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop work", exact: true }),
  ).toBeVisible();
  // A pause also settles when the event stream is disconnected.
  await page.route("**/api/events?*", (route) => route.abort());
  await page.reload();
  await expect(input).toHaveValue("Unsent draft survives a Harness update");
  await page.getByRole("button", { name: "Stop work", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop work", exact: true }),
  ).not.toBeVisible();
  if (app.store.restartBlockingGoals().length)
    throw new Error("Explicit Stop did not release the unconfirmed Goal hold");
  await expect(input).toHaveValue("Unsent draft survives a Harness update");
  await page.unroute("**/api/events?*");
  await page.reload();
  await expect(input).toHaveValue("Unsent draft survives a Harness update");
  await page.evaluate(() => {
    window.restartBrowserMarker = true;
  });
  app.controller.event(null, null, "self-restart", {
    id: "browser-fixture",
    status: "waiting",
    blockers: ["Unfinished or unconfirmed Goal sessions", "Open terminals"],
  });
  await expect(
    page.getByRole("status", { name: "Harness update status" }),
  ).toContainText("open terminals");
  await expect(
    page.getByRole("status", { name: "Harness update status" }),
  ).toContainText("unfinished or unconfirmed goal sessions");
  const dialog = page.getByRole("dialog", { name: "Harness is restarting" });
  await expect(dialog).not.toBeVisible();
  allowUse = false;
  app.controller.event(null, null, "self-restart", {
    id: "browser-fixture",
    status: "restarting",
    blockers: [],
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "Sorry! Harness is restarting to apply the latest changes.",
  );
  await expect(
    dialog.getByRole("progressbar", { name: "Harness restart progress" }),
  ).toBeVisible();
  await expect(dialog.getByRole("progressbar")).not.toHaveAttribute("value");
  await expect(
    dialog.getByRole("button", { name: "Close dialog" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => dialog.evaluate((node) => node.matches(":modal")))
    .toBe(true);
  await mkdir(resolve(".local/screenshots"), { recursive: true });
  await page.screenshot({
    path: resolve(".local/screenshots/restart-progress-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const bounds = await dialog.boundingBox();
      return bounds && bounds.x >= 12 && bounds.x + bounds.width <= 378;
    })
    .toBe(true);
  await page.screenshot({
    path: resolve(".local/screenshots/restart-progress-mobile.png"),
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  const { port, instanceId } = app.runtime;
  const beforeBuild = await fetch(app.runtime.origin + "/health").then((r) =>
    r.json(),
  );
  await app.close();
  await expect(dialog).toBeVisible();
  // Simulate a separately prepared client arriving with the replacement host.
  // Only this worktree's ignored build output changes; the live app is untouched.
  await utimes(client, original.atime, new Date(original.mtimeMs + 10000));
  app = await start(port);
  if (app.runtime.instanceId === instanceId)
    throw new Error("Fixture did not replace its host");
  const afterBuild = await fetch(app.runtime.origin + "/health").then((r) =>
    r.json(),
  );
  if (beforeBuild.build === afterBuild.build)
    throw new Error("Fixture did not change the client fingerprint");
  app.controller.event(null, null, "self-restart", {
    id: "browser-fixture",
    status: "updated",
    blockers: [],
  });
  // Readiness of the host alone must not uncover a client still loading its
  // workspace. The session marker carries the modal across the actual reload.
  delayWorkspace = true;
  allowUse = true;
  await expect
    .poll(
      () =>
        page
          .evaluate(() => window.restartBrowserMarker ?? false)
          .catch((error) => {
            // The poll can overlap the reload it is waiting for.
            if (error.message.includes("Execution context was destroyed"))
              return true;
            throw error;
          }),
      {
        timeout: 20000,
      },
    )
    .toBe(false);
  await expect.poll(() => waitingLoads).toBeGreaterThan(0);
  await expect(dialog).toBeVisible();
  releaseWorkspace();
  await expect(dialog).not.toBeVisible({ timeout: 15000 });
  await expect(input).toHaveValue("Unsent draft survives a Harness update");
  const chat = app.store.conversations()[0];
  if (app.store.messages(chat.id).filter((m) => m.role === "user").length !== 1)
    throw new Error("A message was replayed during reconnect");
  allowUse = false;
  app.controller.event(null, null, "self-restart", {
    id: "recovery-fixture",
    status: "recovering",
    blockers: [],
  });
  const recovering = page.getByRole("dialog", { name: "Restoring Harness" });
  await expect(recovering).toBeVisible();
  app.controller.event(null, null, "self-restart", {
    id: "recovery-fixture",
    status: "failed",
    blockers: [],
    error: "Fixture startup failed",
  });
  await expect(recovering).toBeVisible();
  allowUse = true;
  await expect(recovering).not.toBeVisible({ timeout: 15000 });
  await input.focus();
  await expect(input).toBeFocused();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "Passed: unconfirmed Goal stop and waiting feedback, restart progress modal, desktop/mobile layout, readiness-based dismissal, rollback feedback, host/client reload, draft recovery, and no replay; no inference.",
  );
} finally {
  releaseWorkspace?.();
  await browser?.close();
  await app?.close();
  await utimes(client, original.atime, original.mtime);
  await rm(dataDir, { recursive: true, force: true });
}
