// Real browser and host, simulated agent; consumes no inference.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, parse } from "node:path";
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
const nestedPath = join(firstPath, "Nested folder Ω");
await mkdir(join(nestedPath, "Empty"), { recursive: true });
for (const folder of ["docs", "scripts", "src", "test"])
  await mkdir(join(firstPath, folder));
await writeFile(
  join(firstPath, "file.txt"),
  "Only folders appear in the explorer",
);
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
  const location = dialog.getByRole("textbox", {
      name: "Location",
      exact: true,
    }),
    useFolder = dialog.getByRole("button", {
      name: "Use this folder",
      exact: true,
    });
  await expect(location).toHaveValue(firstPath);
  await expect(useFolder).toBeEnabled();
  await useFolder.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close dialog", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(useFolder).toBeFocused();
  await expect(
    dialog.getByRole("button", {
      name: "Open folder Nested folder Ω",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Open folder file.txt", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: ".local/screenshots/directory-explorer-desktop.png",
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "Open folder Nested folder Ω", exact: true })
    .press("Enter");
  const emptyFolder = dialog.getByRole("button", {
    name: "Open folder Empty",
    exact: true,
  });
  await expect(emptyFolder).toBeFocused();
  await emptyFolder.press("Enter");
  await expect(
    dialog.getByText("No subfolders. You can use this folder.", {
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Up one folder", exact: true })
    .click();
  await expect(location).toHaveValue(nestedPath);
  await dialog
    .getByRole("navigation", { name: "Folder path", exact: true })
    .getByRole("button", { name: "first", exact: true })
    .click();
  await expect(location).toHaveValue(firstPath);
  // A slow earlier request must not replace a more recent destination.
  let releaseListing, listingStarted;
  const delayedListing = new Promise((resolve) => {
    releaseListing = resolve;
  });
  const started = new Promise((resolve) => {
    listingStarted = resolve;
  });
  await page.route("**/api/directories?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("path") !== nestedPath)
      return route.continue();
    const response = await route.fetch();
    listingStarted();
    await delayedListing;
    await route.fulfill({ response });
  });
  await dialog
    .getByRole("button", { name: "Open folder Nested folder Ω", exact: true })
    .click();
  await started;
  await expect(useFolder).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Open project Second project", exact: true })
    .click();
  await expect(useFolder).toBeEnabled();
  await expect(location).toHaveValue(secondPath);
  const slowResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/directories" &&
      new URL(response.url()).searchParams.get("path") === nestedPath,
  );
  releaseListing();
  await (await slowResponse).finished();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(location).toHaveValue(secondPath);
  await page.unroute("**/api/directories?*");
  await dialog
    .getByRole("button", { name: "Open project first", exact: true })
    .click();
  await expect(useFolder).toBeEnabled();
  // Unreadable locations leave the last valid listing and allow recovery.
  await page.route("**/api/directories?*", (route) => {
    if (new URL(route.request().url()).searchParams.get("path") !== nestedPath)
      return route.continue();
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error:
          "This folder cannot be opened. Choose a folder you have permission to access.",
      }),
    });
  });
  await dialog
    .getByRole("button", { name: "Open folder Nested folder Ω", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("permission to access");
  await expect(useFolder).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Open folder src", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/directories?*");
  await dialog
    .getByRole("button", { name: "Open project first", exact: true })
    .click();
  await expect(useFolder).toBeEnabled();
  await dialog.getByRole("button", { name: "Go to Home", exact: true }).click();
  await expect(location).toHaveValue(await realpath(homedir()));
  await dialog
    .getByRole("button", {
      name: `Go to ${parse(firstPath).root}`,
      exact: true,
    })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Up one folder", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Open project Second project", exact: true })
    .click();
  await expect(location).toHaveValue(secondPath);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute(
    "title",
    `Change directory: ${firstPath}`,
  );
  await expect(input).toHaveValue(
    "Keep this first message while changing folders",
  );
  await trigger.click();
  await dialog
    .getByRole("button", { name: "Open project Second project", exact: true })
    .click();
  await page.route(`**/api/projects/${second.id}/attachments`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Copy fixture failed" }),
    }),
  );
  await useFolder.click();
  await expect(dialog.getByRole("alert")).toContainText("Copy fixture failed");
  await expect(trigger).toHaveAttribute(
    "title",
    `Change directory: ${firstPath}`,
  );
  await expect(files.getByText("notes.txt")).toBeVisible();
  await page.unroute(`**/api/projects/${second.id}/attachments`);
  await useFolder.click();
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
  await expect(input).toHaveValue("");
  await input.fill("A second unsent draft");
  const empty = app.store.conversations().find((c) => c.id !== chat.id);
  await trigger.click();
  await location.fill(join(dir, "missing"));
  await expect(useFolder).toBeDisabled();
  await location.press("Enter");
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(useFolder).toBeDisabled();
  await expect(input).toHaveValue("A second unsent draft");
  expect(attempts).toHaveLength(0);
  expect(app.store.conversation(empty.id).project_id).toBe(second.id);
  await dialog
    .getByRole("button", { name: "Up one folder", exact: true })
    .click();
  await dialog
    .getByRole("button", {
      name: `Open folder ${basename(newPath)}`,
      exact: true,
    })
    .click();
  await expect(useFolder).toBeEnabled();
  expect(app.store.conversation(empty.id).project_id).toBe(second.id);
  await useFolder.click();
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
  await expect(useFolder).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/directory-explorer-mobile.png",
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
    .getByRole("button", { name: "Open project first", exact: true })
    .click();
  await useFolder.click();
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
    ).toBeEnabled();
    await welcome
      .getByRole("button", { name: "Change directory", exact: true })
      .click();
    const welcomeLocation = welcome.getByRole("textbox", {
      name: "Location",
      exact: true,
    });
    await expect(welcomeLocation).toHaveValue(await realpath(homedir()));
    await welcomeLocation.fill(firstPath);
    await welcomeLocation.press("Enter");
    await welcome
      .getByRole("button", { name: "Use this folder", exact: true })
      .click();
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
    "Directory acceptance passed: folder and breadcrumb navigation, Home/drives/projects, keyboard focus, cancellation, stale responses, permission errors, optional paths, draft/attachment preservation, split panes, mobile layout, and first-message working directory. No inference.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
