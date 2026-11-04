// Real browser and HTTP, simulated CI and providers: no inference or GitHub writes.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHarness } from "../src/server.mjs";

await mkdir(".local/screenshots", { recursive: true });
const dataDir = await mkdtemp(resolve(".local/watchers-")),
  projectPath = join(dataDir, "project");
await mkdir(projectPath);
let now = Date.now(),
  reads = 0,
  modelCalls = 0,
  watch,
  mode = "notify",
  state = "pending";
const sha = "a".repeat(40);
const app = await createHarness({
  dataDir,
  port: 0,
  startProviders: false,
  watcherOptions: {
    now: () => now,
    github: {
      read: async () => {
        reads++;
        return {
          status: state,
          identity: sha,
          sha,
          url: "https://github.com/owner/repo/commit/" + sha,
          items: [
            {
              id: "tests",
              name: "Unit tests",
              state,
              url: "https://github.com/owner/repo/actions/runs/123",
            },
          ],
        };
      },
    },
  },
});
app.store.now = () => new Date(now).toISOString();
app.controller.worktreeRoot = null;
app.controller.providers = [
  {
    id: "codex",
    name: "Codex",
    connected: true,
    models: [{ id: "fixture", name: "Fixture", efforts: [] }],
  },
];
const project = app.store.addProject("Watcher acceptance", projectPath);
app.controller.runners.codex = async (ctx) => {
  modelCalls++;
  if (ctx.text === "Register CI") {
    if (mode === "goal") ctx.goalState("active", "Make CI pass");
    watch = await ctx.history("watch_github_ci", {
      repository: "owner/repo",
      commit: sha,
      ...(mode === "goal"
        ? {
            resumeOn: ["complete"],
            continuation: "Fix failures and assess the saved goal.",
          }
        : {}),
    });
    ctx.emit("text", {
      nativeId: randomUUID(),
      text: "CI watcher registered.",
    });
    if (mode === "goal") {
      await ctx.history("yield_to_watch", {
        ids: [watch.id],
        checkpoint: "The patch is pushed; wait for CI.",
      });
      await new Promise((resolve) =>
        ctx.signal.addEventListener("abort", resolve, { once: true }),
      );
      ctx.watchParked();
      return { status: "cancelled" };
    }
  } else {
    ctx.emit("text", {
      nativeId: randomUUID(),
      text: "Watcher follow-up reviewed.",
    });
    if (ctx.mode === "goal") ctx.goalState("complete");
  }
  return { status: "completed" };
};
const create = async (title, chatMode = "default") => {
  const chat = app.store.createConversation({
    projectId: project.id,
    title,
    mode: chatMode,
    provider: "codex",
    model: "fixture",
  });
  app.controller.send(chat.id, {
    actionId: randomUUID(),
    text: "Register CI",
    mode: chatMode,
    provider: "codex",
    model: "fixture",
  });
  await app.controller.active.get(chat.id).task;
  return chat;
};
const settle = async () => {
  // Observe twice at the normal host interval, without waiting a real minute.
  now += 60_000;
  await app.controller.watchers.tick();
  now += 60_000;
  await app.controller.watchers.tick();
  await Promise.all([...app.controller.active.values()].map((a) => a.task));
};
let browser;
const errors = [];
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const chat = await create("Notification-only CI");
  await page.goto(
    `${app.runtime.origin}/?chat=${chat.id}#pair=${app.auth.pairing()}`,
  );
  const cards = page.getByRole("region", { name: "Background CI watchers" });
  await expect(cards).toContainText("Connecting to GitHub");
  await app.controller.watchers.tick();
  await expect(cards).toContainText("Waiting for CI");
  await expect(cards).toContainText("Notification only");
  await expect(cards.getByRole("link", { name: "Unit tests" })).toBeVisible();
  const card = cards.getByRole("article");
  await expect(card).toHaveCSS("border-top-width", "3px");
  await expect(card).toHaveCSS("border-top-color", "rgb(61, 123, 255)");
  await expect(cards.getByRole("img", { name: "Watching CI" })).toBeVisible();
  await expect(
    page
      .getByLabel("Active chats")
      .getByRole("img", { name: "Notification-only CI: Watching CI" }),
  ).toBeVisible();
  expect(modelCalls).toBe(1);
  await expect(
    page.getByRole("button", { name: "Stop work", exact: true }),
  ).toHaveCount(0);
  // The page can go away while host bookkeeping continues.
  await page.goto("about:blank");
  state = "success";
  await settle();
  expect(app.store.conversation(chat.id).unread).toBe(true);
  expect(modelCalls).toBe(1);
  await page.goto(`${app.runtime.origin}/?chat=${chat.id}`);
  await expect(cards).toContainText("CI passed");
  await expect(cards.getByRole("link", { name: "Unit tests" })).toBeVisible();
  await expect(card).toHaveCSS("border-top-width", "3px");
  await expect(card).toHaveCSS("border-top-color", "rgb(79, 209, 139)");
  await page.reload();
  await expect(cards).toContainText("CI passed");
  await expect(cards.getByRole("link", { name: "Unit tests" })).toBeVisible();
  await expect(card).toHaveCSS("border-top-color", "rgb(79, 209, 139)");
  await cards
    .getByRole("button", { name: "Continue with agent", exact: true })
    .click();
  await expect(
    page.getByText("Watcher follow-up reviewed.", { exact: true }),
  ).toBeVisible();
  await expect(cards).toContainText("Follow-up sent to the agent");
  expect(modelCalls).toBe(2);

  state = "pending";
  const cancelChat = await create("Cancel CI watcher");
  await page.goto(`${app.runtime.origin}/?chat=${cancelChat.id}`);
  await cards
    .getByRole("button", { name: "Cancel watch", exact: true })
    .click();
  await expect(cards).toContainText("Watch cancelled");
  expect(app.store.watchStore.get(watch.id).armed).toBe(false);

  mode = "goal";
  const goalChat = await create("Goal waits for CI", "goal");
  await page.goto(`${app.runtime.origin}/?chat=${goalChat.id}`);
  // An armed watch continues the Goal, so the resume box stays hidden.
  await expect(
    page.getByText("Goal waiting for CI.", { exact: true }),
  ).toHaveCount(0);
  await expect(cards).toContainText("Authorized follow-up is armed");
  await expect(
    page.getByRole("button", { name: "Stop work", exact: true }),
  ).toBeVisible();
  const before = modelCalls;
  state = "failure";
  await settle();
  await expect(cards).toContainText("CI failed");
  await expect(cards.getByRole("link", { name: "Unit tests" })).toBeVisible();
  await expect(card).toHaveCSS("border-top-width", "3px");
  await expect(card).toHaveCSS("border-top-color", "rgb(255, 92, 92)");
  await expect(
    page.getByText("Watcher follow-up reviewed.", { exact: true }),
  ).toBeVisible();
  expect(modelCalls).toBe(before + 1);
  expect(app.store.conversation(goalChat.id).sessions.codex.goal.status).toBe(
    "complete",
  );
  await page.screenshot({
    path: ".local/screenshots/watchers.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cards).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/watchers-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    `Watcher acceptance passed: ${reads} host polls, notification-only completion, unread results, reload, manual continuation, cancellation, Goal suspension/resumption and mobile layout. Providers and CI were simulated.`,
  );
} finally {
  await browser?.close();
  await app.close();
}
