// Browser reconnection with a simulated provider; no inference or live data.
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const dataDir = await mkdtemp(join(tmpdir(), "harness-restart-browser-"));
const client = resolve("dist/app.js"),
  original = await stat(client);
let app, browser;
const start = async (port = 0) => {
  const host = await createHarness({
    dataDir,
    port,
    startProviders: false,
    seedProject: dataDir,
  });
  host.controller.providers = [
    {
      id: "codex",
      name: "Restart fixture",
      connected: true,
      models: [{ id: "fixture", name: "No inference", efforts: [] }],
      capabilities: {},
    },
  ];
  host.controller.runners.codex = async (ctx) => {
    ctx.emit("text", { nativeId: randomUUID(), text: "Fixture complete." });
    return { status: "completed" };
  };
  return host;
};
try {
  app = await start();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.runtime.origin);
  await chooseModel(page, app.controller.providers, "codex", "fixture");
  const input = page.getByLabel("Message your coding agent");
  await input.fill("Create a fixture chat");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText("Fixture complete.", { exact: true }).first(),
  ).toBeVisible();
  await input.fill("Unsent draft survives a Harness update");
  await page.evaluate(() => {
    window.restartBrowserMarker = true;
  });
  app.controller.event(null, null, "self-restart", {
    id: "browser-fixture",
    status: "waiting",
    blockers: ["Open terminals"],
  });
  await expect(
    page.getByRole("status", { name: "Harness update status" }),
  ).toContainText("open terminals");
  const { port, instanceId } = app.runtime;
  const beforeBuild = await fetch(app.runtime.origin + "/health").then((r) =>
    r.json(),
  );
  await app.close();
  // Simulate a separately prepared client arriving with the replacement host.
  // Only this worktree's ignored build output changes; the live app is untouched.
  await utimes(client, original.atime, new Date(original.mtimeMs + 10000));
  app = await start(port);
  if (app.runtime.instanceId === instanceId)
    throw new Error("Fixture did not replace its host");
  const afterBuild = await fetch(app.runtime.origin + "/health").then((r) =>
    r.json(),
  );
  if (beforeBuild.build === afterBuild.build)
    throw new Error("Fixture did not change the client fingerprint");
  app.controller.event(null, null, "self-restart", {
    id: "browser-fixture",
    status: "updated",
    blockers: [],
  });
  await expect
    .poll(
      () =>
        page
          .evaluate(() => window.restartBrowserMarker ?? false)
          .catch((error) => {
            // The poll can overlap the reload it is waiting for.
            if (error.message.includes("Execution context was destroyed"))
              return true;
            throw error;
          }),
      {
        timeout: 20000,
      },
    )
    .toBe(false);
  await expect(input).toHaveValue("Unsent draft survives a Harness update");
  const chat = app.store.conversations()[0];
  if (app.store.messages(chat.id).filter((m) => m.role === "user").length !== 1)
    throw new Error("A message was replayed during reconnect");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "Passed: update blocker status, host reconnect, client reload, draft recovery, and no replay; no inference.",
  );
} finally {
  await browser?.close();
  await app?.close();
  await utimes(client, original.atime, original.mtime);
  await rm(dataDir, { recursive: true, force: true });
}
