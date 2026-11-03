// Real settings UI and HTTP with simulated reviewers; no inference.
import { chromium, expect, devices } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";
import { WorkerUnavailable } from "../src/providers/workers.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";

await mkdir(".local/screenshots", { recursive: true });
const app = await createHarness({
  dataDir: await mkdtemp(resolve(".local/reviewer-settings-ui-")),
  port: 0,
  startProviders: false,
  seedProject: process.cwd(),
});
app.controller.providers = [
  {
    id: "cursor",
    name: "Cursor",
    connected: true,
    models: [{ id: "cursor", name: "Cursor fixture", efforts: [] }],
  },
  {
    id: "codex",
    name: "Codex",
    connected: true,
    models: [
      {
        id: "catalog-default",
        name: "Visible default",
        isDefault: true,
        efforts: [],
      },
      { id: "pinned", name: "Chosen Codex", efforts: ["low", "high"] },
      { id: "another", name: "Another Codex", efforts: ["low", "high"] },
    ],
  },
  {
    id: "claude",
    name: "Claude Code",
    connected: true,
    models: [
      {
        id: "claude-default",
        name: "Visible Claude default",
        resolvedModel: "claude-resolved-default",
        isDefault: true,
        efforts: [],
      },
      { id: "chosen-claude", name: "Chosen Claude", efforts: ["low", "high"] },
    ],
  },
];
let ctx,
  exhausted = false,
  browser;
const jobs = [],
  errors = [];
app.controller.openReviewer = null;
for (const provider of ["codex", "claude"])
  app.controller.workers[provider] = async (job) => {
    jobs.push({ provider, ...job });
    if (provider === "codex" && exhausted)
      throw new WorkerUnavailable("Codex included usage exhausted");
    return {
      text: JSON.stringify({
        decision: "allow",
        reason: "Approved fixture action",
      }),
    };
  };
