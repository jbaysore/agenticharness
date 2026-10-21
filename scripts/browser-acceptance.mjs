// Browser checks use the real saved provider acceptance transcript, without new inference.
import { chromium, expect, devices } from "@playwright/test";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";
const app = await createHarness({
  dataDir: resolve(".local/acceptance"),
  port: 0,
  startProviders: false,
});
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [],
  result = {
    type: "real-browser-ui-with-real-saved-provider-history",
    physicalDeviceTest: false,
  };
await mkdir(".local/screenshots", { recursive: true });
try {
  await app.controller.refreshProviders();
  const chat = app.store
    .conversations()
    .find((c) =>
      app.store
        .messages(c.id)
        .some((m) => m.provider === "cursor" && m.content.includes("4 of 4")),
    );
  if (!chat)
    throw new Error(
      "Run the real provider acceptance fixture before browser acceptance.",
    );
  const context = await browser.newContext({
      viewport: { width: 1512, height: 982 },
    }),
    page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${app.runtime.origin}/?chat=${chat.id}#pair=${app.auth.pairing()}`,
  );
  await expect(page.getByLabel("Message your coding agent")).toBeVisible();
  await expect(page.locator(".message.assistant")).toHaveCount(
    app.store.messages(chat.id).filter((m) => m.role === "assistant").length,
  );
  await chooseModel(
    page,
    app.controller.providers,
    "codex",
    "gpt-6.1-sol",
    "high",
  );
  await expect(page.getByLabel("Agent and model")).toContainText("High");
  const claude = app.controller.providers
    .find((p) => p.id === "claude")
    .models.find((m) => m.efforts.includes("medium"));
  await chooseModel(
    page,
    app.controller.providers,
    "claude",
    claude.id,
    "medium",
  );
  const cursor = app.controller.providers
    .find((p) => p.id === "cursor")
    .models.find((m) => !m.disabled);
  await chooseModel(page, app.controller.providers, "cursor", cursor.id);
  await expect(page.locator(".model-summary")).toHaveText(
    "Cursor · " + cursor.name,
  );
  result.modelAndEffortControls = true;
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "title.mjs M", exact: true }).click();
  await expect(page.locator(".diff-lines")).toContainText("trim()");
  await page
    .locator(".review-comment textarea")
    .fill("Acceptance review: preserve the four verified string-input cases.");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Ask for revisions", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: ".local/screenshots/desktop-review.png",
    fullPage: true,
  });
  result.reviewComment = true;
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByLabel("Filter files").fill("title.mjs");
  await page
    .locator(".tree")
    .getByRole("button", { name: "title.mjs", exact: true })
    .click();
  await page.getByRole("button", { name: "Pin artifact", exact: true }).click();
  await expect(page.locator(".artifact-row").first()).toBeVisible();
  result.artifacts = true;
  await page
    .getByLabel("Save project decision")
    .fill(
      "The formatter accepts strings. Real verification covers trimming, blank values and normal input.",
    );
  await page
    .getByRole("button", { name: "Save with conversation source", exact: true })
    .click();
  await expect(page.locator(".project-note").last()).toContainText(
    "formatter accepts strings",
  );
  result.evidenceLinkedNotes = true;
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page
    .getByRole("button", { name: "Open terminal", exact: true })
    .click();
  await page
    .locator(".xterm-helper-textarea")
    .fill("Write-Output 'HARNESS_TERMINAL_VERIFIED'");
  await page.locator(".xterm-helper-textarea").press("Enter");
  await expect
    .poll(
      () =>
        (
          app.terminals.list()[0]?.output.match(/HARNESS_TERMINAL_VERIFIED/g) ??
          []
        ).length,
      { timeout: 15000 },
    )
    .toBeGreaterThanOrEqual(2);
  await page.screenshot({
    path: ".local/screenshots/desktop-terminal.png",
    fullPage: true,
  });
  result.realConPTY = true;
  await page
    .getByRole("button", { name: "Search conversations", exact: true })
    .click();
  await page.getByLabel("Search history").fill("issueTitle");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".search-results>button").first()).toBeVisible();
  await page.getByLabel("Close dialog").click();
  result.search = true;
  await context.setOffline(true);
  await expect(page.locator(".reconnect-banner")).toBeVisible({
    timeout: 12000,
  });
  await context.setOffline(false);
  await expect(page.locator(".reconnect-banner")).toHaveCount(0, {
    timeout: 15000,
  });
  await page.reload();
  await expect(page.locator(".message.assistant")).toHaveCount(
    app.store.messages(chat.id).filter((m) => m.role === "assistant").length,
  );
  result.browserReconnect = true;
  const mobile = await browser.newContext({
    ...devices["iPhone 13"],
    defaultBrowserType: undefined,
  });
  const phone = await mobile.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(
    `${app.runtime.origin}/?chat=${chat.id}#pair=${app.auth.pairing()}`,
  );
  await expect(phone.getByLabel("Message your coding agent")).toBeVisible();
  await expect(phone.locator(".work-panel")).toHaveCount(0);
  await phone.screenshot({
    path: ".local/screenshots/phone-chat.png",
    fullPage: true,
  });
  if (
    await phone.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    )
  )
    throw new Error("Horizontal mobile page overflow");
  await phone.getByLabel("Toggle work panel").click();
  await phone.getByRole("button", { name: "Review", exact: true }).click();
  await phone.getByRole("button", { name: "title.mjs M", exact: true }).click();
  await phone.screenshot({
    path: ".local/screenshots/phone-review.png",
    fullPage: true,
  });
  await phone.getByLabel("Close work panel").click();
  await phone.getByLabel("Show sidebar").click();
  await phone.getByRole("button", { name: /Connections & usage/ }).click();
  await expect(phone.getByRole("dialog")).toBeVisible();
  await phone.screenshot({
    path: ".local/screenshots/phone-connections.png",
    fullPage: true,
  });
  result.phoneResponsiveEmulation = true;
  expect(errors).toEqual([]);
  result.pageErrors = errors;
  result.at = new Date().toISOString();
  await writeFile(
    ".local/browser-acceptance.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await app.close();
}
