// Real browser and HTTP with simulated providers; no inference or user data.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHarness } from "../src/server.mjs";

await mkdir(".local/screenshots", { recursive: true });
const dataDir = await mkdtemp(resolve(".local/goal-progress-")), projectPath = join(dataDir, "project");
await mkdir(projectPath);
const app = await createHarness({ dataDir, port: 0, startProviders: false });
app.controller.worktreeRoot = null;
app.controller.providers = ["codex", "claude"].map((id) => ({
  id, name: id === "codex" ? "Codex" : "Claude Code", connected: true,
  models: [{ id: "fixture", name: "Fixture", efforts: [] }],
}));
const project = app.store.addProject("Goal progress acceptance", projectPath), errors = [];
let browser, context, release, entered, modelCalls = 0;
for (const provider of ["codex", "claude"])
  app.controller.runners[provider] = async (ctx) => {
    modelCalls++;
    context = ctx;
    ctx.goalState("active", "Ship the parser");
    const done = Promise.withResolvers();
    release = done.resolve;
    ctx.emit("text", { nativeId: crypto.randomUUID(), text: "Inspecting the parser." });
    entered.resolve();
    await done.promise;
    return { status: "completed" };
  };
const start = async (chat, extra = {}) => {
  entered = Promise.withResolvers();
  const run = app.controller.send(chat.id, {
    actionId: crypto.randomUUID(), text: "Ship the parser", provider: chat.provider,
    model: "fixture", ...extra,
  });
  await entered.promise;
  return run;
};
const finish = async (status) => {
  context.goalState(status);
  const task = app.controller.active.get(context.chat.id).task;
  release();
  await task;
};
const record = (items, explanation = "") => {
  if (context.chat.provider === "claude") {
    const id = crypto.randomUUID();
    context.emit("work", { kind: "tool", provider: "claude", item: {
      id, name: "TodoWrite", input: { todos: items.map(({ step, status }) => ({ content: step, status: status === "inProgress" ? "in_progress" : status })) },
    } });
    context.emit("work", { kind: "tool-result", provider: "claude", toolUseId: id, isError: false });
  } else context.emit("work", { kind: "plan", plan: items, explanation });
};

try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const chat = app.store.createConversation({ projectId: project.id, title: "Parser progress", provider: "codex", model: "fixture", mode: "goal" });
  await page.goto(`${app.runtime.origin}/?chat=${chat.id}#pair=${app.auth.pairing()}`);
  const strip = page.getByRole("region", { name: "Goal progress", exact: true }), summary = strip.locator("summary");
  await expect(strip).toContainText("Waiting for the agent to record phases");
  const first = await start(chat);
  const plan = [
    { step: "Inspect the parser", status: "completed" },
    { step: "Implement the fix", status: "inProgress" },
    { step: "Verify and deliver", status: "pending" },
  ];
  record(plan, "Parser investigation is complete.");
  await expect(summary).toContainText("1 of 3 phases complete");
  await expect(summary).toContainText("Implement the fix");
  await summary.focus();
  await summary.press("Enter");
  await expect(strip.getByRole("list", { name: "Goal phases" })).toBeVisible();
  await expect(strip.locator("li")).toHaveCount(3);
  await expect(strip).toContainText("Parser investigation is complete.");
  await expect(strip.locator("time")).toContainText("Last updated");
  record([...plan, { step: "Check the discovered compatibility case", status: "pending" }], "Discovery added a compatibility check.");
  await expect(summary).toContainText("1 of 4 phases complete");
  await expect(strip).toContainText("Discovery added a compatibility check.");

  // A long transcript scrolls independently of the progress strip and composer.
  for (let n = 0; n < 16; n++) context.emit("text", { nativeId: `history-${n}`, text: `Investigation note ${n}.\n\n${"Detailed findings. ".repeat(30)}` });
  await expect(page.getByText("Investigation note 15.", { exact: false })).toBeVisible();
  await page.locator(".messages").evaluate((node) => { node.scrollTop = 0; });
  await expect(summary).toBeInViewport();
  await expect(page.getByLabel("Message your coding agent")).toBeInViewport();
  await page.screenshot({ path: ".local/screenshots/goal-progress-desktop.png" });

  await finish("paused");
  await expect(summary).toContainText("Paused");
  await expect(strip.locator(".pulse-dot")).toHaveCount(0);
  await page.reload();
  await expect(summary).toContainText("1 of 4 phases complete");
  await expect(summary).toContainText("Paused");
  const resumed = await start(chat, { resumeGoal: true });
  expect(app.store.conversation(chat.id).goalProgress.goalId).toBe(first.id);
  expect(resumed.id).not.toBe(first.id);
  expect(context.addendum).toContain("[completed] Inspect the parser");
  await finish("complete");
  await expect(summary).toContainText("4 of 4 phases complete");
  await expect(summary).toContainText("Goal complete");
  await summary.click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(summary).toBeInViewport();
  await expect(page.getByLabel("Message your coding agent")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".local/screenshots/goal-progress-mobile.png" });
  await page.setViewportSize({ width: 720, height: 800 });
  await expect(strip).toBeInViewport();

  // Claude uses its native todo list; a replacement Goal starts empty.
  await page.setViewportSize({ width: 1512, height: 982 });
  const claude = app.store.createConversation({ projectId: project.id, title: "Claude progress", provider: "claude", model: "fixture", mode: "goal" });
  await page.goto(`${app.runtime.origin}/?chat=${claude.id}`);
  await start(claude);
  record(plan);
  await expect(summary).toContainText("1 of 3 phases complete");
  await finish("paused");
  await start(claude);
  await expect(summary).toContainText("Waiting for the agent to record phases");
  await finish("complete");
  await expect(summary).toContainText("Goal complete");
  const ordinary = app.store.createConversation({ projectId: project.id, title: "Ordinary chat", provider: "codex", model: "fixture" });
  await page.goto(`${app.runtime.origin}/?chat=${ordinary.id}`);
  await expect(page.getByLabel("Message your coding agent")).toBeVisible();
  await expect(strip).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(modelCalls).toBe(4);
  console.log("Goal progress acceptance passed: both providers, live phase revisions, keyboard expansion, scrolling, reload, pause/resume, completion, replacement Goal, mobile and narrow layouts. No inference was used.");
} finally {
  release?.();
  await browser?.close();
  await app.close();
}
