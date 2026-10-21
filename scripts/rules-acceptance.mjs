// Actual browser/HTTP with an explicitly simulated provider and worker, no
// inference: the Agent rules screen, a hand-off the host finds cheaper, one it
// does itself, and each fallback.
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "harness-rules-"));
await writeFile(
  join(dir, "big.txt"),
  Array.from({ length: 1500 }, (_, i) => `line ${i} of a long file`).join("\n"),
);
await writeFile(join(dir, "small.txt"), "a short file\n");
const app = await createHarness({
  dataDir: join(dir, "data"),
  port: 0,
  startProviders: false,
  seedProject: dir,
});
const { controller } = app;
// Model names the price list knows, so the host can compare costs.
controller.providers = [
  {
    id: "claude",
    name: "Claude Code",
    route: "Fixture",
    connected: true,
    models: [
      {
        id: "opus",
        name: "Opus",
        efforts: [],
        resolvedModel: "claude-opus-5-5",
      },
      {
        id: "haiku",
        name: "Haiku",
        efforts: [],
        resolvedModel: "claude-haiku-5-5",
      },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    route: "Fixture",
    connected: true,
    models: [
      { id: "gpt-6.1-sol", name: "Sol", efforts: [] },
      { id: "gpt-6-luna", name: "Luna", efforts: ["low", "high"] },
    ],
  },
];
const announceProviders = () =>
  controller.event(null, null, "providers", {
    providers: controller.providers,
  });
controller.refreshProviders = async () => controller.providers;
// The simulated chat asks the host to read a file whenever that tool is
// offered, and reports what came back. The real controller decides whether the
// tool is offered and whether a worker or the host answers.
controller.runners.codex = async (ctx) => {
  const offered = ctx.tools.some((t) => t.name === "delegate_read"),
    result =
      offered &&
      (await ctx.history("delegate_read", {
        paths: [ctx.text.includes("small") ? "small.txt" : "big.txt"],
        question: ctx.text,
        purpose: "read",
      }));
  ctx.emit("text", {
    nativeId: "reply",
    text: !offered
      ? "Read it myself."
      : result.answer
        ? `Worker said: ${result.answer}`
        : result.files
          ? `Host returned ${result.files.length} file as text.`
          : `Problem: ${result.error}`,
  });
  return { status: "completed" };
};
const jobs = [];
for (const provider of ["claude", "codex"])
  controller.workers[provider] = async (job) => {
    jobs.push([provider, job.model, job.effort, job.mode]);
    return {
      text: `${provider} found it`,
      usage: { input: 1000, output: 200 },
    };
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
    toggle = dialog.getByLabel("Hand off work to a cheaper model"),
    worker = dialog.getByLabel("Worker model", { exact: true }),
    fallback = dialog.getByLabel("Fallback worker", { exact: true }),
    drafts = dialog.getByLabel("Draft a commit or changelog"),
    instructions = dialog.getByLabel("Instructions for every agent"),
    save = async () => {
      await dialog.getByRole("button", { name: "Save rules" }).click();
      await expect(dialog.getByRole("status").last()).toContainText("Saved.");
    },
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
  await expect(route).toHaveText("Off. Each chat does its own work.");
  await toggle.check();
  await expect(route).toHaveText("Hand-offs go to Claude Code · Haiku.");
  await expect(
    fallback.locator('option[value="claude|haiku"]'),
  ).toHaveAttribute("disabled", "");
  await fallback.selectOption("codex|gpt-6-luna");
  await dialog.getByLabel("Fallback worker effort").selectOption("high");
  // Each kind of work can be switched off on its own.
  await expect(drafts).toBeChecked();
  await drafts.uncheck();
  await save();
  await close();
  await expect(rulesButton).toContainText("On");

  // The choices survive a reload.
  await page.reload();
  await rulesButton.click();
  await expect(instructions).toHaveValue("Keep answers short.");
  await expect(toggle).toBeChecked();
  await expect(worker).toHaveValue("claude|haiku");
  await expect(fallback).toHaveValue("codex|gpt-6-luna");
  await expect(dialog.getByLabel("Fallback worker effort")).toHaveValue("high");
  await expect(drafts).not.toBeChecked();
  await expect(dialog.getByLabel("Locate code or files")).toBeChecked();
  await close();
  expect(app.store.setting("agent-rules").delegate.actions.draft).toBe(false);

  // A long file is cheaper on the worker; the work log shows who answered and at what cost.
  await chooseModel(page, controller.providers, "codex", "gpt-6.1-sol");
  await ask("Find the part about line 900 in the big file");
  await expect(lastReply).toContainText("Worker said: claude found it");
  expect(jobs).toEqual([["claude", "haiku", null, "inline"]]);
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(
    workLog.filter({ hasText: "Delegated to Claude Code · Haiku" }),
  ).toBeVisible();
  await expect(
    workLog.filter({ hasText: "Claude Code · Haiku answered" }),
  ).toContainText(/1,200 tokens, about \d+% of the estimated cost/);

  // A short file is cheaper to hand straight back: no worker starts.
  await ask("Read the small file");
  await expect(lastReply).toContainText("Host returned 1 file as text.");
  expect(jobs).toHaveLength(1);
  await expect(
    workLog.filter({ hasText: "Returned the file text itself" }),
  ).toContainText("A worker was not estimated to be cheaper.");
  await rulesButton.click();
  await expect(dialog).toContainText(
    "Claude Code · Haiku: last 1 hand-off, median 1,200 tokens, lowest 1,200.",
  );

  // The worker's provider runs out of usage: settings says where hand-offs go
  // now, and the next one goes to the fallback with the reason logged.
  controller.providers[0].blockReason =
    "A Claude included-usage limit is exhausted.";
  announceProviders();
  await expect(route).toHaveText(
    "Hand-offs go to Codex · Luna. Claude Code · Haiku: A Claude included-usage limit is exhausted.",
  );
  await expect(dialog.locator(".rule-status.blocked")).toContainText(
    "Out of usage",
  );
  await close();
  await ask("Find the part about line 20 in the big file");
  await expect(lastReply).toContainText("Worker said: codex found it");
  expect(jobs.at(-1)).toEqual(["codex", "gpt-6-luna", "high", "inline"]);
  await expect(
    workLog.filter({ hasText: "Hand-offs go to Codex · Luna" }),
  ).toContainText("A Claude included-usage limit is exhausted.");

  // No worker can run: the chat is not offered the tools and does its own work.
  controller.providers[1].models[1].disabled = true;
  announceProviders();
  await rulesButton.click();
  await expect(route).toContainText(
    "No worker is available; chats will do their own work.",
  );
  await close();
  await ask("Find the part about line 30 in the big file");
  await expect(lastReply).toContainText("Read it myself.");
  expect(jobs).toHaveLength(2);
  await expect(
    workLog.filter({
      hasText: "Nothing is handed off this turn; this chat does its own work",
    }),
  ).toBeVisible();

  // Turning the rule off removes the tools from the next turn.
  controller.providers[0].blockReason = null;
  controller.providers[1].models[1].disabled = false;
  announceProviders();
  await rulesButton.click();
  await expect(route).toHaveText("Hand-offs go to Claude Code · Haiku.");
  await page.screenshot({
    path: ".local/screenshots/agent-rules.png",
    fullPage: true,
  });
  await toggle.uncheck();
  await save();
  await close();
  await expect(rulesButton).not.toContainText("On");
  await ask("Find the part about line 40 in the big file");
  await expect(lastReply).toContainText("Read it myself.");
  expect(jobs).toHaveLength(2);

  expect(errors).toEqual([]);
  console.log(
    "Agent rules checks passed: choosing and keeping workers and allowed actions, a hand-off the host found cheaper with its cost in the work log, a small job the host did itself, fallback when the worker is out of usage, no worker available, and turning the rule off. Provider and worker were simulated.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
