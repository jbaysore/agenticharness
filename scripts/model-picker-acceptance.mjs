// Isolated browser checks with simulated models and messages; no inference.
import { chromium, expect, devices } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";

await mkdir(".local/screenshots", { recursive: true });
const app = await createHarness({
  dataDir: await mkdtemp(resolve(".local/model-picker-")),
  port: 0,
  startProviders: false,
  seedProject: process.cwd(),
});
app.controller.providers = [
  {
    id: "codex",
    name: "Codex",
    connected: true,
    models: [
      {
        id: "workhorse",
        name: "Workhorse",
        efforts: ["low", "medium", "high", "xhigh"],
      },
      {
        id: "disabled",
        name: "Unavailable preset",
        efforts: [],
        disabled: true,
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `model-${i}`,
        name: `Another model ${i}`,
        efforts: ["low", "high"],
      })),
    ],
  },
  {
    id: "claude",
    name: "Claude Code",
    connected: true,
    models: [
      { id: "thoughtful", name: "Thoughtful", efforts: ["low", "high"] },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    connected: true,
    models: [{ id: "standard", name: "Standard preset", efforts: [] }],
  },
];
const sent = [];
app.controller.execute = async (run, text, effort) => {
  sent.push({ provider: run.provider, model: run.model, effort });
  await new Promise((resolve) => setTimeout(resolve, 20));
  app.store.setRun(run.id, "completed");
  app.controller.active.delete(run.conversation_id);
  app.controller.event(run.conversation_id, run.id, "run", {
    status: "completed",
  });
};
let browser;
const errors = [];
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${app.runtime.origin}/#pair=${app.auth.pairing()}`);
  const trigger = page.getByRole("button", {
      name: "Agent and model",
      exact: true,
    }),
    menu = page.getByRole("menu"),
    draft = page.getByLabel("Message your coding agent");
  await draft.fill("A simulated message");
  await expect(page.getByLabel("Send message")).toBeDisabled();
  await trigger.click();
  await expect(menu.locator(".model-option-name")).toHaveText([
    "Codex",
    "Claude Code",
    "Cursor",
  ]);
  await page.screenshot({ path: ".local/screenshots/model-providers.png" });
  await menu.getByRole("menuitem", { name: "Codex", exact: true }).click();
  await expect(menu).toHaveAttribute("aria-label", "Choose model");
  await expect(
    menu.getByRole("menuitemradio", { name: "Unavailable preset" }),
  ).toBeDisabled();
  await page.screenshot({ path: ".local/screenshots/model-options.png" });
  await menu.getByRole("menuitem", { name: "Workhorse", exact: true }).click();
  await expect(menu.getByRole("menuitemradio")).toHaveText([
    "Low",
    "Medium",
    "High",
    "Xhigh",
  ]);
  await expect(page.locator(".model-summary")).toHaveText("Choose a model");
  await expect(page.getByLabel("Send message")).toBeDisabled();
  await page.screenshot({ path: ".local/screenshots/model-efforts.png" });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // The full path works with arrow keys, Enter and Escape.
  await trigger.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator(".model-summary")).toHaveText(
    "Codex · Workhorse · High",
  );
  await expect(trigger).toBeFocused();
  await expect(page.getByLabel("Send message")).toBeEnabled();

  // Browsing, backing out, and outside clicks leave the chosen tuple intact.
  await trigger.click();
  await menu
    .getByRole("menuitem", { name: "Claude Code", exact: true })
    .click();
  await menu.getByRole("menuitem", { name: "Thoughtful", exact: true }).click();
  await page.getByLabel("Back to models").click();
  await expect(menu).toHaveAttribute("aria-label", "Choose model");
  await page.keyboard.press("ArrowLeft");
  await expect(menu).toHaveAttribute("aria-label", "Choose provider");
  await draft.click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".model-summary")).toHaveText(
    "Codex · Workhorse · High",
  );
  await chooseModel(
    page,
    app.controller.providers,
    "claude",
    "thoughtful",
    "low",
  );
  await page.getByLabel("Send message").click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({
    provider: "claude",
    model: "thoughtful",
    effort: "low",
  });
  await expect(page.getByLabel("Stop work")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".model-summary")).toHaveText(
    "Claude Code · Thoughtful · Low",
  );
  await chooseModel(page, app.controller.providers, "cursor", "standard");
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".model-summary")).toHaveText(
    "Cursor · Standard preset",
  );
  await draft.fill("A provider preset has no effort override");
  await page.getByLabel("Send message").click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual({
    provider: "cursor",
    model: "standard",
    effort: null,
  });
  await expect(page.getByLabel("Stop work")).toHaveCount(0);
  await trigger.click();
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(trigger).not.toBeFocused();

  // Touch navigation and long catalogs stay inside a small viewport.
  const phone = await (
    await browser.newContext({
      ...devices["iPhone 13"],
      defaultBrowserType: undefined,
    })
  ).newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(`${app.runtime.origin}/#pair=${app.auth.pairing()}`);
  await phone.getByLabel("Agent and model").tap();
  await phone.getByRole("menuitem", { name: "Codex", exact: true }).tap();
  const popup = phone.locator(".model-popup"),
    box = await popup.boundingBox(),
    viewport = phone.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await phone
    .getByRole("menuitem", { name: "Another model 19", exact: true })
    .scrollIntoViewIfNeeded();
  await phone.screenshot({ path: ".local/screenshots/model-phone.png" });
  await phone
    .getByRole("menuitem", { name: "Another model 19", exact: true })
    .tap();
  await phone.getByRole("menuitemradio", { name: "High", exact: true }).tap();
  await expect(phone.locator(".model-summary")).toHaveText(
    "Codex · Another model 19 · High",
  );
  expect(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  // A welcome card opens straight onto its agent's models and sets up the composer.
  const fresh = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  fresh.on("pageerror", (e) => errors.push(e.message));
  await fresh.goto(`${app.runtime.origin}/#pair=${app.auth.pairing()}`);
  const freshMenu = fresh.getByRole("menu");
  await fresh
    .getByRole("button", { name: "Choose a Claude Code model", exact: true })
    .click();
  await expect(freshMenu).toHaveAttribute("aria-label", "Choose model");
  await expect(fresh.getByLabel("Back to providers")).toHaveCount(0);
  await freshMenu
    .getByRole("menuitem", { name: "Thoughtful", exact: true })
    .click();
  await freshMenu
    .getByRole("menuitemradio", { name: "High", exact: true })
    .click();
  await expect(fresh.locator(".model-summary")).toHaveText(
    "Claude Code · Thoughtful · High",
  );
  await expect(fresh.locator(".provider-card.chosen")).toContainText(
    "Thoughtful · High",
  );
  await expect(fresh.getByLabel("Message your coding agent")).toBeFocused();
  await fresh.close();

  // An empty catalog can still be backed out of or opened in Connections.
  app.controller.providers = app.controller.providers.map((p) =>
    p.id === "cursor" ? { ...p, models: [] } : p,
  );
  app.controller.event(null, null, "providers", {
    providers: app.controller.providers,
  });
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Cursor", exact: true }).click();
  await expect(page.locator(".model-menu-empty")).toContainText(
    "No models available for Cursor",
  );
  await page
    .locator(".model-menu-empty")
    .getByRole("button", { name: "Connections & usage", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    "Model menu checks passed: provider/model/effort hierarchy, keyboard and touch, cancellation, disabled and empty models, saved selections, and correct send payloads.",
  );
} finally {
  await browser?.close();
  await app.close();
}
