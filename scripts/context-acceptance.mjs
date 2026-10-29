// Isolated UI checks: fixture providers only, no account access or inference.
import assert from "node:assert/strict";
import { chromium, expect, devices } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";

const local = resolve(".local");
await mkdir(resolve(local, "screenshots"), { recursive: true });
const dataDir = await mkdtemp(resolve(local, "context-acceptance-"));
const app = await createHarness({ dataDir, port: 0, startProviders: false });
let browser;
const errors = [];
try {
  const project = app.store.addProject("Context fixtures", process.cwd());
  app.controller.providers = ["codex", "claude", "cursor"].map((id) => ({
    id,
    name: id,
    connected: true,
    models: [
      { id: "fixture", name: "Fixture model", efforts: [] },
      { id: "other", name: "Other model", efforts: [] },
    ],
  }));
  const chats = ["codex", "claude", "cursor", "codex"].map((provider, i) => {
    const chat = app.store.createConversation({
      projectId: project.id,
      provider,
      model: "fixture",
      title: `Context fixture ${i + 1}`,
    });
    const run = app.store.createRun({
      conversationId: chat.id,
      actionId: `context-fixture-${i}`,
      provider,
      model: "fixture",
      text: "Keep all required context and evidence.",
    });
    app.store.setRun(run.id, "completed");
    app.store.updateConversation(chat.id, {
      sessions: { [provider]: { id: `native-${i}` } },
    });
    app.controller.event(chat.id, run.id, "context-usage", {
      provider,
      sessionId: `native-${i}`,
      model: "fixture",
      generation: 0,
      usedTokens: i === 2 ? null : i === 3 ? 220000 : 84000,
      windowTokens: i === 2 ? null : 200000,
      state: i === 2 ? "unavailable" : "ready",
      source: "Fixture provider report",
      accuracy: i === 1 ? "provider-estimated" : "provider-reported",
      basis: "current-context",
      observedAt: new Date().toISOString(),
      cache: {
        inputTokens: 80000,
        cacheReadTokens: 72000,
        cacheWriteTokens: 0,
      },
    });
    return chat;
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1512, height: 982 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const url = (ids) =>
    `${app.runtime.origin}/?chat=${ids.join(",")}#pair=${app.auth.pairing()}`;
  await page.goto(url([chats[0].id]));
  const trigger = page.locator(".context-trigger");
  await expect(trigger).toContainText("Context 42%");
  const retiredRequests = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/notes")) retiredRequests.push(request.url()); });
  if (!await page.getByRole("complementary", { name: "Work panel" }).isVisible())
    await page.getByRole("button", { name: "Toggle work panel", exact: true }).click();
  const workPanel = page.getByRole("complementary", { name: "Work panel" });
  await workPanel.getByRole("button", { name: "Files", exact: true }).click();
  await expect(workPanel.getByRole("heading", { name: "Artifacts", exact: true })).toBeVisible();
  await expect(workPanel.getByRole("heading", { name: "Project decisions", exact: true })).toHaveCount(0);
  await expect(workPanel.getByRole("textbox", { name: "Save project decision", exact: true })).toHaveCount(0);
  assert.deepEqual(retiredRequests, []);
  await workPanel.getByRole("button", { name: "Close work panel", exact: true }).click();

  await expect(trigger).toContainText(/84k \/ 200k/i);
  const draft = page.getByLabel("Message your coding agent");
  await draft.fill("Keep this unsent draft\nwith its second line.");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Context details" });
  await expect(dialog).toContainText("90% (72,000 input tokens)");
  await expect(dialog).toContainText("Cached tokens still occupy context");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(dialog).toHaveCount(0);
  const publish = (patch) =>
    app.controller.event(chats[0].id, null, "context-usage", {
      ...app.store.contextByProvider(chats[0].id).codex,
      ...patch,
    });
  publish({ state: "compacting", generation: 1 });
  await expect(trigger).toContainText("Updating after compaction");
  await expect(
    page.getByRole("progressbar", { name: "Context used" }),
  ).not.toHaveAttribute("aria-valuenow");
  publish({
    state: "ready",
    usedTokens: 20000,
    observedAt: new Date().toISOString(),
  });
  await expect(trigger).toContainText("Context 10%");
  await expect(draft).toHaveValue(
    "Keep this unsent draft\nwith its second line.",
  );
  await page.reload();
  await expect(trigger).toContainText("Context 10%");
  await expect(draft).toHaveValue(
    "Keep this unsent draft\nwith its second line.",
  );
  await chooseModel(page, app.controller.providers, "codex", "other");
  await expect(trigger).toContainText("Waiting for model context");
  await trigger.click();
  await expect(
    page.getByRole("dialog", { name: "Context details" }),
  ).toContainText("Previous model reading: fixture");
  await page.keyboard.press("Escape");
  await chooseModel(page, app.controller.providers, "codex", "fixture");
  await expect(trigger).toContainText("Context 10%");
  await page.screenshot({
    path: resolve(local, "screenshots/context-desktop.png"),
  });

  await page.goto(url(chats.map((c) => c.id)));
  await expect(page.locator(".context-meter")).toHaveCount(4);
  await expect(
    page.locator(".context-meter").filter({ hasText: "Context unavailable" }),
  ).toHaveCount(1);
  await expect(
    page.locator(".context-meter").filter({ hasText: "Context 110%" }),
  ).toHaveCount(1);
  await expect(
    page.locator(".context-meter").filter({ hasText: "≈ Context 42%" }),
  ).toHaveCount(1);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  for (const meter of await page.locator(".context-trigger").all()) {
    await expect(meter).toBeVisible();
    assert.ok((await meter.boundingBox()).height >= 24);
  }
  await page.screenshot({
    path: resolve(local, "screenshots/context-four-panes.png"),
  });
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.locator(".context-trigger").first().click();
  const smallPopover = await page
    .getByRole("dialog", { name: "Context details" })
    .boundingBox();
  assert.ok(smallPopover.y >= 0 && smallPopover.y + smallPopover.height <= 600);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto(url(chats.slice(0, 2).map((c) => c.id)));
  await expect(page.locator(".context-meter")).toHaveCount(2);

  const phone = await browser.newContext({ ...devices["iPhone 13"] });
  const mobile = await phone.newPage();
  mobile.on("pageerror", (error) => errors.push(error.message));
  await mobile.goto(url([chats[0].id]));
  await expect(mobile.locator(".context-trigger")).toContainText("Context 10%");
  await mobile.locator(".context-trigger").click();
  await expect(
    mobile.getByRole("dialog", { name: "Context details" }),
  ).toBeVisible();
  const box = await mobile
    .getByRole("dialog", { name: "Context details" })
    .boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0);
  await mobile.screenshot({
    path: resolve(local, "screenshots/context-mobile.png"),
  });
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  // Deliver an old HTTP snapshot after both a newer context event and a
  // newer full snapshot. Neither the meter nor chat mode may regress.
  const captured = Promise.withResolvers(),
    release = Promise.withResolvers(),
    delivered = Promise.withResolvers();
  let held = false;
  const chatRoute = `**/api/chats/${chats[0].id}`;
  await page.route(chatRoute, async (route) => {
    const response = await route.fetch();
    const hold = !held;
    if (hold) {
      held = true;
      captured.resolve();
      await release.promise;
    }
    await route.fulfill({ response });
    if (hold) delivered.resolve();
  });
  try {
    app.controller.event(
      chats[0].id,
      null,
      "chat",
      app.store.conversation(chats[0].id),
    );
    await captured.promise;
    publish({ usedTokens: 40000 });
    app.controller.event(
      chats[0].id,
      null,
      "chat",
      app.store.updateConversation(chats[0].id, { mode: "ask" }),
    );
    await expect(page.locator(".context-trigger").first()).toContainText(
      "Context 20%",
    );
    await expect(page.getByLabel("Mode", { exact: true }).first()).toHaveValue(
      "ask",
    );
    release.resolve();
    await delivered.promise;
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    await expect(page.locator(".context-trigger").first()).toContainText(
      "Context 20%",
    );
    await expect(page.getByLabel("Mode", { exact: true }).first()).toHaveValue(
      "ask",
    );
  } finally {
    release.resolve();
    await page.unroute(chatRoute);
  }
  assert.deepEqual(errors, []);
  console.log(
    "Context bar verified: live updates, cache detail, compaction, model changes, drafts, reload, two/four panes, keyboard, mobile, bounded popovers and stale HTTP snapshot ordering.",
  );
} finally {
  await browser?.close();
  await app.close();
  assert.equal(dirname(dataDir), local);
  await rm(dataDir, { recursive: true, force: true });
}
