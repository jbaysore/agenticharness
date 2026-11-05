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
  if (scenario === "resumed") {
    ctx.emit("nativeTurn", { id: "usage-resumed" });
    ctx.emit("text", {
      nativeId: "usage-resumed-reply",
      text: "Usage reset, continuing.",
    });
    return { status: "completed" };
  }
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
  for (const [from, to] of [["codex", "claude"], ["claude", "codex"]]) {
    const objective = "Finish every requirement and preserve completed work. ".repeat(100);
    const goal = app.store.createConversation({ projectId: project.id, title: `Goal ${from} to ${to}`, provider: from, model: "fixture", mode: "goal" });
    const origin = app.store.createRun({ conversationId: goal.id, actionId: crypto.randomUUID(), provider: from, model: "fixture", text: objective });
    app.store.setRun(origin.id, "failed", null, reason);
    app.store.setGoalState(goal.id, from, origin.id, "usageLimited", objective);
    app.store.setUsageStop(goal.id, reason, origin.id);
    let starts = 0, lostBody;
    const previous = app.controller.runners[to];
    app.controller.runners[to] = async (ctx) => {
      starts++;
      expect(ctx.goalObjective).toContain(objective);
      ctx.emit("work", { kind: "provider-startup", phase: "initialize", state: "starting" });
      if (starts === 1) throw new Error("Fixture startup unavailable");
      ctx.emit("nativeTurn", { id: "continued-goal" });
      ctx.emit("text", { nativeId: crypto.randomUUID(), text: "Goal continued exactly once." });
      ctx.goalState("complete");
      return { status: "completed" };
    };
    await page.goto(`${app.runtime.origin}/?chat=${goal.id}`);
    await page.getByLabel("Message your coding agent").fill("Keep my unsent draft");
    const continueGoal = async () => {
      await page.getByRole("button", { name: "Continue with a new provider", exact: true }).click();
      await page.locator(".model-popup").getByRole("menuitem", { name: to === "codex" ? "Codex" : "Claude Code", exact: true }).click();
      await page.locator(".model-popup").getByRole("menuitemradio", { name: "Fixture", exact: true }).click();
    };
    try {
      await continueGoal();
      await expect.poll(() => starts).toBe(1);
      await expect(page.getByRole("button", { name: "Continue with a new provider", exact: true })).toBeEnabled();
      expect(app.store.conversation(goal.id).usage_stopped_run_id).toBe(origin.id);
      await page.route(`**/api/chats/${goal.id}/messages`, async (route) => {
        lostBody = route.request().postDataJSON();
        await route.fetch();
        await route.abort();
      });
      await continueGoal();
      await expect(page.getByText("Goal continued exactly once.", { exact: true })).toBeVisible();
      await expect.poll(() => starts).toBe(2);
      await page.unroute(`**/api/chats/${goal.id}/messages`);
      await page.reload();
      await expect(page.getByLabel("Message your coding agent")).toHaveValue("Keep my unsent draft");
      await expect(page.getByText("Goal continued exactly once.", { exact: true })).toBeVisible();
      const duplicate = await fetch(`${app.runtime.origin}/api/chats/${goal.id}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Harness-Client": "1" }, body: JSON.stringify(lostBody),
      }).then((response) => response.json());
      expect(duplicate.duplicate).toBe(true);
      expect(starts).toBe(2);
      expect(app.store.conversation(goal.id).usage_stopped_at).toBeNull();
    } finally { app.controller.runners[to] = previous; }
  }
  const waiting = app.store.createConversation({
    projectId: project.id,
    title: "Resume when usage resets",
    provider: "codex",
    model: "fixture",
  });
  const waitingRun = app.store.createRun({
    conversationId: waiting.id,
    actionId: crypto.randomUUID(),
    provider: "codex",
    model: "fixture",
    text: "Finish the turn",
  });
  app.store.setRun(waitingRun.id, "failed", null, reason);
  app.store.setUsageStop(waiting.id, reason, waitingRun.id);
  const codex = app.controller.providers.find((item) => item.id === "codex");
  codex.blockReason = reason;
  await page.goto(`${app.runtime.origin}/?chat=${waiting.id}`);
  const waitingNotice = page.locator(".notice.failed");
  await waitingNotice.getByRole("button", { name: "Resume when usage resets", exact: true }).click();
  await expect(waitingNotice).toContainText("It will resume on Codex · Fixture when usage resets.");
  await expect(waitingNotice).toContainText("Checking until a reading shows usage is available.");
  await expect.poll(() => app.store.conversation(waiting.id).usage_resume_at).toBeTruthy();
  expect(app.store.db.prepare("SELECT count(*) AS n FROM runs WHERE conversation_id=?").get(waiting.id).n).toBe(1);
  await waitingNotice.getByRole("button", { name: "Cancel resume", exact: true }).click();
  await expect(waitingNotice.getByRole("button", { name: "Resume when usage resets", exact: true })).toBeVisible();
  await expect.poll(() => app.store.conversation(waiting.id).usage_resume_at).toBeNull();
  await waitingNotice.getByRole("button", { name: "Resume when usage resets", exact: true }).click();
  await expect(waitingNotice).toContainText("when usage resets");
  codex.blockReason = null;
  scenario = "resumed";
  app.controller.resumeUsageWaits();
  await expect(page.getByText("Usage reset, continuing.", { exact: true })).toBeVisible();
  await expect(waitingNotice).toHaveCount(0);
  const resumed = app.store.conversation(waiting.id);
  expect(resumed.provider).toBe("codex");
  expect(resumed.model).toBe("fixture");
  expect(resumed.usage_resume_at).toBeNull();
  expect(resumed.usage_stopped_at).toBeNull();
  expect(app.store.messages(waiting.id).some((message) => message.role === "user" && message.content.startsWith("Included usage has reset."))).toBe(true);
  await page.screenshot({ path: ".local/screenshots/usage-stop.png" });
  expect(errors).toEqual([]);
  console.log(
    "Usage stop checks passed: resumed Goal completion, genuine quota stop, banner/sidebar dismissal, disconnected stream, persistence after reload, visibility of later failures, continuing on another provider, and resuming the same model after usage resets. Providers were simulated.",
  );
} finally {
  await browser?.close();
  await app.close();
}
