// Actual browser/HTTP with an explicitly simulated provider, no inference:
// several chats running at once, side by side and in the background.
import { createHarness } from "../src/server.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "harness-multichat-")),
  otherDir = await mkdtemp(join(tmpdir(), "harness-multichat-other-")),
  app = await createHarness({
    dataDir: join(dir, "data"),
    port: 0,
    startProviders: false,
  });
const { store, controller } = app;
controller.providers = [
  {
    id: "codex",
    name: "Transport fixture",
    connected: true,
    models: ["fixture", "fixture-b"].map((id) => ({
      id,
      name: "No inference " + id,
      efforts: [],
    })),
    capabilities: {},
  },
];
// A turn streams its opening text, optionally asks for approval, then waits
// until the script lets it finish.
const release = new Map();
controller.execute = async (run, text, effort, abort) => {
  const chatId = run.conversation_id;
  store.setRun(run.id, "running");
  controller.event(chatId, run.id, "run", { status: "running" });
  const messageId = store.addMessage({
    conversationId: chatId,
    runId: run.id,
    role: "assistant",
    provider: run.provider,
    model: run.model,
  });
  const say = (delta) => {
    store.appendMessage(messageId, delta);
    controller.event(chatId, run.id, "text", {
      delta,
      messageId,
      provider: run.provider,
      model: run.model,
    });
  };
  say("Working on: " + text + ".");
  if (text.includes("approval")) {
    const answer = await controller.waitApproval(
      run,
      { kind: "permission", title: "Fixture approval", details: {} },
      abort.signal,
    );
    say(answer.allow ? " Allowed." : " Declined.");
  }
  await new Promise((resolve) => {
    release.set(chatId, resolve);
    if (abort.signal.aborted) resolve();
    else abort.signal.addEventListener("abort", resolve, { once: true });
  });
  say(" Done.");
  store.setRun(run.id, "completed");
  controller.active.delete(chatId);
  controller.event(chatId, run.id, "run", { status: "completed" });
};
const finish = async (chat) => {
  await expect.poll(() => release.has(chat.id)).toBe(true);
  release.get(chat.id)();
  release.delete(chat.id);
};

const project = store.addProject("Main project", dir),
  other = store.addProject("Other project", otherDir);
const chat = (title, projectId = project.id) =>
  store.createConversation({
    projectId,
    title,
    provider: "codex",
    model: "fixture",
  });
const alpha = chat("Alpha"),
  beta = chat("Beta"),
  gamma = chat("Gamma"),
  delta = chat("Delta", other.id);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
