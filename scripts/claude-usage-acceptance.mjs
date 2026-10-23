// Isolated UI checks with synthetic telemetry; no live providers or inference.
import { chromium, expect, devices } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";
import { createClaudeUsageMonitor } from "../src/security/claude-usage.mjs";
import { cursorMonthlyReset, cursorResetDay, cursorResetLabel } from "../src/ui/status.mjs";

await mkdir(".local/screenshots", { recursive: true });
const dataDir = await mkdtemp(resolve(".local/claude-usage-"));
const app = await createHarness({ dataDir, port: 0, startProviders: false });
let browser;
const errors = [];
try {
  const project = app.store.addProject("Usage fixture", process.cwd());
  const chat = app.store.createConversation({
    projectId: project.id,
    title: "Claude usage verification",
    provider: "claude",
  });
  app.store.addMessage({
    conversationId: chat.id,
    role: "user",
    content: "Continue the task.",
  });
  const monitor = createClaudeUsageMonitor({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "pro",
  });
  // Reset times sit mid-unit so the countdown text stays stable during the run.
  const resetIn = (minutes) => Math.floor(Date.now() / 1000) + minutes * 60 - 30;
  const reading = (percent) => ({
    rate_limits_available: true,
    rate_limits: {
      extra_usage: { is_enabled: false, user_disabled: true },
      limits: [
        { kind: "session", group: "session", percent, resets_at: resetIn(200) },
        {
          kind: "weekly_all", group: "weekly", percent: 27,
          resets_at: resetIn((4 * 24 + 5) * 60 + 30),
        },
      ],
    },
  });
  app.controller.providers = [
    {
      id: "claude",
      name: "Claude Code",
      connected: true,
      route: "Claude subscription",
      usage: monitor.update(reading(26)).usage,
      models: [{ id: "fixture", name: "Fixture", efforts: [] }],
    },
    {
      id: "codex",
      name: "Codex",
      connected: true,
      models: [],
      usage: {
        authoritative: true,
        windows: [
          { bucket: "codex", windowMinutes: 300, usedPercent: 10, resetsAt: resetIn(30) },
          { bucket: "codex", windowMinutes: 10080, usedPercent: 20 },
        ],
      },
    },
    {
      id: "cursor",
      name: "Cursor",
      connected: true,
      models: [],
      usage: { authoritative: false, windows: [] },
    },
  ];
  const publish = (value) => {
    const { usage } = monitor.update(value);
    app.controller.providers[0].usage = usage;
    app.controller.event(chat.id, null, "usage", {
      provider: "claude",
      ...usage,
    });
  };
  browser = await chromium.launch({ channel: "msedge", headless: true });
  for (const [label, options] of [
    ["wide-desktop", { viewport: { width: 1920, height: 1000 } }],
    ["desktop", { viewport: { width: 1440, height: 1000 } }],
    ["compact-desktop", { viewport: { width: 1280, height: 900 } }],
    ["narrow-desktop", { viewport: { width: 900, height: 900 } }],
    ["mobile", devices["iPhone 13"]],
    ["small-mobile", { ...devices["iPhone 13"], viewport: { width: 320, height: 740 } }],
  ]) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    // The viewing device is ten days ahead; quota timers must use host time.
    await page.clock.setFixedTime(Date.now() + 10 * 86400000);
    page.on("pageerror", (error) => errors.push(error.message));
    publish(reading(26));
    await page.goto(`${app.runtime.origin}/#pair=${app.auth.pairing()}`);
    await expect(page.locator(".usage-chip.claude")).toHaveAttribute(
      "aria-label",
      /74%/,
    );
    await expect(page.locator(".usage-chip")).toHaveCount(3);
    await expect(page.locator(".usage-chip.claude .usage-chip-name")).toBeVisible();
    await expect(page.locator(".usage-chip.codex .usage-chip-name")).toBeVisible();
    const cursorResetAt = String(cursorMonthlyReset(Date.now()));
    await expect(page.locator(".usage-chip.cursor .usage-chip-date")).toHaveAttribute(
      "data-reset",
      cursorResetAt,
    );
    await expect(page.locator(".usage-chip.cursor .usage-chip-date")).toHaveText(
      cursorResetDay(Number(cursorResetAt)),
    );
    await expect(page.locator(".usage-chip.cursor .usage-chip-value")).toHaveCount(0);
    await expect(page.locator(".usage-chip.claude .usage-chip-value")).toHaveText([
      "74%", "73%",
    ]);
    await expect(page.locator(".usage-chip.claude .usage-chip-span")).toHaveText([
      "5h", "wk",
    ]);
    await expect(page.locator(".usage-chip.claude .usage-chip-span").first()).toBeVisible();
    await expect(page.locator(".usage-chip.claude .usage-chip-span").last()).toBeVisible();
    await expect(page.locator(".usage-chip.claude .usage-chip-reset")).toHaveText([
      "3h 20m", "4d 6h",
    ]);
    await expect(page.locator(".usage-chip.codex .usage-chip-value")).toHaveText([
      "90%", "80%",
    ]);
    await expect(page.locator(".usage-chip.codex .usage-chip-reset")).toHaveText([
      /^(29|30)m$/, "",
    ]);
    await expect(page.locator(".usage-chip.claude .usage-chip-reset svg")).toHaveCount(2);
    const headerFits = async () => {
      expect(await page.evaluate(() => {
        const header = document.querySelector(".topbar").getBoundingClientRect();
        const usage = document.querySelector(".usage-glance").getBoundingClientRect();
        const crumbs = document.querySelector(".breadcrumbs").getBoundingClientRect();
        return document.documentElement.scrollWidth <= innerWidth &&
          usage.left >= header.left && usage.right <= header.right &&
          (crumbs.bottom <= usage.top || crumbs.right <= usage.left);
      })).toBe(true);
      for (const reset of await page.locator(".usage-chip-reset").all()) {
        expect(await reset.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
    };
    await headerFits();
    await page.screenshot({
      path: `.local/screenshots/usage-header-${label}.png`,
    });
    const before = await page.locator(".usage-glance").boundingBox();
    const initialCodex = app.controller.providers[1].usage;
    const changedCodex = { ...initialCodex, windows: [
      // Millisecond telemetry must yield the same countdown as Unix seconds.
      { bucket: "codex", windowMinutes: 300, usedPercent: 0, resetsAt: resetIn(1439) * 1000 },
      { bucket: "codex", windowMinutes: 10080, usedPercent: 100, resetsAt: resetIn(60) },
    ] };
    app.controller.providers[1].usage = changedCodex;
    app.controller.event(chat.id, null, "usage", { provider: "codex", ...changedCodex });
    await expect(page.locator(".usage-chip.codex .usage-chip-reset")).toHaveText(["23h 59m", "1h"]);
    await expect(page.locator(".usage-chip.codex .usage-chip-value")).toHaveText(["100%", "0%"]);
    await headerFits();
    const after = await page.locator(".usage-glance").boundingBox();
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    expect(Math.abs(after.width - before.width)).toBeLessThan(1);
    // Changing the device clock again and resuming the tab must not move time.
    await page.clock.setFixedTime(Date.now() - 10 * 86400000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator(".usage-chip.claude .usage-chip-reset")).toHaveText(["3h 20m", "4d 6h"]);
    app.controller.providers[1].usage = initialCodex;
    app.controller.event(chat.id, null, "usage", { provider: "codex", ...initialCodex });
    publish({ rate_limits_available: true, rate_limits: {} });
    await expect(page.locator(".usage-chip.claude .usage-chip-value")).toHaveText([
      "74%", "73%",
    ]);
    await expect(page.locator(".usage-chip.claude .usage-stale")).toHaveCount(0);
    await expect(page.locator(".usage-chip.claude")).toHaveAttribute(
      "aria-label",
      /74%/,
    );
    await expect(page.locator(".usage-chip.claude")).not.toHaveAttribute(
      "aria-label",
      /stale|Unknown/,
    );
    await page.locator(".usage-glance-trigger").click();
    const popover = page.getByRole("dialog", {
      name: "Usage remaining",
      exact: true,
    });
    await expect(popover.getByRole("link", { name: "Open Claude resets" })).toHaveAttribute(
      "href", "https://claude.ai/settings/usage",
    );
    await expect(popover.getByRole("button", { name: "Refresh usage", exact: true })).toBeVisible();
    await expect(popover.locator(".usage-provider.cursor .cursor-reset")).toHaveText(
      cursorResetLabel(Number(cursorResetAt)),
    );
    await expect(
      page.locator(".usage-chip.claude .usage-chip-row.unknown"),
    ).toHaveCount(0);
    await expect(popover.getByRole("status")).toHaveCount(0);
    await expect(popover.getByText("74% left", { exact: true })).toBeVisible();
    const aged = {
      ...app.controller.providers[0].usage,
      lastConfirmedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
    };
    app.controller.providers[0].usage = aged;
    app.controller.event(chat.id, null, "usage", { provider: "claude", ...aged });
    await expect(page.locator(".usage-chip.claude .usage-stale")).toHaveText("stale");
    await expect(page.locator(".usage-chip.claude .usage-chip-value")).toHaveText([
      "74%", "73%",
    ]);
    await expect(popover.getByRole("status")).toHaveText(
      /Stale · last confirmed at .*\d+:\d+:\d+/,
    );
    await headerFits();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `.local/screenshots/claude-usage-${label}.png`,
    });
    await page.reload();
    await expect(page.locator(".usage-chip.claude .usage-stale")).toHaveText("stale");
    await expect(page.locator(".usage-chip.claude")).toHaveAttribute(
      "aria-label",
      /74%.*stale/,
    );
    await page.locator(".usage-glance-trigger").click();
    await page.locator(".usage-popover-link").click();
    const connections = page.getByRole("dialog", {
      name: "Connections & usage",
      exact: true,
    });
    await expect(connections.getByRole("link", { name: "Open Claude resets" })).toBeVisible();
    await expect(connections.getByRole("button", { name: "Refresh usage", exact: true })).toBeVisible();
    await expect(connections.getByText("Cursor", { exact: true })).toBeVisible();
    await expect(connections.locator(".connection.cursor .cursor-reset")).toHaveText(
      cursorResetLabel(Number(cursorResetAt)),
    );
    await expect(connections.getByRole("status")).toHaveText(
      /Stale · last confirmed at/,
    );
    await expect(
      connections.getByText("74% remaining", { exact: true }),
    ).toBeVisible();
    await connections.getByRole("button", { name: "Close dialog", exact: true }).click();
    publish(reading(28));
    await expect(page.locator(".usage-chip.claude")).toHaveAttribute(
      "aria-label",
      /72%/,
    );
    await expect(page.locator(".usage-chip.claude")).not.toHaveAttribute(
      "aria-label",
      /Unknown/,
    );
    await page.locator(".usage-glance-trigger").click();
    await expect(popover.getByRole("status")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await context.close();
  }
  // The returned billing error uses the existing failed-turn notice.
  const run = app.store.createRun({
    conversationId: chat.id,
    actionId: "visible-claude-billing-stop",
    provider: "claude",
    model: "fixture",
    text: "Continue",
  });
  app.store.setRun(
    run.id,
    "failed",
    null,
    "A Claude included-usage limit is exhausted.",
  );
  const context = await browser.newContext();
  // External navigation and refresh stay synthetic: no live redemption or
  // provider probes. Opening Claude alone must not change an exhausted meter.
  await context.route("https://claude.ai/**", (route) => route.fulfill({
    contentType: "text/html", body: "<title>Claude usage fixture</title>",
  }));
  // A fresh monitor has never confirmed a reading under the limit. The
  // reported 5-hour and weekly windows must still match a reading with usage left.
  const exhausted = createClaudeUsageMonitor({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "pro",
  }).update(reading(100));
  app.controller.providers[0].usage = exhausted.usage;
  app.controller.providers[0].blockReason = exhausted.reason;
  const page = await context.newPage();
  await page.goto(`${app.runtime.origin}/#pair=${app.auth.pairing()}`);
  await page
    .getByLabel("Active chats")
    .getByRole("button", { name: "Claude usage verification", exact: true })
    .click();
  await expect(page.locator(".notice.failed")).toContainText(
    "A Claude included-usage limit is exhausted.",
  );
  await page.locator(".usage-glance-trigger").click();
  const popover = page.getByRole("dialog", { name: "Usage remaining", exact: true });
  const popupOpened = page.waitForEvent("popup");
  await popover.getByRole("link", { name: "Open Claude resets" }).click();
  const popup = await popupOpened;
  await expect(popup).toHaveURL("https://claude.ai/settings/usage");
  await popup.close();
  await expect(page.locator(".usage-chip.claude .usage-chip-span")).toHaveText([
    "5h", "wk",
  ]);
  await expect(page.locator(".usage-chip.claude .usage-chip-value")).toHaveText([
    "0%", "73%",
  ]);
  await expect(page.locator(".usage-chip.claude .usage-chip-reset")).toHaveText([
    "3h 20m", "4d 6h",
  ]);
  await expect(popover.getByText("Out of usage", { exact: true })).toBeVisible();
  await expect(popover.getByText("0% left", { exact: true })).toBeVisible();
  await expect(popover.getByText("73% left", { exact: true })).toBeVisible();
  await expect(popover.getByText(/last confirmed/)).toHaveCount(0);
  await page.screenshot({
    path: ".local/screenshots/claude-usage-exhausted.png",
  });
  await page.locator(".usage-popover-link").click();
  const exhaustedConnections = page.getByRole("dialog", {
    name: "Connections & usage",
    exact: true,
  });
  await expect(exhaustedConnections.getByText("0% remaining", { exact: true })).toBeVisible();
  await expect(exhaustedConnections.getByText("73% remaining", { exact: true })).toBeVisible();
  await expect(
    exhaustedConnections.getByText("Quota information unavailable through this integration"),
  ).toHaveCount(1);
  await exhaustedConnections.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.locator(".usage-glance-trigger").click();
  let releaseRefresh, refreshCalls = 0;
  await page.route("**/api/providers/refresh", async (route) => {
    refreshCalls++;
    await new Promise((resolve) => { releaseRefresh = resolve; });
    const restored = monitor.update(reading(refreshCalls === 1 ? 0 : 9));
    app.controller.providers[0].usage = restored.usage;
    app.controller.providers[0].blockReason = restored.reason;
    await route.fulfill({ json: { providers: app.controller.providers } });
  });
  await popover.getByRole("button", { name: "Refresh usage", exact: true }).click();
  await expect(popover.getByRole("button", { name: "Checking…", exact: true })).toBeDisabled();
  await expect.poll(() => typeof releaseRefresh).toBe("function");
  releaseRefresh();
  await expect(page.locator(".usage-chip.claude .usage-chip-value").first()).toHaveText("100%");
  await expect(popover.getByRole("button", { name: "Refresh usage", exact: true })).toBeEnabled();
  await expect(popover.getByText("Out of usage", { exact: true })).toHaveCount(0);
  await page.locator(".usage-popover-link").click();
  const connections = page.getByRole("dialog", { name: "Connections & usage", exact: true });
  releaseRefresh = null;
  await connections.getByRole("button", { name: "Refresh usage", exact: true }).click();
  await expect(connections.getByRole("button", { name: "Checking…", exact: true })).toHaveCount(2);
  await expect.poll(() => typeof releaseRefresh).toBe("function");
  releaseRefresh();
  await expect(page.locator(".usage-chip.claude .usage-chip-value").first()).toHaveText("91%");
  expect(refreshCalls).toBe(2);
  expect(errors).toEqual([]);
  console.log(
    "Claude usage UI passed: six header widths, stable countdown columns, host clocks, a missed reading that keeps its last meter and turns stale after five minutes, reset links in both panels, external navigation from exhausted quota, refresh loading and quota recovery, and visible stop reason.",
  );
} finally {
  await browser?.close();
  await app.close();
}
