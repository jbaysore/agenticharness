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
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  const sidebar = page.locator(".sidebar");
  await expect(sidebar.getByRole("group", { name: "Terminals" })).toContainText(
    "Terminal 1",
  );
  await expect(page.locator(".terminal-pane")).toHaveCount(1);
  await expect(page.locator(".topbar .breadcrumbs strong")).toHaveText(
    "Terminal 1",
  );
  await page.locator(".xterm-helper-textarea").fill("Write-Output 'PANE_OK'");
  await page.locator(".xterm-helper-textarea").press("Enter");
  await expect
    .poll(
      () => (app.terminals.list()[0]?.output.match(/PANE_OK/g) ?? []).length,
      { timeout: 15000 },
    )
    .toBeGreaterThanOrEqual(2);
  await expect(page.locator(".terminal-pane .xterm-rows")).toContainText(
    "PANE_OK",
  );

  // Tabs: a Command Prompt tab joins the window, and each tab keeps its shell.
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("menuitem", { name: "Command Prompt" }).click();
  await expect(page.getByRole("tab")).toHaveText([
    "PowerShell 1",
    "Command Prompt 1",
  ]);
  await expect(page.getByRole("tab", { selected: true })).toHaveText(
    "Command Prompt 1",
  );
  await expect(sidebar.getByRole("group", { name: "Terminals" })).toContainText(
    "2 tabs",
  );
  await page.locator(".xterm-helper-textarea").fill("echo CMD_OK");
  await page.locator(".xterm-helper-textarea").press("Enter");
  await expect
    .poll(
      () =>
        (
          app.terminals
            .list()
            .find((t) => t.shell === "cmd")
            ?.output.match(/CMD_OK/g) ?? []
        ).length,
      { timeout: 15000 },
    )
    .toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: ".local/screenshots/terminal-tabs.png" });
  await page.getByRole("tab", { name: "PowerShell 1" }).click();
  await expect(page.locator(".terminal-pane .xterm-rows")).toContainText(
    "PANE_OK",
  );
  await page.getByLabel("Close Command Prompt 1").click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  expect(app.terminals.list()).toHaveLength(1);
  // The sidebar menu starts a Command Prompt window of its own.
  await page.getByLabel("Choose a shell for a new terminal").click();
  await page.getByRole("menuitem", { name: "Command Prompt" }).click();
  await expect(page.locator(".terminal-pane .terminal-tab")).toHaveText(
    "Command Prompt 1",
  );
  expect(app.terminals.list().map((t) => t.shell)).toEqual([
    "powershell",
    "cmd",
  ]);
  await sidebar.getByLabel("End Terminal 2").click({ force: true });
  await expect(sidebar.getByLabel("End Terminal 2")).toHaveCount(0);
  await sidebar
    .getByRole("button", { name: "Terminal 1", exact: true })
    .click();

  // A second terminal opens beside the first, and chats still open.
  await page
    .getByRole("button", { name: "New terminal", exact: true })
    .click({ modifiers: ["Control"] });
  await expect(page.locator(".terminal-pane")).toHaveCount(2);
  await page.locator(".new-chat").click({ modifiers: ["Control"] });
  await expect(page.locator(".chat-pane")).toHaveCount(3);
  await page.screenshot({ path: ".local/screenshots/terminal-panes.png" });

  // Closing a pane keeps the shell; it comes back from the sidebar.
  await page.getByLabel("Close pane").first().click();
  await expect(page.locator(".terminal-pane")).toHaveCount(1);
  await expect(page.locator(".chat-pane")).toHaveCount(2);
  expect(app.terminals.list()).toHaveLength(2);
  await sidebar
    .getByRole("button", { name: "Terminal 1", exact: true })
    .click();
  await expect(page.locator(".terminal-pane .xterm-rows")).toContainText(
    "PANE_OK",
  );

  // Two chats and a terminal share the width equally, and a reload keeps them.
  await page.getByLabel("Add a pane beside").click();
  await page.locator(".new-chat").click({ modifiers: ["Control"] });
  const panes = page.locator(".pane-strip > section");
  await expect(panes).toHaveCount(3);
  const widths = await panes.evaluateAll((all) =>
    all.map((p) => Math.round(p.getBoundingClientRect().width)),
  );
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  const order = () =>
    panes.evaluateAll((all) =>
      all.map((p) => (p.classList.contains("terminal-pane") ? "t" : "c")),
    );
  const before = await order();
  await page.reload();
  await expect(panes).toHaveCount(3);
  expect(await order()).toEqual(before);
  await expect(page.locator(".terminal-pane .xterm-rows")).toContainText(
    "PANE_OK",
  );

  // Ending one stops it and removes it everywhere.
  await sidebar.getByLabel("End Terminal 1").click({ force: true });
  await expect(
    sidebar.getByRole("button", { name: "Terminal 1", exact: true }),
  ).toHaveCount(0);
  expect(app.terminals.list()).toHaveLength(0);

  // A terminal nothing was run in is dropped when its pane goes away; one
  // that was used stays in the sidebar.
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await page.locator(".xterm-helper-textarea").fill("echo kept");
  await page.locator(".xterm-helper-textarea").press("Enter");
  await expect.poll(() => app.terminals.list()[0]?.used).toBe(true);
  await page.locator(".new-chat").click();
  await expect(page.locator(".terminal-row")).toHaveCount(1);
  const kept = app.terminals.list().length;
  expect(kept).toBe(1);
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect.poll(() => app.terminals.list().length).toBe(kept + 1);
  await page.locator(".xterm-helper-textarea").fill("typed but not sent");
  await page.locator(".new-chat").click();
  await expect.poll(() => app.terminals.list().length).toBe(kept);
  await expect(page.locator(".terminal-row")).toHaveCount(1);
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect.poll(() => app.terminals.list().length).toBe(kept + 1);
  await page.getByLabel("Close pane").first().click();
  await expect.poll(() => app.terminals.list().length).toBe(kept);
  await expect(page.locator(".terminal-row")).toHaveCount(1);

  // The Terminals section folds away, and stays that way after a reload.
  const toggle = page.getByRole("button", { name: /^Terminals/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".terminal-row")).toBeHidden();
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^Terminals/ }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(errors).toEqual([]);
  console.log(
    "Terminal pane checks passed: opens from the sidebar, runs a command, splits beside, reopens, ends.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
