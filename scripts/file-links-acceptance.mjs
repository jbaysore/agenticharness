// Opens one linked project file from a message. No inference.
import { chromium, expect } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server.mjs";

const app = await createHarness({
  dataDir: await mkdtemp(join(tmpdir(), "harness-file-links-")),
  port: 0,
  startProviders: false,
  seedProject: process.cwd(),
});
let browser;
const errors = [];
try {
  const project = app.store.projects().find((item) => !item.scratch);
  const chat = app.store.createConversation({
    projectId: project.id,
    title: "File links",
    provider: "codex",
    model: "fixture",
  });
  app.store.addMessage({
    conversationId: chat.id,
    role: "assistant",
    provider: "codex",
    model: "fixture",
    content:
      "Setup is described in [README.md](harness://file/README.md#L100). README.md is named again without a link.",
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.runtime.origin + "/?chat=" + chat.id);
  const link = page.locator('.markdown a[href*="file="]');
  await expect(link).toHaveCount(1);
  await link.click();
  await expect(page.getByRole("button", { name: "Files", exact: true })).toHaveClass(
    /active/,
  );
  await expect(page.locator(".file-preview")).toContainText("Agentic Harness");
  await expect
    .poll(() => page.locator(".file-preview pre").evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("File link opened README.md in the Files panel.");
} finally {
  await browser?.close();
  await app.close();
}
