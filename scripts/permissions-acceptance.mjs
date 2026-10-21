// Isolated permission-picker checks with a simulated provider; no inference.
import { chromium, expect, devices } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";

await mkdir(".local/screenshots", { recursive: true });
const app = await createHarness({
  dataDir: await mkdtemp(resolve(".local/permissions-")),
  port: 0,
  startProviders: false,
  seedProject: process.cwd(),
});
app.controller.providers = [
  {
    id: "codex",
    name: "Codex",
    connected: true,
    models: [{ id: "fixture", name: "Permission fixture", efforts: [] }],
  },
];
const attempts = [],
  errors = [];
app.controller.runners.codex = async (ctx) => {
  attempts.push(ctx);
  ctx.saveSession({ id: "same-permission-session" });
  const answer = await ctx.approve({
    kind: "permission",
    title: "Edit the fixture",
  });
  if (!ctx.signal.aborted && answer.allow)
    await ctx.approve({ kind: "question", title: "Which fixture?" });
  return { status: "cancelled" };
};
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.runtime.origin);
  const picker = page.getByLabel("Permissions", { exact: true });
  await expect(picker).toHaveValue("auto");
  await chooseModel(page, app.controller.providers, "codex", "fixture");
  await page.getByLabel("Message your coding agent").fill("Change a fixture");
  await page.getByLabel("Send message").click();
  await expect.poll(() => attempts.length).toBe(1);
  await expect(picker).toBeEnabled();
  const chat = app.store.conversations()[0],
    run = app.store.activeRun(chat.id);
  expect(attempts[0].permissions).toBe("auto");
  await picker.selectOption("manual");
  await expect(picker).toBeEnabled();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1].permissions).toBe("manual");
  expect(attempts[1].session.id).toBe("same-permission-session");
  expect(app.store.activeRun(chat.id).id).toBe(run.id);
  await page.reload();
  await expect(picker).toHaveValue("manual");

  // A second client receives selections during the same running turn.
  const mobile = await browser.newContext({ ...devices["iPhone 13"] }),
    phone = await mobile.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(`${app.runtime.origin}/?chat=${chat.id}`);
  await expect(phone.getByLabel("Permissions", { exact: true })).toHaveValue(
    "manual",
  );
  await picker.selectOption("override");
  await expect(picker).toBeEnabled();
  await expect.poll(() => attempts.length).toBe(3);
  expect(attempts[2].permissions).toBe("override");
  await expect(phone.getByLabel("Permissions", { exact: true })).toHaveValue(
    "override",
  );
  await expect
    .poll(() => app.store.pendingApprovals(chat.id)[0]?.request.kind)
    .toBe("question");
  await page.screenshot({ path: ".local/screenshots/permissions-desktop.png" });

  await phone.getByLabel("Permissions", { exact: true }).selectOption("auto");
  await expect(picker).toHaveValue("auto");
  await expect.poll(() => attempts.length).toBe(4);
  expect(attempts[3].permissions).toBe("auto");
  expect(app.store.activeRun(chat.id).id).toBe(run.id);
  expect(
    app.store.messages(chat.id).filter((m) => m.role === "user"),
  ).toHaveLength(1);
  await phone.screenshot({ path: ".local/screenshots/permissions-phone.png" });
  await phone.getByLabel("Stop work").click();
  await expect.poll(() => app.store.activeRun(chat.id)).toBeFalsy();
  expect(attempts).toHaveLength(4);

  // Failed saves restore the stored mode and leave the control usable.
  await page.route("**/api/chats/" + chat.id, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Fixture save failed" }),
        })
      : route.continue(),
  );
  await picker.selectOption("manual");
  await expect(picker).toBeEnabled();
  await expect(picker).toHaveValue("auto");
  expect(app.store.conversation(chat.id).permissions).toBe("auto");
  await page.unroute("**/api/chats/" + chat.id);
  await picker.selectOption("manual");
  await expect(picker).toBeEnabled();
  expect(app.store.conversation(chat.id).permissions).toBe("manual");
  expect(attempts).toHaveLength(4);
  await page.reload();
  await expect(picker).toHaveValue("manual");
  expect(errors).toEqual([]);
  console.log(
    "Permission checks passed: auto-review default, all live modes, same run and session, pending approvals, desktop/mobile sync, reload persistence, stop, and failed saves.",
  );
} finally {
  await browser?.close();
  await app.close();
}
