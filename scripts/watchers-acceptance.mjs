// Real browser and HTTP, simulated CI and providers: no inference or GitHub writes.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
let commandDone = true,
  failFollowup = false;
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
      readPull: async () => ({
        status: "pending",
        reason: null,
        cursor: { commentId: 1, reviewCommentId: 0, reviews: {}, head: sha },
        items: [],
        sha,
        url: "https://github.com/owner/repo/pull/4",
      }),
    },
    commands: {
      start: async () => ({
        pid: 7,
        createdAt: "2020-01-01T00:00:00.000Z",
        statusDir: join(dataDir, "command"),
      }),
      read: async () => ({
        done: commandDone,
        exitCode: 0,
        output: "Build progress: 10 of 100\n" + "x".repeat(5000),
        outputBytes: 5026,
        heartbeatAt: now,
        lastOutputAt: now,
      }),
      identity: async () => ({ pid: 7, createdAt: "2020-01-01T00:00:00.000Z" }),
      killIfMatched: async () => ({ killed: false }),
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
    if (mode === "goal") {
      ctx.goalState("active", "Make CI pass");
      ctx.emit("work", {
        kind: "plan",
        plan: [
          { step: "Push the fix", status: "completed" },
          { step: "Check CI", status: "inProgress" },
        ],
      });
    }
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
  } else if (ctx.text === "Register local watches") {
    await ctx.history("watch_command", {
      command: "echo watched",
      shell: "cmd",
    });
    await ctx.history("watch_pull_request", {
      repository: "owner/repo",
      pr: 4,
    });
    await writeFile(join(projectPath, "ready.txt"), "hello");
    await ctx.history("watch_file", { path: "ready.txt", until: "appears" });
    ctx.emit("text", {
      nativeId: randomUUID(),
      text: "Local watches registered.",
    });
  } else if (ctx.text === "Register live command") {
    watch = await ctx.history("watch_command", {
      command: "echo progress",
      shell: "cmd",
      resumeOn: ["complete"],
      continuation: "Verify the build result.",
      reviewAfterMinutes: 6,
    });
    await writeFile(join(projectPath, "progress.log"), "10 of 100 processed\n");
    await ctx.history("watch_file", {
      path: "progress.log",
      until: "matches",
      pattern: "DONE",
    });
    await ctx.history("yield_to_watch", {
      ids: [watch.id],
      checkpoint: "The build is running.",
    });
    await new Promise((resolve) =>
      ctx.signal.addEventListener("abort", resolve, { once: true }),
    );
    ctx.watchParked();
    return { status: "cancelled" };
  } else {
    if (failFollowup)
      return {
        status: "failed",
        error: "Simulated provider connection failure",
      };
    ctx.emit("text", {
      nativeId: randomUUID(),
      text: "Watcher follow-up reviewed.",
    });
    if (ctx.mode === "goal") {
      expect(ctx.addendum).toContain("[completed] Push the fix");
      expect(ctx.addendum).toContain("[in_progress] Check CI");
      ctx.goalState("complete");
    }
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
  const cards = page.getByRole("region", { name: "Background watchers" });
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
  await expect(cards).toContainText("Agent follow-up completed");
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
  const progress = page.getByRole("region", {
    name: "Goal progress",
    exact: true,
  });
  await expect(progress).toContainText("1 of 2 phases complete");
  await expect(progress).toContainText("Waiting for CI");
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
  await expect(progress).toContainText("2 of 2 phases complete");
  await expect(progress).toContainText("Goal complete");
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
  const local = app.store.createConversation({
    projectId: project.id,
    title: "Local watches",
    provider: "codex",
    model: "fixture",
    permissions: "override",
  });
  app.controller.send(local.id, {
    actionId: randomUUID(),
    text: "Register local watches",
    provider: "codex",
    model: "fixture",
  });
  await app.controller.active.get(local.id).task;
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto(`${app.runtime.origin}/?chat=${local.id}`);
  await app.controller.watchers.tick();
  now += 5_000;
  await app.controller.watchers.tick();
  await expect(cards).toContainText("Command finished");
  await expect(cards).toContainText("Waiting for pull request");
  await expect(cards).toContainText("File condition met");
  await expect(
    cards.getByRole("img", { name: "Watching pull request" }),
  ).toBeVisible();
  commandDone = false;
  const live = app.store.createConversation({
    projectId: project.id,
    title: "Live watch progress",
    provider: "codex",
    model: "fixture",
    permissions: "override",
  });
  app.controller.send(live.id, {
    actionId: randomUUID(),
    text: "Register live command",
    provider: "codex",
    model: "fixture",
  });
  await app.controller.active.get(live.id).task;
  await app.controller.watchers.tick();
  const liveCommand = app.store.watchStore.get(watch.id);
  expect(liveCommand.reviewAt).toBe(liveCommand.reviewedAt + 360_000);
  await page.goto(`${app.runtime.origin}/?chat=${live.id}`);
  await expect(cards).toContainText("Last activity:");
  await expect(cards).toContainText("Runner heartbeat:");
  await expect(cards).toContainText("Agent review:");
  await expect(cards).toContainText("File present");
  await cards.getByText("Latest command output", { exact: true }).click();
  await cards.getByText("Latest file output", { exact: true }).click();
  await expect(
    cards.locator("pre").filter({ hasText: "Build progress: 10 of 100" }),
  ).toBeVisible();
  await expect(
    cards.locator("pre").filter({ hasText: "10 of 100 processed" }),
  ).toBeVisible();
  await page.reload();
  await expect(cards).toContainText("Latest command output");
  // Freeze only the fixture's host clock to verify that the browser warns
  // about an overdue check even when the watcher produces no new events.
  app.controller.watchers.started = false;
  clearTimeout(app.controller.watchers.timer);
  const overdue = app.store.watchStore.get(watch.id);
  overdue.nextCheckAt = Date.now() - 60_000;
  overdue.lastCheckedAt = Date.now() - 65_000;
  app.controller.watchers.save(overdue);
  await expect(cards).toContainText("Monitoring check overdue");
  overdue.nextCheckAt = now;
  app.controller.watchers.save(overdue);
  app.controller.watchers.started = true;
  failFollowup = true;
  commandDone = true;
  now += 5_000;
  await app.controller.watchers.tick();
  await Promise.all([...app.controller.active.values()].map((a) => a.task));
  await expect(cards.filter({ hasText: "echo progress" })).toContainText(
    "Agent follow-up failed: Simulated provider connection failure",
  );
  await expect(
    cards.getByRole("button", { name: "Continue with agent", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await cards.getByText("Latest command output", { exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/watchers-progress-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    `Watcher acceptance passed: ${reads} host polls, notification-only completion, unread results, reload, manual continuation, cancellation, Goal suspension/resumption, live command and file progress, failed follow-up and mobile layout. Providers and CI were simulated.`,
  );
} finally {
  await browser?.close();
  await app.close();
}
