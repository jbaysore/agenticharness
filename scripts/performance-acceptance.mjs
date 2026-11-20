// Real HTTP and browser, synthetic archive and provider. No inference.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createHarness } from "../src/server.mjs";

await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".local/performance-"));
const projectPath = join(dir, "project"),
  secondPath = join(dir, "second");
await mkdir(projectPath);
await mkdir(secondPath);
const app = await createHarness({
  dataDir: join(dir, "data"),
  port: 0,
  startProviders: false,
});
app.controller.worktreeRoot = null;
app.controller.openReviewer = null;
app.controller.providers = [
  {
    id: "codex",
    name: "Codex",
    connected: true,
    models: [{ id: "fixture", name: "Fixture", efforts: [] }],
  },
];
const project = app.store.addProject("Performance", projectPath);
app.store.addProject("Second", secondPath);
const chats = Array.from({ length: 4 }, () =>
  app.store.createConversation({ projectId: project.id, model: "fixture" }),
);
const insert = app.store.db.prepare(
  "INSERT INTO events(conversation_id,run_id,type,payload,created_at) VALUES(?,?,'work',?,?)",
);
const archivedOutput = JSON.stringify({
  kind: "command-output",
  delta: "archived fixture output ".repeat(40),
});
for (const chat of chats) {
  const createRun = () =>
    app.store.createRun({
      conversationId: chat.id,
      actionId: crypto.randomUUID(),
      provider: "codex",
      model: "fixture",
      text: "Fixture archive",
    });
  const oldest = createRun();
  app.store.setRun(oldest.id, "completed");
  const archivedAt = "2020-01-01T00:00:00.000Z";
  app.store.db
    .prepare("UPDATE runs SET created_at=? WHERE id=?")
    .run(archivedAt, oldest.id);
  for (let n = 0; n < 29; n++)
    app.store.setRun(createRun().id, "completed");
  const run = createRun();
  app.store.db.exec("BEGIN");
  for (let n = 0; n < 40_000; n++)
    insert.run(chat.id, oldest.id, archivedOutput, archivedAt);
  for (let n = 0; n < 8000; n++)
    insert.run(
      chat.id,
      run.id,
      n % 40
        ? '{"kind":"command-output","delta":"fixture output"}'
        : JSON.stringify({
            kind: "host-command",
            id: String(n),
            command: "node --version",
            status: "ok",
          }),
      app.store.now(),
    );
  app.store.setRun(run.id, "completed");
  app.store.db.exec("COMMIT");
}
app.store.db.exec("BEGIN");
for (let n = 0; n < 150_000; n++)
  insert.run(
    "unrelated",
    "unrelated",
    '{"kind":"command-output","delta":"unrelated archive content"}',
    app.store.now(),
  );
app.store.db.exec("COMMIT");
const samples = { snapshot: [], status: [], directory: [] };
const measure = async (kind, path) => {
  const start = performance.now();
  const response = await fetch(app.runtime.origin + path);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  samples[kind].push(performance.now() - start);
};
const stats = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    p50Ms: Math.round(sorted[Math.floor(sorted.length * 0.5)]),
    p95Ms: Math.round(
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    ),
  };
};
const results = {};
let browser;
try {
  for (let round = 0; round < 15; round++)
    await Promise.all([
      ...chats.map((chat) => measure("snapshot", `/api/chats/${chat.id}`)),
      ...chats.map((chat) => measure("status", `/api/chats/${chat.id}/status`)),
      measure(
        "directory",
        "/api/directories?" + new URLSearchParams({ path: projectPath }),
      ),
    ]);
  results.http = Object.fromEntries(
    Object.entries(samples).map(([key, values]) => [key, stats(values)]),
  );
  browser = await chromium.launch({ channel: "msedge", headless: true });
  results.browser = [];
  for (const latency of [0, 150]) {
    const page = await browser.newPage({
      viewport: { width: 1512, height: 982 },
    });
    const errors = [],
      requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) =>
      requests.push({
        path: new URL(request.url()).pathname,
        at: performance.now(),
      }),
    );
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency,
      downloadThroughput: 375_000,
      uploadThroughput: 375_000,
    });
    const chat = app.store.createConversation({
      projectId: project.id,
      provider: "codex",
      model: "fixture",
      mode: "goal",
    });
    let confirmedAt = Infinity;
    app.controller.runners.codex = async (ctx) => {
      ctx.saveSession({ id: "fixture" });
      ctx.goalState("active", "Exercise responsiveness");
      ctx.emit("text", { nativeId: "stream", delta: "Fixture is " });
      ctx.emit("text", { nativeId: "stream", delta: "streaming." });
      await new Promise((done) =>
        ctx.signal.addEventListener("abort", () => setTimeout(done, 2400), {
          once: true,
        }),
      );
      confirmedAt = performance.now();
      ctx.pauseConfirmed();
      return { status: "cancelled" };
    };
    await page.goto(`${app.runtime.origin}/?chat=${chat.id}`);
    const input = page.getByLabel("Message your coding agent");
    await input.fill("Exercise responsiveness");
    const directoryStart = performance.now();
    await page
      .getByRole("button", { name: "Change directory", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Choose a directory" });
    await dialog
      .getByRole("button", { name: "Open project Second", exact: true })
      .click();
    await expect(
      dialog.getByRole("textbox", { name: "Location", exact: true }),
    ).toHaveValue(secondPath);
    await expect(
      dialog.getByRole("button", { name: "Use this folder", exact: true }),
    ).toBeEnabled();
    await dialog
      .getByRole("button", { name: "Use this folder", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    const directoryMs = Math.round(performance.now() - directoryStart);
    await expect(input).toHaveValue("Exercise responsiveness");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      page.getByText("Fixture is streaming.", { exact: true }),
    ).toBeVisible();
    const stopStart = performance.now();
    await page.getByRole("button", { name: "Stop work", exact: true }).click();
    await expect(
      page.getByText("Pausing… waiting for provider confirmation", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Resume goal", exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    const snapshotsDuringPause = requests.filter(
      (request) =>
        request.path === `/api/chats/${chat.id}` &&
        request.at > stopStart + 300 &&
        request.at < confirmedAt,
    ).length;
    const statusPolls = requests.filter(
      (request) =>
        request.path === `/api/chats/${chat.id}/status` &&
        request.at > stopStart,
    ).length;
    assert.equal(
      snapshotsDuringPause,
      0,
      "Pause must not repeatedly load the full transcript",
    );
    assert.ok(statusPolls >= 1);
    assert.deepEqual(errors, []);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Resume goal", exact: true }),
    ).toBeVisible();
    results.browser.push({
      latencyMs: latency,
      directoryMs,
      statusPolls,
      snapshotsDuringPause,
    });
    await page.close();
  }
  await writeFile(join(dir, "results.json"), JSON.stringify(results, null, 2));
  console.log(
    JSON.stringify(
      { ...results, artifact: join(dir, "results.json") },
      null,
      2,
    ),
  );
  assert.ok(results.http.snapshot.p95Ms < 200, "snapshot p95 exceeds 200 ms");
  assert.ok(results.http.status.p95Ms < 100, "status p95 exceeds 100 ms");
  assert.ok(results.http.directory.p95Ms < 100, "directory p95 exceeds 100 ms");
} finally {
  await browser?.close();
  for (const chatId of app.controller.active.keys())
    app.controller.cancel(chatId);
  await app.close();
}
