// Real UI and controller, simulated Cursor and reviewer; no inference.
import { chromium, expect, devices } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";

await mkdir(".local/screenshots", { recursive: true });
const app = await createHarness({
  dataDir: await mkdtemp(resolve(".local/cursor-review-ui-")),
  port: 0,
  startProviders: false,
  seedProject: process.cwd(),
});
app.controller.providers = [
  {
    id: "cursor",
    name: "Cursor",
    connected: true,
    models: [{ id: "fixture", name: "Cursor fixture", efforts: [] }],
  },
  {
    id: "codex",
    name: "Codex",
    connected: true,
    models: [
      {
        id: "reviewer",
        name: "Reviewer fixture",
        isDefault: true,
        efforts: [],
      },
    ],
  },
];
const outcomes = [],
  jobs = [],
  errors = [];
app.controller.openReviewer = null;
app.controller.workers.codex = async (job) => {
  const command = JSON.parse(job.task).proposedAction.details.rawInput.command;
  jobs.push(command);
  return {
    text: JSON.stringify({
      decision: { routine: "allow", destructive: "deny", uncertain: "ask" }[
        command
      ],
      reason:
        command === "uncertain"
          ? "Confirm the destination before publishing."
          : `Reviewed ${command}.`,
    }),
  };
};
app.controller.runners.cursor = async (ctx) => {
  ctx.saveSession({ id: "cursor-session" });
  for (const command of ["routine", "destructive", "uncertain"])
    outcomes.push(
      await ctx.approve({
        kind: "permission",
        method: "session/request_permission",
        title: command,
        details: { kind: "execute", rawInput: { command } },
      }),
    );
  await ctx.approve({
    kind: "question",
    title: "Which file should I use?",
    questions: [{ id: "file", question: "File name" }],
  });
  return { status: "cancelled" };
};
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.runtime.origin);
  await chooseModel(page, app.controller.providers, "cursor", "fixture");
  await expect(page.getByLabel("Permissions", { exact: true })).toHaveValue(
    "auto",
  );
  await expect(page.locator("label.permissions-control")).toHaveAttribute(
    "title",
    /managerial choice/,
  );
  await page.getByRole("button", { name: "Agent rules" }).click();
  await expect(
    page.getByText("asks you only for a managerial choice it explains"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByLabel("Message your coding agent")
    .fill("Update the fixture and test it.");
  await page.getByLabel("Send message").click();
  await expect(
    page.getByRole("heading", { name: "uncertain", exact: true }),
  ).toBeVisible();
  expect(outcomes.map((answer) => answer.allow)).toEqual([true, false]);
  expect(jobs).toEqual(["routine", "destructive", "uncertain"]);
  await expect(
    page.getByText("Auto-review: Confirm the destination before publishing."),
  ).toBeVisible();
  const chat = app.store.conversations()[0],
    run = app.store.activeRun(chat.id);
  expect(app.store.pendingApprovals(chat.id)).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByText("Auto-review: Confirm the destination before publishing."),
  ).toBeVisible();
  await page.screenshot({
    path: ".local/screenshots/cursor-review-desktop.png",
  });
  const phone = await browser.newPage({ ...devices["iPhone 13"] });
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(`${app.runtime.origin}/?chat=${chat.id}`);
  await expect(
    phone.getByText("Auto-review: Confirm the destination before publishing."),
  ).toBeVisible();
  await phone.screenshot({
    path: ".local/screenshots/cursor-review-phone.png",
  });
  await phone.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Which file should I use?",
      exact: true,
    }),
  ).toBeVisible();
  expect(outcomes.map((answer) => answer.allow)).toEqual([true, false, true]);
  expect(jobs).toHaveLength(3);
  expect(app.store.activeRun(chat.id).id).toBe(run.id);
  await page.getByLabel("Stop work").click();
  await expect.poll(() => app.store.activeRun(chat.id)).toBeFalsy();
  const reviews = app.store
    .events()
    .filter(
      (e) => e.payload.kind === "permission-review" && e.payload.decision,
    );
  expect(reviews.map((e) => e.payload.decision)).toEqual([
    "allow",
    "deny",
    "ask",
  ]);
  expect(errors).toEqual([]);
  console.log(
    "Cursor reviewer UI passed: automatic allow/deny, explained fallback, persisted approvals, desktop/mobile sync, questions, and stop.",
  );
} finally {
  await browser?.close();
  await app.close();
}
