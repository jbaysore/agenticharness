// Real browser audio and isolated completion events; no provider calls.
import { chromium, expect, devices } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";

await mkdir(".local/screenshots", { recursive: true });
const app = await createHarness({
  dataDir: await mkdtemp(resolve(".local/turn-sound-")),
  port: 0,
  startProviders: false,
});
const project = app.store.addProject("Sound fixture", process.cwd());
const foreground = app.store.createConversation({ projectId: project.id });
const background = app.store.createConversation({ projectId: project.id });
let action = 0;
function finish(chat = background, status = "completed", provider = "codex") {
  const run = app.store.createRun({
    conversationId: chat.id,
    actionId: `sound-fixture-${++action}`,
    provider,
    model: "fixture",
    text: "Sound fixture",
  });
  app.store.setRun(run.id, status);
  app.controller.event(chat.id, run.id, "run", { status, provider });
  return run;
}
finish(foreground); // Loading old completed turns must stay silent.
const errors = [];
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1512, height: 982 },
  });
  await context.addInitScript(() => {
    window.soundStarts = [];
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...args) {
      window.soundStarts.push(this.frequency.value);
      return start.apply(this, args);
    };
    // Observe delivery without replacing the app's EventSource or audio APIs.
    const Stream = window.EventSource;
    window.EventSource = class extends Stream {
      constructor(...args) {
        super(...args);
        window.soundStream = this;
        this.addEventListener("open", () => {
          window.soundConnected = true;
        });
        this.addEventListener("message", (event) => {
          window.soundLastEvent = event.data;
        });
      }
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const visit = async (target) => {
    await target.goto(`${app.runtime.origin}/?chat=${foreground.id}`);
    await expect(target.locator(".context-trigger")).toBeVisible();
  };
  const openSettings = async (target) => {
    const sidebar = target.getByRole("button", {
      name: "Show sidebar",
      exact: true,
    });
    if (await sidebar.isVisible()) await sidebar.click();
    await target.getByRole("button", { name: "Connections & usage" }).click();
  };
  const toggle = (target) =>
    target.getByRole("checkbox", {
      name: "Play a sound when an agent finishes",
    });
  const count = () => page.evaluate(() => window.soundStarts.length);
  const delivered = async (target = page) => {
    const id = app.store.latestEventId();
    await expect
      .poll(() =>
        target.evaluate(() => JSON.parse(window.soundLastEvent ?? "{}").id),
      )
      .toBe(id);
  };
  await visit(page);
  await page.waitForFunction(() => window.soundConnected);
  finish();
  await delivered();
  expect(await count()).toBe(0); // No gesture: never queue a delayed chime.
  await openSettings(page);
  await expect(toggle(page)).toBeChecked();
  expect(await count()).toBe(0);
  await page.getByRole("button", { name: "Preview sound" }).click();
  await expect.poll(count).toBe(2);
  expect(await page.evaluate(() => window.soundStarts)).toEqual([660, 880]);

  for (const provider of ["codex", "claude", "cursor"]) {
    const before = await count();
    finish(
      provider === "codex" ? foreground : background,
      "completed",
      provider,
    );
    await expect.poll(count).toBe(before + 2);
  }
  // Duplicate deliveries, progress and stopped/failed turns never add sounds.
  await page.evaluate(() =>
    window.soundStream.dispatchEvent(
      new MessageEvent("message", { data: window.soundLastEvent }),
    ),
  );
  for (const status of ["running", "failed", "cancelled", "interrupted"]) {
    const run = finish(background, status);
    await delivered();
    if (status === "running") app.store.setRun(run.id, "cancelled");
  }
  expect(await count()).toBe(8);
  await toggle(page).uncheck();
  finish();
  await delivered();
  expect(await count()).toBe(8);
  await page.getByRole("button", { name: "Preview sound" }).click();
  await expect.poll(count).toBe(10); // Preview still works while muted.
  await page.reload();
  await openSettings(page);
  await expect(toggle(page)).not.toBeChecked();
  expect(await count()).toBe(0);
  await toggle(page).check(); // Also unlocks audio when this visit began muted.
  finish();
  await expect.poll(count).toBe(2);

  const other = await context.newPage();
  await visit(other);
  await openSettings(other);
  await toggle(page).uncheck();
  await expect(toggle(other)).not.toBeChecked();
  await other.close();
  await page
    .locator(".sound-settings")
    .screenshot({ path: ".local/screenshots/turn-sound-desktop.png" });

  const phone = await browser.newPage({ ...devices["iPhone 13"] });
  phone.on("pageerror", (error) => errors.push(error.message));
  await visit(phone);
  await openSettings(phone);
  await expect(toggle(phone)).toBeChecked(); // A different device keeps its own preference.
  await expect(
    phone.getByRole("button", { name: "Preview sound" }),
  ).toBeVisible();
  expect(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await phone
    .locator(".sound-settings")
    .screenshot({ path: ".local/screenshots/turn-sound-mobile.png" });

  const unsupported = await browser.newPage();
  unsupported.on("pageerror", (error) => errors.push(error.message));
  await unsupported.addInitScript(() => {
    window.AudioContext = undefined;
    window.webkitAudioContext = undefined;
  });
  await visit(unsupported);
  await openSettings(unsupported);
  await unsupported.getByRole("button", { name: "Preview sound" }).click();
  finish();
  await expect(toggle(unsupported)).toBeChecked();
  expect(errors).toEqual([]);
  console.log(
    "Turn sound passed: real Web Audio, all providers, background chats, duplicate delivery, mute/reload/sync, preview, mobile and unavailable audio. No provider inference.",
  );
} finally {
  await browser?.close();
  await app.close();
}
