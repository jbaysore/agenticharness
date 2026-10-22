// Real browser and host, simulated agent; consumes no inference.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";

const dir = await mkdtemp(join(tmpdir(), "harness-directory-browser-")),
  firstPath = join(dir, "first"),
  secondPath = join(dir, "second"),
  newPath = join(
    dir,
    "another-directory-with-a-long-name-to-check-mobile-layout",
  );
for (const path of [firstPath, secondPath, newPath])
  await mkdir(path, { recursive: true });
await mkdir(".local/screenshots", { recursive: true });
const app = await createHarness({
  dataDir: join(dir, "data"),
  port: 0,
  startProviders: false,
  seedProject: firstPath,
});
const second = app.store.addProject("Second project", secondPath);
app.controller.providers = [
  {
    id: "codex",
    name: "Codex",
    connected: true,
    models: [{ id: "fixture", name: "Directory fixture", efforts: [] }],
  },
];
const attempts = [],
  errors = [];
app.controller.runners.codex = async (ctx) => {
  attempts.push(ctx);
  return { status: "completed" };
};
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.runtime.origin);
  const input = page.getByLabel("Message your coding agent"),
    trigger = page.getByRole("button", {
      name: "Change directory",
      exact: true,
    }),
    dialog = page.getByRole("dialog", { name: "Choose a directory" }),
    files = page.getByRole("list", { name: "Attached files", exact: true });
  await chooseModel(page, app.controller.providers, "codex", "fixture");
  await input.fill("Keep this first message while changing folders");
  await page.getByLabel("Permissions", { exact: true }).selectOption("manual");
  await page.getByLabel("Mode", { exact: true }).selectOption("plan");
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Keep this attachment"),
  });
  await expect(files.getByText("notes.txt")).toBeVisible();
  await trigger.click();
  await dialog.getByLabel("Project directory").selectOption(second.id);
  await page.route(`**/api/projects/${second.id}/attachments`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Copy fixture failed" }),
    }),
  );
  await dialog.getByRole("button", { name: "Use directory" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Copy fixture failed");
  await expect(trigger).toHaveAttribute(
    "title",
    `Change directory: ${firstPath}`,
  );
  await expect(files.getByText("notes.txt")).toBeVisible();
  await page.unroute(`**/api/projects/${second.id}/attachments`);
  await dialog.getByRole("button", { name: "Use directory" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toContainText("Second project");
  await expect(trigger).toHaveAttribute(
    "title",
    `Change directory: ${secondPath}`,
  );
  await expect(input).toHaveValue(
    "Keep this first message while changing folders",
  );
  await expect(files.getByText("notes.txt")).toBeVisible();
  await expect(page.getByLabel("Mode", { exact: true })).toHaveValue("plan");
  const chat = app.store.conversations()[0];
  expect(chat.project_id).toBe(second.id);
  await page.reload();
  await expect(trigger).toHaveAttribute(
    "title",
    `Change directory: ${secondPath}`,
  );
  await expect(input).toHaveValue(
    "Keep this first message while changing folders",
  );
  await expect(files.getByText("notes.txt")).toBeVisible();

  // The sidebar's New conversation creates an empty chat that can also move.
  await page.locator(".new-chat").click();
  await input.fill("A second unsent draft");
  const empty = app.store.conversations().find((c) => c.id !== chat.id);
  await trigger.click();
  await dialog.getByLabel("Project directory").selectOption("");
  await dialog.getByLabel("Folder path").fill(join(dir, "missing"));
  await dialog.getByRole("button", { name: "Use directory" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(input).toHaveValue("A second unsent draft");
  expect(app.store.conversation(empty.id).project_id).toBe(second.id);
  await dialog.getByLabel("Folder path").fill(newPath);
  await dialog.getByRole("button", { name: "Use directory" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toHaveAttribute(
    "title",
    `Change directory: ${newPath}`,
  );
  expect(app.store.conversation(empty.id).id).toBe(empty.id);
  expect(
    app.store.project(app.store.conversation(empty.id).project_id).path,
  ).toBe(newPath);
  await page.screenshot({
    path: ".local/screenshots/directory-desktop.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(dialog).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/directory-mobile.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  // Sending from the original draft uses its selected directory and attachment.
  await page.goto(`${app.runtime.origin}/?chat=${chat.id}`);
  await expect(files.getByText("notes.txt")).toBeVisible();
  await page.getByLabel("Send message", { exact: true }).click();
  await expect.poll(() => attempts.length).toBe(1);
  expect(attempts[0].project.path).toBe(secondPath);
  expect(attempts[0].permissions).toBe("manual");
  expect(attempts[0].mode).toBe("plan");
  expect(attempts[0].attachments).toHaveLength(1);
  expect(app.store.attachment(attempts[0].attachments[0].id).project_id).toBe(
    second.id,
  );
  await expect(trigger).toHaveCount(0);

  // Changing a split pane's directory keeps its neighbour and both drafts.
  await page.setViewportSize({ width: 1920, height: 1000 });
  await input.fill("Neighbour draft");
  await page
    .getByRole("button", { name: "Add a pane beside", exact: true })
    .click();
  const pane = page.locator(".chat-pane").last();
  await pane.getByLabel("Message your coding agent").fill("Split draft");
  await pane
    .getByRole("button", { name: "Change directory", exact: true })
    .click();
  await dialog
    .getByLabel("Project directory")
    .selectOption(app.store.projects()[0].id);
  await dialog.getByRole("button", { name: "Use directory" }).click();
  await expect(dialog).toBeHidden();
  await expect(pane.getByLabel("Message your coding agent")).toHaveValue(
    "Split draft",
  );
  await expect(
    pane.getByRole("button", { name: "Change directory", exact: true }),
  ).toHaveAttribute("title", `Change directory: ${firstPath}`);
  expect(app.store.conversation(chat.id).project_id).toBe(second.id);
  await expect(
    page.locator(".chat-pane").first().getByLabel("Message your coding agent"),
  ).toHaveValue("Neighbour draft");
  await expect(page.locator(".chat-pane")).toHaveCount(2);

  // A fresh workspace can choose its first directory from the composer.
  const fresh = await createHarness({
    dataDir: join(dir, "fresh"),
    port: 0,
    startProviders: false,
  });
  const context = await browser.newContext();
  try {
    fresh.controller.providers = app.controller.providers;
    const welcome = await context.newPage();
    await welcome.goto(fresh.runtime.origin);
    await expect(
      welcome.getByLabel("Message your coding agent"),
    ).toBeDisabled();
    await welcome
      .getByRole("button", { name: "Change directory", exact: true })
      .click();
    await welcome.getByLabel("Folder path").fill(firstPath);
    await welcome.getByRole("button", { name: "Use directory" }).click();
    await expect(welcome.getByRole("dialog")).toBeHidden();
    await expect(welcome.getByLabel("Message your coding agent")).toBeEnabled();
    expect(
      fresh.store.project(fresh.store.conversations()[0].project_id).path,
    ).toBe(firstPath);
  } finally {
    await context.close();
    await fresh.close();
  }
  expect(errors).toEqual([]);
  console.log(
    "Directory acceptance passed: initial and saved drafts, attachments, reload, existing/new/invalid paths, mobile layout, and first-message working directory. No inference.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