app.controller.runners.cursor = async (current) => {
  ctx = current;
  await ctx.approve({
    kind: "question",
    title: "Fixture question",
    questions: [{ id: "file", question: "Which file?" }],
  });
  return { status: "cancelled" };
};
const request = (title) => ({
  kind: "permission",
  method: "session/request_permission",
  title,
  details: { rawInput: { command: title } },
});
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.runtime.origin);
  const openSettings = async (target) => {
    await expect(
      target.getByLabel("Permissions", { exact: true }),
    ).toBeVisible();
    const sidebar = target.getByRole("button", {
      name: "Show sidebar",
      exact: true,
    });
    if (await sidebar.isVisible()) await sidebar.click();
    await target
      .getByRole("button", { name: "Connections & usage", exact: true })
      .click();
    await expect(target.getByRole("dialog")).toBeVisible();
  };
  const save = async (target) => {
    await target
      .getByRole("button", { name: "Save reviewing agents", exact: true })
      .click();
    await expect(
      target.getByText("Saved. Reviewer choices apply to the next review.", { exact: true }),
    ).toContainText("Saved.");
  };
  await openSettings(page);
  const codex = page.getByLabel("Auto-review Codex model", { exact: true }),
    claude = page.getByLabel("Auto-review Claude Code model", { exact: true });
  await expect(codex.locator('option[value=""]')).toHaveText(
    "Provider default: Visible default (catalog-default)",
  );
  await expect(claude.locator('option[value=""]')).toHaveText(
    "Provider default: Visible Claude default (claude-resolved-default)",
  );
  await codex.selectOption("codex|pinned");
  await page.getByLabel("Auto-review Codex model effort").selectOption("high");
  await claude.selectOption("claude|chosen-claude");
  await page.getByLabel("Auto-review Claude Code model effort").selectOption("low");
  await expect(page.getByLabel("Use Auto-review fallback")).toBeChecked();
  await expect(page.getByLabel("Auto-review provider", { exact: true })).toHaveValue("codex");
  await expect(page.getByLabel("Plan review provider", { exact: true })).toHaveValue("independent");
  await page.getByLabel("Plan review provider", { exact: true }).selectOption("claude");
  await page.getByLabel("Plan review Claude Code model", { exact: true }).selectOption("claude|chosen-claude");
  await page.getByLabel("Plan review Claude Code model effort").selectOption("high");
  await page.getByLabel("Use plan review fallback").uncheck();
  await save(page);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await chooseModel(page, app.controller.providers, "cursor", "cursor");
  await page.getByLabel("Message your coding agent").fill("Run fixture checks");
  await page.getByLabel("Send message").click();
  await expect(
    page.getByRole("heading", { name: "Fixture question", exact: true }),
  ).toBeVisible();
  expect((await ctx.approve(request("First check"))).allow).toBe(true);
  expect(jobs[0].model).toBe("pinned");
  expect(jobs[0].effort).toBe("high");

  // Changing the catalog default never replaces a pinned choice.
  app.controller.providers[1].models[0].isDefault = false;
  app.controller.providers[1].models[2].isDefault = true;
  app.controller.event(null, null, "providers", {
    providers: app.controller.providers,
  });
  await page.reload();
  await openSettings(page);
  await expect(page.getByLabel("Plan review provider", { exact: true })).toHaveValue("claude");
  await expect(page.getByLabel("Plan review Claude Code model effort")).toHaveValue("high");
  await expect(page.getByLabel("Use plan review fallback")).not.toBeChecked();
  await expect(codex).toHaveValue("codex|pinned");
  await expect(codex.locator('option[value=""]')).toContainText(
    "Another Codex",
  );
  await expect(page.getByLabel("Auto-review Codex model effort")).toHaveValue(
    "high",
  );
  await codex.selectOption("codex|another");
  await page.getByLabel("Auto-review Codex model effort").selectOption("low");
  await save(page);
  await page
    .locator(".connection")
    .filter({ has: page.getByRole("heading", { name: "Auto-review", exact: true }) })
    .screenshot({
      path: ".local/screenshots/reviewer-settings-desktop.png",
    });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  expect((await ctx.approve(request("Second check"))).allow).toBe(true);
  expect(jobs[1].model).toBe("another");
  expect(jobs[1].effort).toBe("low");

  exhausted = true;
  expect((await ctx.approve(request("Third check"))).allow).toBe(true);
  expect(jobs.at(-1).provider).toBe("claude");
  expect(jobs.at(-1).model).toBe("chosen-claude");
  expect(jobs.at(-1).effort).toBe("low");
  expect((await ctx.approve(request("Fourth check"))).allow).toBe(true);
  expect(jobs.filter((job) => job.provider === "codex")).toHaveLength(3);
  expect(jobs.filter((job) => job.provider === "claude")).toHaveLength(2);

  const chat = app.store.conversations()[0],
    phone = await browser.newPage({ ...devices["iPhone 13"] });
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(`${app.runtime.origin}/?chat=${chat.id}`);
  await openSettings(phone);
  await expect(
    phone.getByLabel("Auto-review Codex model", { exact: true }),
  ).toHaveValue("codex|another");
  await expect(
    phone.getByLabel("Auto-review Claude Code model", { exact: true }),
  ).toHaveValue("claude|chosen-claude");
  await expect(phone.getByLabel("Plan review Claude Code model effort")).toHaveValue("high");
  await phone.getByLabel("Use Auto-review fallback").uncheck();
  await save(phone);
  expect(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await phone
    .locator(".connection")
    .filter({ has: phone.getByRole("heading", { name: "Auto-review", exact: true }) })
    .screenshot({
      path: ".local/screenshots/reviewer-settings-phone.png",
    });
  await phone
    .locator(".connection")
    .filter({ has: phone.getByRole("heading", { name: "Independent plan review", exact: true }) })
    .screenshot({ path: ".local/screenshots/plan-review-settings-phone.png" });
  await phone
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await phone
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  const answer = await ctx.approve(request("No reviewer remains"));
  expect(answer.allow).toBe(false);
  expect(answer.reason).toContain("Codex included usage exhausted");
  expect(
    app.store.pendingApprovals(chat.id).map((a) => a.request.title),
  ).toEqual(["Fixture question"]);
  await expect(
    phone.getByRole("heading", { name: "No reviewer remains", exact: true }),
  ).toHaveCount(0);
  expect(jobs.filter((job) => job.provider === "claude")).toHaveLength(2);
  await openSettings(phone);
  await phone.getByLabel("Auto-review provider", { exact: true }).selectOption("claude");
  await save(phone);
  expect((await ctx.approve(request("Claude primary check"))).allow).toBe(true);
  expect(jobs.at(-1).provider).toBe("claude");
  expect(jobs.at(-1).effort).toBe("low");
  expect(app.store.setting("agent-rules").review.plan.claude.effort).toBe("high");
  await phone.getByRole("button", { name: "Close dialog", exact: true }).click();
  await phone.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await phone.getByLabel("Stop work").click();
  await expect.poll(() => app.store.activeRun(chat.id)).toBeFalsy();
  expect(errors).toEqual([]);
  console.log(
    "Reviewer settings passed: independent action/plan choices, configurable provider order, named defaults, pinned models/effort, persistence, mid-turn saves, fallback, exhausted-provider caching and mobile controls.",
  );
} finally {
  await browser?.close();
  await app.close();
}
