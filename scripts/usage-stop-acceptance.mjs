// Isolated browser checks with simulated turns; no provider inference or user data.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHarness } from "../src/server.mjs";

await mkdir(".local/screenshots", { recursive: true });
const dataDir = await mkdtemp(resolve(".local/usage-stop-")),
  projectPath = join(dataDir, "project");
await mkdir(projectPath);
const app = await createHarness({ dataDir, port: 0, startProviders: false });
const project = app.store.addProject("Usage stop fixture", projectPath);
app.controller.providers = [
  {
    id: "codex",
    name: "Codex",
    connected: true,
    models: [{ id: "fixture", name: "Fixture", efforts: [] }],
  },
  {
    id: "claude",
    name: "Claude Code",
    connected: true,
    models: [{ id: "fixture", name: "Fixture", efforts: [] }],
  },
];
const reason = "Included Codex quota is exhausted.",
  errors = [];
let browser,
  scenario = "replayed";
app.controller.runners.codex = async (ctx) => {
  ctx.goalState("usageLimited");
  ctx.goalState("active");
  ctx.emit("nativeTurn", { id: "native-" + scenario });
  ctx.emit("text", {
    nativeId: "reply-" + scenario,
    text: "Finished the work.",
  });
  ctx.goalState("complete");
  if (scenario === "exhausted") {
    ctx.emit("work", { kind: "billing-stop", reason });
    return { status: "interrupted" };
  }
  if (scenario === "unrelated")
    return { status: "failed", error: "Provider unavailable" };
  return { status: "completed" };
};
app.controller.runners.claude = async (ctx) => {
  ctx.emit("nativeTurn", { id: "native-continue" });
  ctx.emit("text", {
    nativeId: "reply-continue",
    text: "Picking up the work.",
  });
  return { status: "completed" };
};
const run = async (chat, kind) => {
  scenario = kind;
  const next = app.controller.send(chat.id, {
    actionId: `${chat.id}-${kind}-${crypto.randomUUID()}`,
    text: "Continue the goal",
    provider: "codex",
    model: "fixture",
  });
  await app.controller.active.get(chat.id).task;
  return app.store.run(next.id);
};
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  for (const origin of ["banner", "sidebar"]) {
    const chat = app.store.createConversation({
      projectId: project.id,
      title: `Dismiss from ${origin}`,
      provider: "codex",
      model: "fixture",
      mode: "goal",
    });
    app.store.setUsageStop(chat.id, reason);
    expect((await run(chat, "replayed")).status).toBe("completed");
    await page.goto(
      `${app.runtime.origin}/?chat=${chat.id}#pair=${app.auth.pairing()}`,
    );
    const notice = page.locator(".notice.failed");
    await expect(page.getByLabel("Message your coding agent")).toBeVisible();
    await expect(notice).toHaveCount(0);
    expect((await run(chat, "exhausted")).status).toBe("failed");
    await expect(notice).toContainText(
      "This turn stopped because usage ran out.",
    );
    if (origin === "banner") {
      // A successful mutation must update the open pane even while SSE is down.
      await page.route("**/api/events?*", (route) => route.abort());
      await page.reload();
      await expect(notice).toContainText(
        "This turn stopped because usage ran out.",
      );
      await notice
        .getByRole("button", { name: "Dismiss", exact: true })
        .click();
    } else {
      const row = page
        .locator(".chat-row")
        .filter({
          has: page.getByRole("button", { name: chat.title, exact: true }),
        })
        .first();
      await row.hover();
      await row
        .getByRole("button", {
          name: `Dismiss usage flag for ${chat.title}`,
          exact: true,
        })
        .click();
    }
    await expect(notice).toHaveCount(0);
    expect(app.store.conversation(chat.id).usage_dismissed_run_id).toBeTruthy();
    await page.reload();
    await expect(page.getByLabel("Message your coding agent")).toBeVisible();
    await expect(notice).toHaveCount(0);
    await page.unroute("**/api/events?*");
    await page.reload();
    expect((await run(chat, "unrelated")).status).toBe("failed");
    await expect(notice).toContainText("Provider unavailable");
    expect((await run(chat, "exhausted")).status).toBe("failed");
    await expect(notice).toContainText(
      "This turn stopped because usage ran out.",
    );
  }
  const continued = app.store.createConversation({
    projectId: project.id,
    title: "Continue with Claude",
    provider: "codex",
    model: "fixture",
  });
  app.store.setUsageStop(continued.id, reason);
  await page.goto(
    `${app.runtime.origin}/?chat=${continued.id}#pair=${app.auth.pairing()}`,
  );
  const continuedNotice = page.locator(".notice.failed");
  await expect(continuedNotice).toContainText(
    "This turn stopped because usage ran out.",
  );
  await continuedNotice
    .getByRole("button", { name: "Continue with a new provider", exact: true })
    .click();
  const menu = page.locator(".model-popup");
  await menu.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
  await menu.getByRole("menuitemradio", { name: "Fixture", exact: true }).click();
  await expect(page.getByText("Picking up the work.")).toBeVisible();
  await expect(page.getByText(/Included usage ran out on Codex/)).toBeVisible();
  await expect(continuedNotice).toHaveCount(0);
  expect(app.store.conversation(continued.id).provider).toBe("claude");
  expect(app.store.conversation(continued.id).usage_stopped_at).toBeNull();
  expect(
    app.store
      .messages(continued.id)
      .some(
        (message) =>
          message.role === "user" &&
          message.content.startsWith("Included usage ran out on Codex."),
      ),
  ).toBe(true);
  await page.screenshot({ path: ".local/screenshots/usage-stop.png" });
  expect(errors).toEqual([]);
  console.log(
    "Usage stop checks passed: resumed Goal completion, genuine quota stop, banner/sidebar dismissal, disconnected stream, persistence after reload, visibility of later failures, and continuing on another provider. Providers were simulated.",
  );
} finally {
  await browser?.close();
  await app.close();
}
