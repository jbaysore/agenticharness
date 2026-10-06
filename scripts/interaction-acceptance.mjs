// Real provider cancellation plus browser-driven review/revision in the ignored fixture.
import { createHarness } from "../src/server.mjs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
const exec = promisify(execFile),
  fixture = resolve(".local/dogfood-project"),
  app = await createHarness({
    dataDir: resolve(".local/acceptance"),
    port: 0,
    startProviders: false,
  }),
  results = [];
async function finished(chat) {
  const deadline = Date.now() + 180000;
  while (app.controller.active.has(chat.id)) {
    if (Date.now() > deadline) {
      app.controller.cancel(chat.id);
      throw new Error("Turn timed out");
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}
let browser;
try {
  await app.controller.refreshProviders();
  const project = app.store.projects().find((p) => p.path === fixture);
  for (const provider of process.argv.includes("--revision-only")
    ? []
    : ["codex", "claude", "cursor"]) {
    const p = app.controller.providers.find((p) => p.id === provider);
    if (p.blockReason) throw new Error(p.blockReason);
    const model =
        p.models.find((m) => m.isDefault && !m.disabled) ??
        p.models.find((m) => !m.disabled),
      chat = app.store.createConversation({
        projectId: project.id,
        title: "Cancellation check · " + provider,
      });
    let started,
      firstText = false;
    const listener = (e) => {
      if (e.conversationId === chat.id && e.type === "text" && !firstText) {
        firstText = true;
        started = Date.now();
        app.controller.cancel(chat.id);
      }
    };
    app.controller.on("event", listener);
    const run = app.controller.send(chat.id, {
      actionId: randomUUID(),
      provider,
      model: model.id,
      effort: model.defaultEffort,
      text: "Without tools or file changes, explain the event loop in JavaScript in five paragraphs. This is a cancellation acceptance test; the client will stop after output begins.",
    });
    await finished(chat);
    app.controller.off("event", listener);
    const result = {
      check: "real-in-flight-cancel",
      provider,
      status: app.store.run(run.id).status,
      receivedRealText: firstText,
      stopMilliseconds: Date.now() - started,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    if (
      !firstText ||
      result.status !== "cancelled" ||
      result.stopMilliseconds > 12000
    )
      throw new Error("In-flight cancellation check failed");
  }
  const chat = app.store
    .conversations()
    .find(
      (c) =>
        Object.keys(c.sessions).length === 3 &&
        app.store.messages(c.id).some((m) => m.content.includes("4 of 4")),
    );
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  await page.goto(
    `${app.runtime.origin}/?chat=${chat.id}#pair=${app.auth.pairing()}`,
  );
  const cursor = app.controller.providers
    .find((p) => p.id === "cursor")
    .models.find((m) => m.isDefault && !m.disabled);
  await page.getByLabel("Agent and model").selectOption("cursor|" + cursor.id);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "title.mjs M", exact: true }).click();
  await page
    .locator(".review-comment textarea")
    .fill(
      "Handle null and undefined prefixes as Task. Add a test for each and preserve the four string-input tests. Run node --test. Also delegate one tiny read-only native subagent review of the expression and wait for it. Make changes only in this fixture. Do not commit.",
    );
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(page.locator(".review-summary")).toContainText(
    "Handle null and undefined prefixes as Task.",
  );
  await expect(page.locator(".review-comment textarea")).toHaveValue("");
  const last = app.store.latestEventId();
  await page
    .getByRole("button", { name: "Ask for revisions", exact: true })
    .click();
  await expect(page.getByLabel("Stop work")).toBeVisible();
  let approvalCount = 0,
    screenshot = false;
  const deadline = Date.now() + 180000;
  while (app.controller.active.has(chat.id)) {
    if (Date.now() > deadline) {
      app.controller.cancel(chat.id);
      throw new Error("Revision timed out");
    }
    const pending = app.store.pendingApprovals(chat.id);
    for (const approval of pending) {
      const r = approval.request,
        d = r.details ?? {},
        command = d.command ?? d.title ?? "";
      const allow =
        r.kind === "permission" &&
        /node --test|Get-Content|git (status|diff)|Task:|history_/.test(
          command + " " + r.title,
        ) &&
        !/Remove-Item|Invoke-|curl|wget|git (push|commit|reset)|https?:/i.test(
          command,
        );
      const section = page.locator(".approval").filter({
        has: page.getByRole("heading", { name: r.title, exact: true }),
      });
      await expect(section).toBeVisible();
      if (!screenshot) {
        await section.locator("summary").click();
        await page.screenshot({
          path: ".local/screenshots/real-approval.png",
          fullPage: true,
        });
        screenshot = true;
      }
      await section
        .getByRole("button", {
          name: allow ? "Allow once" : "Decline",
          exact: true,
        })
        .click();
      approvalCount++;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const latest = app.store.conversationSnapshot(chat.id).runs[0];
  if (latest.status !== "completed")
    throw new Error(latest.error ?? "Revision failed");
  const verification = await exec(process.execPath, ["--test"], {
    cwd: fixture,
    windowsHide: true,
  });
  const module = await import(
    "file:///" +
      join(fixture, "title.mjs").replaceAll("\\", "/") +
      "?at=" +
      Date.now()
  );
  if (
    module.issueTitle(null, "hello") !== "Task: hello" ||
    module.issueTitle(undefined, "hello") !== "Task: hello"
  )
    throw new Error("The requested revision did not work");
  const events = app.store.events(last, 2000),
    subagents = events.filter(
      (e) => e.runId === latest.id && e.payload.kind === "native-subagent",
    );
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(
    page.locator(".work-item").filter({ hasText: "Native subagent" }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: ".local/screenshots/real-revision-subagent.png",
    fullPage: true,
  });
  const result = {
    check: "browser-real-review-revision-approval",
    provider: "cursor",
    status: latest.status,
    approvalCount,
    nativeSubagentEvents: subagents.length,
    verification: verification.stdout,
  };
  results.push(result);
  console.log(JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  await writeFile(
    ".local/interaction-acceptance.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        type: "real-provider-and-browser",
        results,
      },
      null,
      2,
    ),
  );
  await app.close();
}
