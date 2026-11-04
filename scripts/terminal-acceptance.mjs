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
const errors = [],
  inputs = [];
const write = app.terminals.write.bind(app.terminals);
app.terminals.write = (id, data) => {
  inputs.push({ id, data });
  write(id, data);
};
let typingLatency;
try {
  const page = await (
    await browser.newContext({
      viewport: { width: 1512, height: 982 },
      permissions: ["clipboard-read", "clipboard-write"],
    })
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
  // Delay the old per-key HTTP route. Typing must reach the shell and screen
  // promptly without accumulating one request/response delay per character.
  let httpInputs = 0;
  await page.route("**/api/terminals/*/input", async (route) => {
    httpInputs++;
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });
  const textarea = page.locator(".xterm-helper-textarea"),
    rows = page.locator(".terminal-pane .xterm-rows"),
    started = performance.now();
  await textarea.pressSequentially("echo FAST_INPUT_0123456789");
  await expect(rows).toContainText("FAST_INPUT_0123456789", { timeout: 1000 });
  typingLatency = Math.round(performance.now() - started);
  expect(typingLatency).toBeLessThan(1000);
  expect(httpInputs).toBe(0);
  await textarea.press("Enter");
  await page.unroute("**/api/terminals/*/input");

  // Native paste shortcuts insert once. Copying a selection must not send ^C;
  // Ctrl+C without a selection must still reach the shell as an interrupt.
  for (const [shortcut, label] of [
    ["Control+v", "PASTE_CTRL_V"],
    ["Control+Shift+v", "PASTE_SHIFT_V"],
    ["Shift+Insert", "PASTE_INSERT"],
  ]) {
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      `echo ${label}`,
    );
    await textarea.press(shortcut);
    await expect(rows).toContainText(label);
    await textarea.press("Enter");
    await expect
      .poll(
        () =>
          (
            app.terminals
              .list()
              .find((t) => t.shell === "cmd")
              ?.output.match(new RegExp(label, "g")) ?? []
          ).length,
      )
      .toBe(2);
  }
  const copyLine = rows
    .locator(":scope > div")
    .filter({ hasText: "PASTE_INSERT" })
    .last();
  const copyBox = await copyLine.boundingBox();
  expect(copyBox).toBeTruthy();
  // xterm's screen receives pointer input above the rendered row elements.
  await page.mouse.click(copyBox.x + 12, copyBox.y + copyBox.height / 2, {
    clickCount: 3,
  });
  await expect(
    page.getByRole("button", { name: "Copy terminal selection" }),
  ).toBeEnabled();
  const interrupts = () => inputs.filter((i) => i.data.includes("\x03")).length,
    beforeCopy = interrupts();
  for (const shortcut of ["Control+c", "Control+Shift+c"]) {
    await page.evaluate(() => navigator.clipboard.writeText("copy sentinel"));
    await textarea.press(shortcut);
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("PASTE_INSERT");
    expect(interrupts()).toBe(beforeCopy);
  }
  await page.evaluate(() => navigator.clipboard.writeText("button sentinel"));
  await page.getByRole("button", { name: "Copy terminal selection" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("PASTE_INSERT");
  await page.evaluate(() => navigator.clipboard.writeText("echo PASTE_BUTTON"));
  await page.getByRole("button", { name: "Paste into terminal" }).click();
  await expect(rows).toContainText("PASTE_BUTTON");
  await textarea.press("Enter");
  await expect(
    page.getByRole("button", { name: "Copy terminal selection" }),
  ).toBeDisabled();
  await textarea.press("Control+c");
  await expect.poll(interrupts).toBe(beforeCopy + 1);
  await page.screenshot({ path: ".local/screenshots/terminal-tabs.png" });
  await page.getByRole("tab", { name: "PowerShell 1" }).click();
  await expect(page.locator(".terminal-pane .xterm-rows")).toContainText(
    "PANE_OK",
  );

  // A plain click on the line being typed moves the cursor there: typing
  // "C" after clicking between "AB" and "END" runs "echo ABCEND".
  await textarea.pressSequentially("echo ABEND");
  await expect(rows).toContainText("echo ABEND");
  const spot = await page.evaluate(() => {
    const row = [
      ...document.querySelectorAll(".terminal-pane .xterm-rows > div"),
    ].findLast((r) => r.textContent.includes("echo ABEND"));
    let index = row.textContent.indexOf("ABEND") + 2;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (index < node.length) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const box = range.getBoundingClientRect();
        return { x: box.left + box.width / 4, y: box.top + box.height / 2 };
      }
      index -= node.length;
    }
  });
  await page.mouse.click(spot.x, spot.y);
  await expect
    .poll(() => inputs.some((i) => i.data.includes("\x1b[D")))
    .toBe(true);
  await textarea.press("C");
  await textarea.press("Enter");
  await expect
    .poll(
      () =>
        app.terminals.list().find((t) => t.shell === "powershell")?.output ??
        "",
      { timeout: 15000 },
    )
    .toMatch(/ABCEND[^]*ABCEND/);
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

  // Closing a terminal's pane ends its shell and drops it from the sidebar.
  const running = app.terminals.list().length;
  await page.locator(".terminal-pane").nth(1).getByLabel("Close pane").click();
  await expect(page.locator(".terminal-pane")).toHaveCount(1);
  await expect(page.locator(".chat-pane")).toHaveCount(2);
  await expect.poll(() => app.terminals.list().length).toBe(running - 1);
  await expect(page.locator(".terminal-row")).toHaveCount(1);
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
  await page.locator(".terminal-pane").getByLabel("Close pane").click();
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
    `Terminal pane checks passed: real PowerShell/Command Prompt, native clipboard shortcuts and buttons, Ctrl+C interrupt, click to place the cursor, ordered typing (${typingLatency} ms for a 25-character command, no per-key HTTP), splits, tabs, reload and cleanup.`,
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
