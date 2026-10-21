// Browser and HTTP with a simulated provider, no inference: create a skill,
// turn it on for one chat, and see it in the instructions and the work log.
import assert from "node:assert/strict";
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "harness-skills-ui-"));
const app = await createHarness({
  dataDir: join(dir, "data"),
  port: 0,
  startProviders: false,
  seedProject: dir,
});
const { controller } = app;
controller.providers = [
  {
    id: "codex",
    name: "Codex",
    route: "Fixture",
    connected: true,
    models: [{ id: "gpt-6.1-sol", name: "Sol", efforts: [] }],
  },
];
controller.refreshProviders = async () => controller.providers;
const seen = [];
controller.runners.codex = async (ctx) => {
  seen.push({ text: ctx.text, instructions: ctx.instructions });
  ctx.emit("text", { nativeId: "reply-" + seen.length, text: "Done: " + ctx.text });
  return { status: "completed" };
};

const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
try {
  const page = await (
    await browser.newContext({ viewport: { width: 1512, height: 982 } })
  ).newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.runtime.origin + "/#pair=" + app.auth.pairing());
  const skillsButton = page.locator(".sidebar").getByRole("button", { name: /^Skills/ }),
    dialog = page.getByRole("dialog", { name: "Skills" }),
    box = page.getByLabel("Message your coding agent"),
    menu = page.getByRole("listbox", { name: "Skills" }),
    reply = page.locator(".message.assistant").last();
  const ask = async (text) => {
    await page.getByLabel("Message your coding agent").fill(text);
    await page.getByLabel("Send message").click();
    await expect(reply).toContainText("Done: " + text);
  };

  await skillsButton.click();
  await dialog.getByRole("button", { name: "Create skill" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Give the skill a name");
  await dialog.getByLabel("Skill name").fill("Review notes");
  await dialog.getByLabel("Skill instructions").fill("Write the decision down.");
  await dialog.getByRole("button", { name: "Create skill" }).click();
  await expect(dialog.getByRole("status")).toContainText("Created.");
  await expect(dialog.locator(".skill-command", { hasText: "/review-notes" })).toBeVisible();
  await expect(dialog.getByText("Write the decision down.")).toBeVisible();
  await dialog.getByRole("button", { name: "Edit Review notes" }).click();
  await dialog.getByLabel("Skill instructions").fill("Name the file the decision came from.");
  await dialog.getByRole("button", { name: "Save skill" }).click();
  await expect(dialog.getByRole("status")).toContainText("Saved.");
  await dialog.getByLabel("Close dialog").click();
  await expect(skillsButton).toContainText("1");

  await chooseModel(page, controller.providers, "codex", "gpt-6.1-sol");
  await box.fill("/rev");
  await expect(menu.getByRole("option", { name: "/review-notes Review notes" })).toBeVisible();
  await menu.getByRole("option", { name: "/review-notes Review notes" }).click();
  await expect(box).toHaveValue("/review-notes ");
  await box.press("End");
  await box.pressSequentially("Look at the parser");
  await page.getByLabel("Send message").click();
  await expect(reply).toContainText("Done: /review-notes Look at the parser");
  assert.match(seen[0].text, /\/review-notes Look at the parser/);
  assert.match(seen[0].instructions, /Skill: Review notes/);
  assert.match(seen[0].instructions, /Name the file the decision came from\./);
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.locator(".work-item", { hasText: "Skill · Review notes" })).toBeVisible();

  await ask("Look again");
  assert.doesNotMatch(seen[1].instructions, /Skill: Review notes/);

  await box.fill("Read src/review-notes");
  await expect(menu).toHaveCount(0);
  await ask("Read src/review-notes");
  assert.doesNotMatch(seen[2].instructions, /Skill: Review notes/);

  await skillsButton.click();
  await dialog.getByRole("button", { name: "Delete Review notes" }).click();
  await expect(dialog.getByRole("status")).toContainText("Deleted Review notes.");
  await dialog.getByLabel("Close dialog").click();
  await box.fill("/");
  await expect(menu).toContainText("No skills yet.");

  expect(errors).toEqual([]);
  console.log(
    "Skills checks passed: create, edit, invoke with a slash command, include the text on that message, ignore a path, leave a later message alone, and delete. The provider was simulated.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