try {
  const page = await (
    await browser.newContext({ viewport: { width: 1920, height: 1000 } })
  ).newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.runtime.origin + "/#pair=" + app.auth.pairing());
  const sidebar = page.locator(".sidebar"),
    projectList = page.locator(".project-list"),
    activeList = page.getByLabel("Active chats"),
    panes = page.locator(".chat-pane"),
    pane = (title) => page.locator(`.chat-pane[aria-label="${title}"]`),
    composer = (title) => pane(title).getByLabel("Message your coding agent"),
    row = (name) => projectList.getByRole("button", { name, exact: true });
  await sidebar.getByRole("button", { name: /^Main project/ }).click();

  // Two chats side by side, each with its own draft, model and turn.
  await row("Alpha").click();
  await row("Beta").click({ modifiers: ["Control"] });
  await expect(panes).toHaveCount(2);
  await pane("Beta")
    .getByLabel("Agent and model")
    .selectOption("codex|fixture-b");
  await composer("Beta").fill("half written");
  await composer("Alpha").fill("first task");
  await pane("Alpha").getByLabel("Send message").click();
  await expect(pane("Alpha").locator(".message.assistant")).toContainText(
    "Working on: first task.",
  );
  await expect(pane("Alpha").getByLabel("Stop work")).toBeVisible();
  await expect(composer("Alpha")).toHaveValue("");
  await expect(composer("Beta")).toHaveValue("half written");
  await expect(pane("Beta").locator(".working-indicator")).toHaveCount(0);
  await composer("Beta").fill("second task");
  await pane("Beta").getByLabel("Send message").click();
  await expect(pane("Beta").locator(".message.assistant")).toContainText(
    "Working on: second task.",
  );
  await expect(page.locator(".working-indicator")).toHaveCount(2);
  await expect(pane("Alpha").getByLabel("Agent and model")).toHaveValue(
    "codex|fixture",
  );
  await expect(pane("Beta").getByLabel("Agent and model")).toHaveValue(
    "codex|fixture-b",
  );
  expect(store.conversation(beta.id).model).toBe("fixture-b");
  await expect(activeList.locator(".chat-row")).toHaveCount(2);
  await expect(
    activeList.getByRole("img", { name: "Alpha: Working" }),
  ).toBeVisible();

  // A turn that finishes in a visible pane is read at once and leaves the active list.
  await finish(alpha);
  await expect(pane("Alpha").locator(".message.assistant")).toContainText(
    "Done.",
  );
  await expect(pane("Beta").locator(".message.assistant")).not.toContainText(
    "Done.",
  );
  await expect(activeList.locator(".chat-row")).toHaveCount(1);
  await expect.poll(() => store.conversation(alpha.id).unread).toBe(false);

  // A chat that is not open asks for approval: the sidebar and the window
  // title say so, and one click opens it with the request ready to answer.
  controller.send(gamma.id, {
    actionId: "started-from-another-device",
    text: "needs approval first",
    provider: "codex",
    model: "fixture",
  });
  await expect(
    activeList.getByRole("img", { name: "Gamma: Waiting for your approval" }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/^\(1\) Harness/);
  await activeList.getByRole("button", { name: "Gamma", exact: true }).click();
  await expect(panes).toHaveCount(2);
  await expect(pane("Beta")).toHaveCount(0);
  await expect(pane("Gamma").locator(".approval")).toContainText(
    "Fixture approval",
  );
  await pane("Gamma").getByRole("button", { name: "Allow once" }).click();
  await expect(pane("Gamma").locator(".message.assistant")).toContainText(
    "Allowed.",
  );
  await finish(gamma);
  await expect(pane("Gamma").locator(".message.assistant")).toContainText(
    "Done.",
  );

  // The chat that was replaced kept running; when it finishes unseen it is
  // marked unread until it is looked at again.
  await expect(
    activeList.getByRole("img", { name: "Beta: Working" }),
  ).toBeVisible();
  await finish(beta);
  await expect(
    activeList.getByRole("img", {
      name: "Beta: Finished since you last looked",
    }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/^\(1\) Harness/);
  await activeList.getByRole("button", { name: "Beta", exact: true }).hover();
  await activeList.getByLabel("Open Beta beside").click();
  await expect(panes).toHaveCount(3);
  await expect(pane("Beta").locator(".message.assistant")).toContainText(
    "Working on: second task. Done.",
  );
  await expect(pane("Beta").getByLabel("Agent and model")).toHaveValue(
    "codex|fixture-b",
  );
  await expect(activeList).toHaveCount(0);
  await expect(page).toHaveTitle(/^Harness/);

  // A draft waits with its chat while the pane is closed.
  await composer("Alpha").fill("alpha draft");
  await pane("Alpha").getByLabel("Close pane").click();
  await expect(panes).toHaveCount(2);
  await row("Alpha").click({ modifiers: ["Control"] });
  await expect(composer("Alpha")).toHaveValue("alpha draft");

  // The breadcrumb and work panel follow the focused pane, across projects.
  await pane("Gamma").getByLabel("Close pane").click();
  await sidebar.getByRole("button", { name: /^Other project/ }).click();
  await expect(panes).toHaveCount(2);
  await row("Delta").click({ modifiers: ["Control"] });
  await expect(panes).toHaveCount(3);
  const crumb = page.locator(".breadcrumbs"),
    repository = page.getByLabel("Repository").locator("option").first();
  await expect(crumb).toContainText("Other project");
  await expect(crumb).toContainText("Delta");
  await expect(repository).toHaveText("Other project");
  await composer("Beta").click();
  await expect(crumb).toContainText("Main project");
  await expect(crumb).toContainText("Beta");
  await expect(repository).toHaveText("Main project");
  await expect(page.locator(".chat-pane.focused")).toHaveAttribute(
    "aria-label",
    "Beta",
  );
  await page.screenshot({
    path: ".local/screenshots/multichat-desktop.png",
    fullPage: true,
  });

  // Rename and archive from the sidebar.
  await row("Alpha").hover();
  await projectList.getByLabel("Rename Alpha", { exact: true }).click();
  await projectList
    .getByLabel("Rename Alpha", { exact: true })
    .fill("Alpha renamed");
  await page.keyboard.press("Enter");
  await expect(row("Alpha renamed")).toBeVisible();
  await expect(pane("Alpha renamed")).toHaveCount(1);
  await row("Alpha renamed").hover();
  await projectList.getByLabel("Archive Alpha renamed").click();
  await expect(row("Alpha renamed")).toHaveCount(0);
  await expect(pane("Alpha renamed")).toHaveCount(0);
  await expect(panes).toHaveCount(2);
  await projectList
    .getByRole("button", { name: "Show archived (1)", exact: true })
    .click();
  await row("Alpha renamed").hover();
  await projectList.getByLabel("Unarchive Alpha renamed").click();
  await expect(
    projectList.getByRole("button", { name: /archived/ }),
  ).toHaveCount(0);
  await expect(row("Alpha renamed")).toBeVisible();
  expect(store.conversation(alpha.id).archived_at).toBeNull();

  expect(errors).toEqual([]);
  console.log(
    "Multi-chat checks passed: independent side-by-side turns, per-chat drafts and models, background status and approval, unread, focus-following work panel, rename and archive. Provider was simulated.",
  );
} finally {
  for (const resolve of release.values()) resolve();
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
  await rm(otherDir, { recursive: true, force: true });
}
