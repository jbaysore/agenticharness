// Real browser and HTTP storage, simulated agent; consumes no inference.
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "harness-attachments-browser-")),
  app = await createHarness({
    dataDir: dir,
    port: 0,
    startProviders: false,
    seedProject: dir,
  });
app.controller.providers = [
  {
    id: "codex",
    name: "Attachment fixture",
    connected: true,
    models: [{ id: "fixture", name: "No inference", efforts: [] }],
    capabilities: {},
  },
];
const contexts = [];
app.controller.runners.codex = async (ctx) => {
  contexts.push(ctx);
  return { status: "completed" };
};
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.runtime.origin);
  await chooseModel(page, app.controller.providers, "codex", "fixture");
  const input = page.getByLabel("Message your coding agent"),
    files = page.getByRole("list", { name: "Attached files", exact: true });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach files", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Attachment evidence"),
  });
  await expect(files.getByText("notes.txt")).toBeVisible();
  await input.fill("Check these files");
  const pixel =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  await input.evaluate((field, base64) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(
        [Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))],
        "image.png",
        { type: "image/png" },
      ),
    );
    field.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, pixel);
  await expect(files.getByRole("img")).toBeVisible();
  await expect
    .poll(() => files.getByRole("img").evaluate((img) => img.naturalWidth))
    .toBe(1);
  await expect(input).toHaveValue("Check these files");
  await page.reload();
  await expect(input).toHaveValue("Check these files");
  await chooseModel(page, app.controller.providers, "codex", "fixture");
  await expect(files.getByRole("listitem")).toHaveCount(2);
  await files.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(files.getByRole("listitem")).toHaveCount(1);
  await page.locator(".composer").evaluate((form) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["Dropped evidence"], "dropped.txt", { type: "text/plain" }),
    );
    form.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(files.getByText("dropped.txt")).toBeVisible();
  await input.fill("");
  await expect(page.getByLabel("Send message", { exact: true })).toBeEnabled();
  await input.press("Enter");
  await expect(
    page
      .getByRole("list", { name: "Message attachments", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(2);
  await expect(files).toHaveCount(0);
  expect(contexts).toHaveLength(1);
  expect(contexts[0].attachments).toHaveLength(2);
  expect(contexts[0].text).toContain("dropped.txt");
  await page.reload();
  await expect(
    page
      .getByRole("list", { name: "Message attachments", exact: true })
      .getByRole("img"),
  ).toBeVisible();

  // Failed uploads leave the current draft untouched.
  await input.fill("Draft survives a failed upload");
  await page.route("**/api/projects/*/attachments", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "Upload fixture failed" }),
    }),
  );
  await page
    .getByLabel("Upload files", { exact: true })
    .setInputFiles({
      name: "failure.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("x"),
    });
  await expect(page.getByRole("alert")).toContainText("Upload fixture failed");
  await expect(input).toHaveValue("Draft survives a failed upload");
  await expect(files).toHaveCount(0);
  await page.unroute("**/api/projects/*/attachments");

  await page
    .getByLabel("Upload files", { exact: true })
    .setInputFiles({
      name: "retry.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Retry evidence"),
    });
  await expect(files.getByText("retry.txt")).toBeVisible();
  // An unreceived submission retains its attachment and original action ID.
  await page.route("**/api/chats/*/messages", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Message fixture unavailable" }),
    }),
  );
  await page.getByLabel("Send message", { exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Message fixture unavailable",
  );
  const pending = await page.evaluate(
    () =>
      Object.values(
        JSON.parse(sessionStorage.getItem("harness.pending-submissions.v2")),
      )[0],
  );
  await page.reload();
  await expect(files.getByText("retry.txt")).toBeVisible();
  await expect(input).toHaveValue("Draft survives a failed upload");
  await page.unroute("**/api/chats/*/messages");
  // The server accepts this retry but its response is lost.
  await page.route("**/api/chats/*/messages", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByLabel("Send message", { exact: true }).click();
  await expect
    .poll(() => app.store.runForAction(pending.actionId)?.status)
    .toBe("completed");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.reload();
  await expect(input).toHaveValue("");
  await expect(files).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "Message attachments", exact: true }),
  ).toHaveCount(2);
  expect(contexts).toHaveLength(2);
  expect(app.store.db.prepare("SELECT count(*) AS n FROM runs").get().n).toBe(
    2,
  );
  expect(errors).toEqual([]);
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({
    path: ".local/screenshots/attachments-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByLabel("Upload files", { exact: true })
    .setInputFiles({
      name: "a-very-long-attachment-filename-to-check-small-screens.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Mobile draft"),
    });
  await expect(files.getByRole("listitem")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Attach files", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/attachments-mobile.png",
    fullPage: true,
  });
  console.log(
    "Attachments browser acceptance passed: picker, screenshot paste, drop, removal, attachment-only send, draft reload, failed upload, and idempotent retry. Agent simulated; no inference.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
