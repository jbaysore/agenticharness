// Isolated UI checks: fixture providers only, no account access or inference.
// Cursor turned off stays out of the header, menus and composer; the context
// meter warns against Claude's reported compaction point.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";

const local = resolve(".local");
await mkdir(resolve(local, "screenshots"), { recursive: true });
const dataDir = await mkdtemp(resolve(local, "compaction-cursor-acceptance-"));
const app = await createHarness({ dataDir, port: 0, startProviders: false });
let browser;
const errors = [];
try {
  const project = app.store.addProject("Compaction fixtures", process.cwd());
  app.controller.providers = [["codex", "Codex"], ["claude", "Claude Code"]].map(([id, name]) => ({
    id,
    name,
    connected: true,
    usage: { authoritative: true, windows: [] },
    models: [{ id: `${id}-fixture`, name: `${name} fixture`, efforts: [], isDefault: true }],
  }));
  const cursorChat = app.store.createConversation({
    projectId: project.id, provider: "cursor", model: "cursor-fixture", title: "Earlier Cursor chat",
  });
  app.store.addMessage({ conversationId: cursorChat.id, role: "user", content: "Earlier Cursor work" });
  const claudeChat = app.store.createConversation({
    projectId: project.id, provider: "claude", model: "claude-fixture", title: "Claude near compaction",
  });
  const run = app.store.createRun({
    conversationId: claudeChat.id, actionId: "compaction-fixture", provider: "claude", model: "claude-fixture", text: "Fixture",
  });
  app.store.setRun(run.id, "completed");
  app.store.updateConversation(claudeChat.id, { sessions: { claude: { id: "native" } } });
  app.controller.event(claudeChat.id, run.id, "context-usage", {
    provider: "claude", sessionId: "native", model: "claude-fixture", generation: 0, state: "ready",
    usedTokens: 470000, windowTokens: 1000000, compactAtTokens: 600000,
    source: "Fixture provider report", accuracy: "provider-estimated", basis: "current-context",
    observedAt: new Date().toISOString(),
  });

  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1512, height: 982 } })).newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const url = (id) => `${app.runtime.origin}/?chat=${id}#pair=${app.auth.pairing()}`;

  await page.goto(url(cursorChat.id));
  await expect(page.locator(".model-trigger .provider-dot.codex")).toBeVisible();
  await expect(page.locator(".usage-chip.cursor")).toHaveCount(0);
  await page.getByRole("button", { name: "Agent and model", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Codex", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Cursor", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.locator(".usage-glance-trigger").click();
  await page.getByRole("button", { name: "Connections & usage…" }).click();
  const connections = page.getByRole("dialog", { name: "Connections & usage" });
  const cursorRow = connections.locator("section.connection.cursor");
  await expect(cursorRow).toContainText("Turned off");
  await expect(cursorRow.getByRole("button", { name: "Turn on" })).toBeVisible();
  await page.screenshot({ path: resolve(local, "screenshots", "cursor-off-connections.png") });
  await page.keyboard.press("Escape");

  await page.goto(url(claudeChat.id));
  const trigger = page.locator(".context-trigger");
  await expect(trigger).toContainText("Context 47%");
  await expect(trigger).toContainText("Costs usage");
  await trigger.click();
  const details = page.getByRole("dialog", { name: "Context details" });
  await expect(details).toContainText("Compacts at");
  await expect(details).toContainText("600,000 tokens");
  await page.screenshot({ path: resolve(local, "screenshots", "claude-compaction-point.png") });
  if (errors.length) throw new Error("Page errors: " + errors.join("; "));
  console.log("Compaction and Cursor-off acceptance passed.");
} finally {
  await browser?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
