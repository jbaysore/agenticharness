// Actual browser/HTTP with an explicitly simulated provider and worker, no
// inference: the Agent rules screen, a delegated search, and each fallback.
import { createHarness } from "../src/server.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "harness-rules-")),
  app = await createHarness({
    dataDir: join(dir, "data"),
    port: 0,
    startProviders: false,
    seedProject: dir,
  });
const { controller } = app;
const model = (id, name, efforts = []) => ({ id, name, efforts });
controller.providers = [
  {
    id: "claude",
    name: "Claude Code",
    route: "Fixture",
    connected: true,
    models: [model("opus", "Opus"), model("haiku", "Haiku")],
  },
  {
    id: "codex",
    name: "Codex",
    route: "Fixture",
    connected: true,
    models: [model("big", "Big"), model("mini", "Mini", ["low", "medium"])],
  },
];
const announceProviders = () =>
  controller.event(null, null, "providers", {
    providers: controller.providers,
  });
controller.refreshProviders = async () => controller.providers;
// The simulated chat hands its request to the worker whenever the tool is
// offered, and says so; the real controller decides whether it is offered.
controller.runners.codex = async (ctx) => {
  const offered = ctx.tools.some((t) => t.name === "delegate_task"),
    result =
      offered && (await ctx.history("delegate_task", { task: ctx.text }));
  ctx.emit("text", {
    nativeId: "reply",
    text: !offered
      ? "Searched it myself."
      : result.answer
        ? `Worker said: ${result.answer}`
        : `No worker: ${result.error}`,
  });
  return { status: "completed" };
};
const jobs = [];
for (const provider of ["claude", "codex"])
  controller.workers[provider] = async (job) => {
    jobs.push([provider, job.model, job.effort]);
    return { text: `${provider} found it`, tokens: 1200, model: job.model };
  };

const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
try {
  const page = await (
    await browser.newContext({ viewport: { width: 1512, height: 982 } })
  ).newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.runtime.origin + "/#pair=" + app.auth.pairing());
  const rulesButton = page.getByRole("button", { name: /^Agent rules/ }),
    dialog = page.getByRole("dialog", { name: "Agent rules" }),
    route = dialog.locator(".rule-route"),
    toggle = dialog.getByLabel("Hand off searches to a cheaper model"),
    worker = dialog.getByLabel("Worker model", { exact: true }),
    fallback = dialog.getByLabel("Fallback worker", { exact: true }),
    instructions = dialog.getByLabel("Instructions for every agent"),
    close = () => dialog.getByLabel("Close dialog").click(),
    lastReply = page.locator(".message.assistant").last(),
    workLog = page.locator(".work-item");
  const ask = async (text) => {
    await page.getByLabel("Message your coding agent").fill(text);
    await page.getByLabel("Send message").click();
  };

  // Nothing is chosen until the user chooses; the rule cannot be on without a worker.
  await rulesButton.click();
  await expect(route).toHaveText("Choose a worker model to turn this on.");
  await expect(toggle).toBeDisabled();
  await expect(fallback).toHaveCount(0);
  await instructions.fill("Keep answers short.");
  await worker.selectOption("claude|haiku");
  await expect(route).toHaveText("Off. Each chat does its own searching.");
  await toggle.check();
  await expect(route).toHaveText("Searches go to Claude Code · Haiku.");
  await expect(
    fallback.locator('option[value="claude|haiku"]'),
  ).toHaveAttribute("disabled", "");
  await fallback.selectOption("codex|mini");
  await dialog.getByLabel("Fallback worker effort").selectOption("low");
  await dialog.getByRole("button", { name: "Save rules" }).click();
  await expect(dialog.getByRole("status").last()).toContainText("Saved.");
  await close();
  await expect(rulesButton).toContainText("On");

  // The choice survives a reload.
  await page.reload();
  await rulesButton.click();
  await expect(instructions).toHaveValue("Keep answers short.");
  await expect(toggle).toBeChecked();
  await expect(worker).toHaveValue("claude|haiku");
  await expect(fallback).toHaveValue("codex|mini");
  await expect(dialog.getByLabel("Fallback worker effort")).toHaveValue("low");
  await close();

  // A Codex chat hands its search to the Claude worker, and the work log shows it.
  await page.getByLabel("Agent and model").selectOption("codex|big");
  await ask("Where is the parser?");
  await expect(lastReply).toContainText("Worker said: claude found it");
  expect(jobs).toEqual([["claude", "haiku", null]]);
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(
    workLog.filter({ hasText: "Delegated to Claude Code · Haiku" }),
  ).toBeVisible();
  await expect(
    workLog.filter({ hasText: "Claude Code · Haiku answered" }),
  ).toContainText("1,200 tokens");
  await rulesButton.click();
  await expect(dialog).toContainText(
    "Claude Code · Haiku: last 1 hand-off, median 1,200 tokens, lowest 1,200.",
  );

  // The worker's provider runs out of usage: settings says where searches go
  // now, and the next search goes to the fallback with the reason logged.
  controller.providers[0].blockReason =
    "A Claude included-usage limit is exhausted.";
  announceProviders();
  await expect(route).toHaveText(
    "Searches go to Codex · Mini. Claude Code · Haiku: A Claude included-usage limit is exhausted.",
  );
  await expect(dialog.locator(".rule-status.blocked")).toContainText(
    "Out of usage",
  );
  await close();
  await ask("Where is the lexer?");
  await expect(lastReply).toContainText("Worker said: codex found it");
  expect(jobs.at(-1)).toEqual(["codex", "mini", "low"]);
  await expect(
    workLog.filter({ hasText: "Searches go to Codex · Mini" }),
  ).toContainText("A Claude included-usage limit is exhausted.");

  // No worker can run: the chat is not offered the tool and searches for itself.
  controller.providers[1].models[1].disabled = true;
  announceProviders();
  await rulesButton.click();
  await expect(route).toContainText(
    "No worker is available; chats will search for themselves.",
  );
  await close();
  await ask("Where is the printer?");
  await expect(lastReply).toContainText("Searched it myself.");
  expect(jobs).toHaveLength(2);
  await expect(
    workLog.filter({
      hasText: "No worker is available; this chat will search for itself",
    }),
  ).toBeVisible();

  // Turning the rule off removes the tool from the next turn.
  controller.providers[0].blockReason = null;
  controller.providers[1].models[1].disabled = false;
  announceProviders();
  await rulesButton.click();
  await expect(route).toHaveText("Searches go to Claude Code · Haiku.");
  await toggle.uncheck();
  await dialog.getByRole("button", { name: "Save rules" }).click();
  await expect(dialog.getByRole("status").last()).toContainText("Saved.");
  await close();
  await expect(rulesButton).not.toContainText("On");
  await ask("Where is the formatter?");
  await expect(lastReply).toContainText("Searched it myself.");
  expect(jobs).toHaveLength(2);
  await rulesButton.click();
  await page.screenshot({
    path: ".local/screenshots/agent-rules.png",
    fullPage: true,
  });

  expect(errors).toEqual([]);
  console.log(
    "Agent rules checks passed: choose and keep a worker and fallback, a delegated search in the work log with its token cost, fallback when the worker is out of usage, no worker available, and turning the rule off. Provider and worker were simulated.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
