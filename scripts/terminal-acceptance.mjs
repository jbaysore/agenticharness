// Real browser and real ConPTY, no inference: a terminal opens as its own
// pane from the sidebar, beside a chat, and is ended from the sidebar.
import { createHarness } from "../src/server.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "harness-terminal-")),
  app = await createHarness({
    dataDir: join(dir, "data"),
    port: 0,
    startProviders: false,
  });
app.controller.providers = [
  {
    id: "codex",
    name: "Transport fixture",
    connected: true,
    models: [{ id: "fixture", name: "No inference", efforts: [] }],
    capabilities: {},
  },
];
app.store.addProject("Main project", dir);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
try {
  const page = await (
    await browser.newContext({ viewport: { width: 1512, height: 982 } })
  ).newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.runtime.origin + "/#pair=" + app.auth.pairing());
  await page
    .getByRole("button", { name: "New terminal", exact: true })
    .click();
  const sidebar = page.locator(".sidebar");
  await expect(
    sidebar.getByRole("group", { name: "Terminals" }),
  ).toContainText("Terminal 1");
  await expect(page.locator(".terminal-pane")).toHaveCount(1);
  await expect(page.locator(".topbar .breadcrumbs strong")).toHaveText(
    "Terminal 1",
  );
  await page.locator(".xterm-helper-textarea").fill("Write-Output 'PANE_OK'");
  await page.locator(".xterm-helper-textarea").press("Enter");
  await expect
    .poll(
      () =>
        (app.terminals.list()[0]?.output.match(/PANE_OK/g) ?? []).length,
      { timeout: 15000 },
    )
    .toBeGreaterThanOrEqual(2);
  await expect(page.locator(".terminal-pane .xterm-rows")).toContainText(
    "PANE_OK",
  );

  // A second terminal opens beside the first, and chats still open.
  await page
    .getByRole("button", { name: "New terminal", exact: true })
    .click({ modifiers: ["Control"] });
  await expect(page.locator(".terminal-pane")).toHaveCount(2);
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click({ modifiers: ["Control"] });
  await expect(page.locator(".chat-pane")).toHaveCount(3);
  await page.screenshot({ path: ".local/screenshots/terminal-panes.png" });

  // Closing a pane keeps the shell; it comes back from the sidebar.
  await page.getByLabel("Close pane").first().click();
  await expect(page.locator(".terminal-pane")).toHaveCount(1);
  await expect(page.locator(".chat-pane")).toHaveCount(2);
  expect(app.terminals.list()).toHaveLength(2);
  await sidebar.getByRole("button", { name: "Terminal 1", exact: true }).click();
  await expect(page.locator(".terminal-pane .xterm-rows")).toContainText(
    "PANE_OK",
  );

  // Ending one stops it and removes it everywhere.
  await sidebar.getByLabel("End Terminal 1").click({ force: true });
  await expect(sidebar.getByRole("button", { name: "Terminal 1", exact: true })).toHaveCount(
    0,
  );
  expect(app.terminals.list()).toHaveLength(1);
  expect(errors).toEqual([]);
  console.log(
    "Terminal pane checks passed: opens from the sidebar, runs a command, splits beside, reopens, ends.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
