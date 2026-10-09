// Actual browser/HTTP, explicitly simulated provider, no inference.
import { createHarness } from "../src/server.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = await mkdtemp(join(tmpdir(), "harness-outbox-")),
  app = await createHarness({
    dataDir: dir,
    port: 0,
    startProviders: false,
    seedProject: dir,
  });
app.controller.providers = [
  {
    id: "codex",
    name: "Transport fixture",
    connected: true,
    models: [
      { id: "fixture", name: "No inference", efforts: [], isDefault: true },
    ],
    capabilities: {},
  },
];
app.controller.execute = async (run) => {
  await new Promise((r) => setTimeout(r, 100));
  app.store.setRun(run.id, "completed");
  app.controller.active.delete(run.conversation_id);
  app.controller.event(run.conversation_id, run.id, "run", {
    status: "completed",
  });
};
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage();
  await page.goto(app.runtime.origin + "/#pair=" + app.auth.pairing());
  await page.getByLabel("Agent and model").selectOption("codex|fixture");
  await page
    .getByLabel("Message your coding agent")
    .fill("Accepted once even when the response is lost");
  await page.route("**/api/chats/*/messages", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByLabel("Send message").click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Message your coding agent")).toHaveValue("");
  expect(app.store.db.prepare("SELECT count(*) AS n FROM runs").get().n).toBe(
    1,
  );
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("harness.pending-submissions.v2"),
    ),
  ).toBeNull();
  await page.unroute("**/api/chats/*/messages");
  await page.route("**/api/chats/*/messages", (route) => route.abort("failed"));
  await page
    .getByLabel("Message your coding agent")
    .fill("Not received yet, keep this action ID");
  await page.getByLabel("Send message").click();
  await expect(page.getByRole("alert")).toBeVisible();
  const [pending] = await page.evaluate(() =>
    Object.values(
      JSON.parse(sessionStorage.getItem("harness.pending-submissions.v2")),
    ),
  );
  await page.reload();
  await expect(page.getByLabel("Message your coding agent")).toHaveValue(
    "Not received yet, keep this action ID",
  );
  await page.unroute("**/api/chats/*/messages");
  await page.getByLabel("Send message").click();
  await expect
    .poll(() => app.store.runForAction(pending.actionId)?.status)
    .toBe("completed");
  expect(app.store.db.prepare("SELECT count(*) AS n FROM runs").get().n).toBe(
    2,
  );
  console.log(
    "Browser outbox passed: accepted lost response reconciles; unreceived request keeps its action ID across reload. Provider was simulated.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
