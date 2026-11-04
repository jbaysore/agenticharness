// Real browser and HTTP, simulated provider: no inference.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHarness } from "../src/server.mjs";

await mkdir(".local/screenshots", { recursive: true });
const dataDir = await mkdtemp(resolve(".local/owner-pause-")),
  projectPath = join(dataDir, "project");
await mkdir(projectPath);
const prompts = [];
const app = await createHarness({
  dataDir,
  port: 0,
  startProviders: false,
});
app.controller.worktreeRoot = null;
app.controller.providers = [
  {
    id: "codex",
    name: "Codex",
    connected: true,
    models: [{ id: "fixture", name: "Fixture", efforts: [] }],
  },
];
app.controller.runners.codex = async (ctx) => {
  prompts.push(ctx.text);
  if (ctx.text.startsWith("Block on the owner")) {
    ctx.goalState("active", "Ship the release");
    await ctx.history("pause_for_owner", {
      statement: "Merge pull request 18, then come back.",
    });
    await new Promise((resolve) =>
      ctx.signal.addEventListener("abort", resolve, { once: true }),
    );
    ctx.ownerParked();
    return { status: "cancelled" };
  }
  ctx.emit("text", { nativeId: randomUUID(), text: "Goal continued." });
  ctx.goalState("complete");
  return { status: "completed" };
};
const project = app.store.addProject("Owner pause", projectPath);
const create = async (title) => {
  const chat = app.store.createConversation({
    projectId: project.id,
    title,
    mode: "goal",
    provider: "codex",
    model: "fixture",
  });
  app.controller.send(chat.id, {
    actionId: randomUUID(),
    text: "Block on the owner",
    mode: "goal",
    provider: "codex",
    model: "fixture",
  });
  await app.controller.active.get(chat.id).task;
  return chat;
};
let browser;
const errors = [];
try {
  const done = await create("Confirm owner pause");
  const denied = await create("Deny owner pause");
  const other = await create("Other owner pause");
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const open = (chat) =>
    page.goto(`${app.runtime.origin}/?chat=${chat.id}#pair=${app.auth.pairing()}`);
  const card = page.getByRole("region", { name: "Waiting on you" });

  await open(done);
  await expect(card).toContainText("Merge pull request 18");
  await expect(page.getByRole("button", { name: "Resume goal", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(card).toContainText("Merge pull request 18");
  await expect(
    page.getByLabel("Active chats").getByRole("img", { name: "Confirm owner pause: Waiting on you" }),
  ).toBeVisible();
  await card.getByRole("button", { name: "I've done this", exact: true }).click();
  await expect(page.getByText("Goal continued.", { exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
  assertPrompt(/confirmed this is complete/);

  await open(denied);
  await card.getByRole("button", { name: "Deny", exact: true }).click();
  const resume = card.getByRole("button", { name: "Resume goal", exact: true });
  await expect(resume).toBeDisabled();
  await card.getByLabel("Why not?").fill("The pull request needs another review.");
  await expect(resume).toBeEnabled();
  await resume.click();
  await expect(page.getByText("Goal continued.", { exact: true })).toBeVisible();
  assertPrompt(/Denied/);
  assertPrompt(/another review/);

  await open(other);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Other", exact: true }).click();
  await card.getByLabel("What should happen instead?").fill("Close it and open a follow-up.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/owner-pause-mobile.png",
    fullPage: true,
  });
  await card.getByRole("button", { name: "Resume goal", exact: true }).click();
  await expect(page.getByText("Goal continued.", { exact: true })).toBeVisible();
  assertPrompt(/Other/);
  assertPrompt(/follow-up/);
  expect(errors).toEqual([]);
  console.log(
    "Owner pause checks passed: persisted card, confirm, deny with a reason, Other with a reason, and mobile layout. The provider was simulated.",
  );
} finally {
  await browser?.close();
  await app.close();
}

function assertPrompt(pattern) {
  if (!prompts.some((text) => pattern.test(text)))
    throw new Error(`Missing resumed prompt ${pattern}`);
}
