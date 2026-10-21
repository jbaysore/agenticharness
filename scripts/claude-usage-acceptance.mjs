// Isolated UI checks with synthetic telemetry; no live providers or inference.
import { chromium, expect, devices } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";
import { createClaudeUsageMonitor } from "../src/security/claude-usage.mjs";

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
  const reading = (percent) => ({
    rate_limits_available: true,
    rate_limits: {
      extra_usage: { is_enabled: false, user_disabled: true },
      limits: [
        { kind: "five_hour", percent },
        { kind: "seven_day", percent: 27 },
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
  for (const mobile of [false, true]) {
    const context = await browser.newContext(
      mobile
        ? devices["iPhone 13"]
        : {
            viewport: { width: 1440, height: 1000 },
          },
    );
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    publish(reading(26));
    await page.goto(`${app.runtime.origin}/#pair=${app.auth.pairing()}`);
    await expect(page.locator(".usage-chip.claude")).toHaveAttribute(
      "aria-label",
      /74%/,
    );
    publish({ rate_limits_available: true, rate_limits: {} });
    await expect(page.locator(".usage-chip.claude")).toHaveAttribute(
      "aria-label",
      /Unknown.*last confirmed at/,
    );
    await page.locator(".usage-glance-trigger").click();
    const popover = page.getByRole("dialog", {
      name: "Usage remaining",
      exact: true,
    });
    await expect(popover.getByRole("status")).toHaveText(
      /Unknown · last confirmed at .*\d+:\d+:\d+/,
    );
    await expect(
      popover.getByText("74% left (last confirmed)", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `.local/screenshots/claude-usage-${mobile ? "mobile" : "desktop"}.png`,
    });
    await page.reload();
    await expect(page.locator(".usage-chip.claude")).toHaveAttribute(
      "aria-label",
      /Unknown.*last confirmed at/,
    );
    await page.locator(".usage-glance-trigger").click();
    await page.locator(".usage-popover-link").click();
    const connections = page.getByRole("dialog", {
      name: "Connections & usage",
      exact: true,
    });
    await expect(connections.getByRole("status")).toHaveText(
      /Unknown · last confirmed at/,
    );
    await expect(
      connections.getByText("74% remaining (last confirmed)", { exact: true }),
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
  const page = await context.newPage();
  await page.goto(`${app.runtime.origin}/#pair=${app.auth.pairing()}`);
  await page
    .getByLabel("Active chats")
    .getByRole("button", { name: "Claude usage verification", exact: true })
    .click();
  await expect(page.locator(".notice.failed")).toContainText(
    "A Claude included-usage limit is exhausted.",
  );
  expect(errors).toEqual([]);
  console.log(
    "Claude usage UI passed: desktop/mobile unknown timestamps, retained values, reload, recovery and visible stop reason.",
  );
} finally {
  await browser?.close();
  await app.close();
}
