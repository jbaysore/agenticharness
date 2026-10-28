// Real browser and host, simulated agent; consumes no inference.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";

const dir = await mkdtemp(join(tmpdir(), "harness-directoryless-browser-")),
  projectPath = join(dir, "project");
await mkdir(projectPath);
const app = await createHarness({
  dataDir: join(dir, "data"),
  port: 0,
  startProviders: false,
});
app.controller.providers = [
  {
    id: "codex",
    name: "Codex",
    connected: true,
    models: [{ id: "fixture", name: "Directoryless fixture", efforts: [] }],
  },
];
const attempts = [],
  errors = [];
app.controller.runners.codex = async (ctx) => {
  attempts.push(ctx);
  ctx.emit("text", { nativeId: "reply", text: "General chat reply" });
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
    newChat = page.getByRole("button", {
      name: "New conversation without a directory",
      exact: true,
    }),
    dialog = page.getByRole("dialog", { name: "Choose a directory" }),
    files = page.getByRole("list", { name: "Attached files", exact: true });
  await expect(input).toBeEnabled();
  await expect(trigger).toHaveText(/No directory/);
  await chooseModel(page, app.controller.providers, "codex", "fixture");
  await input.fill("A question without a project");
  const note = {
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("General attachment"),
  };
  await page.route(
    "**/api/chats",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Chat creation failed in fixture" }),
      }),
    { times: 1 },
  );
  await page.getByLabel("Upload files", { exact: true }).setInputFiles(note);
  await expect(page.getByRole("alert")).toContainText(
    "Chat creation failed in fixture",
  );
  expect(app.store.conversations()).toHaveLength(0);
  await page
    .getByRole("button", { name: "Dismiss error", exact: true })
    .click();
  await page.getByLabel("Upload files", { exact: true }).setInputFiles(note);
  await expect(files.getByText("notes.txt")).toBeVisible();
  await expect(input).toHaveValue("A question without a project");
  const first = app.store.conversations()[0],
    firstHome = app.store.project(first.project_id);
  expect(first.directoryless).toBe(true);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => attempts.length).toBe(1);
  await expect(input).toHaveValue("");
  await expect(trigger).toHaveCount(0);
  const workPanel = page.getByRole("button", {
    name: "Toggle work panel",
    exact: true,
  });
  if ((await workPanel.getAttribute("aria-expanded")) !== "true")
    await workPanel.click();
  await expect(
    page.getByRole("heading", { name: "No project directory", exact: true }),
  ).toBeVisible();
  await workPanel.click();
  expect(attempts[0].project.path).toBe(firstHome.path);
  expect(await readFile(attempts[0].attachments[0].path, "utf8")).toBe(
    "General attachment",
  );
  await page.reload();
  await expect(
    page.getByText("General chat reply", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".project")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Search conversations", exact: true })
    .click();
  await expect(page.getByLabel("Search scope", { exact: true })).toHaveValue(
    "project",
  );
  await page.getByLabel("Search history", { exact: true }).fill("question");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".search-results button")).toHaveCount(1);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();

  await newChat.click();
  await expect(trigger).toBeVisible();
  const second = app.store.conversations().find((c) => c.id !== first.id);
  expect(app.store.project(second.project_id).path).not.toBe(firstHome.path);
  // Drafts, settings and attachments survive both directions of the picker.
  await input.fill("Keep this draft while changing directories");
  await page.getByLabel("Permissions", { exact: true }).selectOption("manual");
  await page.getByLabel("Mode", { exact: true }).selectOption("plan");
  await trigger.click();
  const location = dialog.getByRole("textbox", {
    name: "Location",
    exact: true,
  });
  await location.fill(projectPath);
  await location.press("Enter");
  await dialog
    .getByRole("button", { name: "Use this folder", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toHaveAttribute(
    "title",
    `Change directory: ${projectPath}`,
  );
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Draft attachment"),
  });
  await expect(files.getByText("draft.txt")).toBeVisible();
  await trigger.click();
  await dialog
    .getByRole("button", { name: "No directory", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toHaveText(/No directory/);
  await expect(input).toHaveValue("Keep this draft while changing directories");
  await expect(page.getByLabel("Permissions", { exact: true })).toHaveValue(
    "manual",
  );
  await expect(page.getByLabel("Mode", { exact: true })).toHaveValue("plan");
  await expect(files.getByText("draft.txt")).toBeVisible();
  expect(app.store.conversation(second.id).directoryless).toBe(true);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1].chat.id).toBe(second.id);
  expect(attempts[1].project.path).not.toBe(firstHome.path);
  expect(await readFile(attempts[1].attachments[0].path, "utf8")).toBe(
    "Draft attachment",
  );
  await page.reload();
  await expect(page.locator(".project")).toHaveCount(2); // One group plus the chosen user project.
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await expect(trigger).toHaveText(/No directory/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(input).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  console.log(
    "Directoryless acceptance passed: fresh workspace, upload recovery, attachments, replies, reloads, search, private workspaces, sidebar grouping, review panel, new chats, directory switching with draft/settings/files preserved, and mobile composer. No inference.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
