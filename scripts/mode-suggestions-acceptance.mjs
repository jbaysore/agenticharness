// Real browser and HTTP, simulated providers; no inference.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";

await mkdir(".local/screenshots", { recursive: true });
const dir = await mkdtemp(resolve(".local/mode-suggestions-"));
const app = await createHarness({
  dataDir: dir,
  port: 0,
  startProviders: false,
  seedProject: dir,
});
app.controller.providers = ["codex", "claude", "cursor"].map((id) => ({
  id,
  name: id,
  connected: true,
  models: [{ id: "fixture", name: "Mode suggestion fixture", efforts: [] }],
}));
let browser,
  target = "plan";
const contexts = [],
  errors = [];
const reason =
  "Planning first will let you review the parser changes before implementation.";
const objective = "The parser tests pass and the change is delivered.";
for (const { id } of app.controller.providers)
  app.controller.runners[id] = async (ctx) => {
    contexts.push(ctx);
    ctx.saveSession({ id: "saved-" + id });
    ctx.promptAccepted();
    // The stand-ins report native Goal state as the real adapters do.
    if (id !== "cursor")
      ctx.goalState(ctx.mode === "goal" ? "complete" : "cleared");
    if (!ctx.continuing)
      await ctx.history("suggest_mode", {
        mode: target,
        reason,
        ...(target === "goal" && { objective }),
      });
    return { status: "completed" };
  };
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.runtime.origin);
  const approval = page.locator(".approval");
  const suggest = async (provider, mode, next, permissions) => {
    target = next;
    await chooseModel(page, app.controller.providers, provider, "fixture");
    await page.getByLabel("Mode", { exact: true }).selectOption(mode);
    await page
      .getByLabel("Permissions", { exact: true })
      .selectOption(permissions);
    await page
      .getByLabel("Message your coding agent")
      .fill("Improve the parser");
    await page.getByLabel("Send message").click();
    await expect(approval).toBeVisible();
    await expect(approval.getByText(reason, { exact: true })).toBeVisible();
    await expect(page.getByLabel("Mode", { exact: true })).toHaveValue(mode);
  };
  const finished = async (mode) => {
    await expect(approval).toHaveCount(0);
    await expect(page.getByLabel("Stop work")).toHaveCount(0);
    await expect(page.getByLabel("Mode", { exact: true })).toHaveValue(mode);
  };

  // Override must still show a manual decision, and declining resumes normally.
  await suggest("codex", "default", "plan", "override");
  await approval
    .getByRole("button", { name: "Keep current mode", exact: true })
    .click();
  await finished("default");
  expect(contexts).toHaveLength(1);

  // An Ask-mode agent can propose an approved change to Plan.
  await suggest("cursor", "ask", "plan", "auto");
  await approval
    .getByRole("button", { name: "Approve mode change", exact: true })
    .click();
  await finished("plan");
  expect(contexts.at(-1).session.id).toBe("saved-cursor");
  expect(contexts.at(-1).mode).toBe("plan");

  // Plan to Goal shows the exact termination condition, also on a phone.
  await suggest("claude", "plan", "goal", "override");
  await expect(approval.getByText(objective, { exact: false })).toBeVisible();
  await page.screenshot({
    path: ".local/screenshots/mode-suggestions-desktop.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await approval.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await approval.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/mode-suggestions-phone.png",
    fullPage: true,
  });

  // Failed saves keep the suggestion available for retry without changing mode.
  await page.route("**/api/approvals/*", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Fixture approval failed" }),
    }),
  );
  const approve = approval.getByRole("button", {
    name: "Approve mode change",
    exact: true,
  });
  await approve.click();
  await expect(approval.getByText("Fixture approval failed")).toBeVisible();
  await expect(approve).toBeEnabled();
  await expect(page.getByLabel("Mode", { exact: true })).toHaveValue("plan");
  await page.unroute("**/api/approvals/*");
  await approve.click();
  await finished("goal");
  expect(contexts.at(-1).goalObjective).toBe(objective);
  expect(contexts.at(-1).startGoal).toBe(true);
  expect(contexts.at(-1).session.id).toBe("saved-claude");
  expect(errors).toEqual([]);
  console.log(
    "Mode suggestion checks passed: manual approval under Override and Auto-review, decline, Ask to Plan, Plan to Goal, session continuity, exact goal objective, retry, desktop and phone. Providers simulated; no inference.",
  );
} finally {
  await browser?.close();
  await app.close();
}
