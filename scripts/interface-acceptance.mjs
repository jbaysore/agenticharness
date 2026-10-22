// Browser and HTTP fixtures only; no provider inference or user data.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHarness } from "../src/server.mjs";

await mkdir(".local/screenshots", { recursive: true });
const dataDir = await mkdtemp(resolve(".local/interface-"));
const projectPath = join(dataDir, "project");
await mkdir(projectPath);
const app = await createHarness({
  dataDir,
  port: 0,
  startProviders: false,
  seedProject: projectPath,
});
const project = app.store.projects()[0];
app.controller.providers = ["codex", "claude", "cursor"].map((id) => ({
  id,
  name: id,
  connected: true,
  models: [{ id: "fixture", name: "Interface fixture", efforts: [] }],
}));
let browser,
  scenario,
  builds = 0;
const errors = [];
for (const provider of app.controller.providers) {
  app.controller.runners[provider.id] = async (ctx) => {
    if (ctx.mode !== "plan") {
      builds++;
      ctx.emit("text", {
        nativeId: "built",
        text: "Implemented the approved plan.",
      });
      return { status: "completed" };
    }
    if (scenario === "fallback") {
      ctx.emit("text", { nativeId: "progress", text: "Inspecting the code." });
      ctx.emit("work", {
        kind: "plan",
        plan: [{ step: "Inspect", status: "completed" }],
      });
      ctx.emit("text", {
        nativeId: "final",
        text: "<proposed_plan>Old proposal</proposed_plan>",
      });
      ctx.emit("text", {
        nativeId: "revised",
        delta: `<proposed_plan># ${provider.id} complete proposal\n\nImplement the revised behavior.\n\n- Verify all interactions.\n- Deliver the changes.</proposed_`,
      });
      ctx.emit("text", { nativeId: "revised", delta: "plan>" });
    } else {
      const answer = await ctx.approve({
        kind: "plan",
        title: "Review the complete proposal",
        ...(scenario === "native"
          ? {
              plan: `# ${provider.id} native proposal\n\nBuild and verify the complete feature.`,
            }
          : {}),
      });
      if (answer.allow) {
        ctx.planApproved();
        builds++;
      }
    }
    return { status: "completed" };
  };
}
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  for (const provider of app.controller.providers) {
    for (const kind of ["fallback", "native", "missing"]) {
      scenario = kind;
      builds = 0;
      const chat = app.store.createConversation({
        projectId: project.id,
        title: `${provider.id} ${kind}`,
        provider: provider.id,
        model: "fixture",
        mode: "plan",
        permissions: "override",
      });
      await page.goto(
        `${app.runtime.origin}/?chat=${chat.id}#pair=${app.auth.pairing()}`,
      );
      await page
        .getByLabel("Message your coding agent")
        .fill("Propose the interface changes");
      await page.getByLabel("Send message").click();
      const card = page.locator(".approval"),
        confirm = card.getByRole("button", { name: "Confirm and build" });
      await expect(card).toBeVisible();
      if (kind === "missing") {
        await expect(card).toContainText("The plan is unavailable");
        await expect(confirm).toBeDisabled();
        await card.getByRole("button", { name: "Keep planning" }).click();
        await expect(card).toHaveCount(0);
        expect(builds).toBe(0);
        expect(app.store.conversation(chat.id).mode).toBe("plan");
        continue;
      }
      await expect(card.locator(".plan-body")).toContainText(
        kind === "fallback" ? "complete proposal" : "native proposal",
      );
      await expect(card.locator(".plan-body")).not.toContainText(
        "Old proposal",
      );
      await expect(confirm).toBeEnabled();
      await page.reload();
      await expect(card.locator(".plan-body")).toContainText(
        kind === "fallback" ? "revised behavior" : "complete feature",
      );
      expect(builds).toBe(0);
      await confirm.click();
      await expect(card).toHaveCount(0);
      await expect.poll(() => builds).toBe(1);
      await expect
        .poll(() => app.store.conversation(chat.id).mode)
        .toBe("default");
      await expect(page.getByLabel("Stop work")).toHaveCount(0);
    }
  }
  // Independent folders, archived lists, exponential increments, reset on reload.
  const a = app.store.addProject("Pagination A", join(dataDir, "pagination-a"));
  const b = app.store.addProject("Pagination B", join(dataDir, "pagination-b"));
  for (const [folder, total] of [
    [a, 53],
    [b, 15],
  ]) {
    for (let i = 0; i < total; i++)
      app.store.createConversation({
        projectId: folder.id,
        title: `Saved ${folder.name} ${i}`,
      });
    for (let i = 0; i < 14; i++) {
      const chat = app.store.createConversation({
        projectId: folder.id,
        title: `Archived ${i}`,
      });
      app.store.setArchived(chat.id, true);
    }
  }
  await page.reload();
  const sidebar = page.getByLabel("Projects and conversations");
  await sidebar.getByLabel("Expand Pagination A", { exact: true }).click();
  await sidebar.getByLabel("Expand Pagination B", { exact: true }).click();
  const listA = page.locator(`#project-${a.id}-chats`),
    listB = page.locator(`#project-${b.id}-chats`);
  await expect(listA.locator(".chat-row")).toHaveCount(6);
  await expect(listB.locator(".chat-row")).toHaveCount(6);
  for (const [more, total] of [
    [6, 12],
    [12, 24],
    [24, 48],
    [5, 53],
  ]) {
    await listA
      .getByRole("button", { name: `Show ${more} more`, exact: true })
      .click();
    await expect(listA.locator(".chat-row")).toHaveCount(total);
    await expect(listB.locator(".chat-row")).toHaveCount(6);
  }
  await listA.getByRole("button", { name: "Show fewer", exact: true }).click();
  await expect(listA.locator(".chat-row")).toHaveCount(6);
  await listA
    .getByRole("button", { name: "Show archived (14)", exact: true })
    .click();
  await expect(listA.locator(".chat-row")).toHaveCount(12);
  await listA
    .getByRole("button", { name: "Show 6 more", exact: true })
    .last()
    .click();
  await expect(listA.locator(".chat-row")).toHaveCount(18);
  await listA.getByRole("button", { name: "Show 2 more", exact: true }).click();
  await expect(listA.locator(".chat-row")).toHaveCount(20);
  await listA
    .getByRole("button", { name: "Hide archived", exact: true })
    .click();
  await listA.getByRole("button", { name: "Show 6 more", exact: true }).click();
  await expect(listA.locator(".chat-row")).toHaveCount(12);
  await sidebar.getByLabel("Collapse Pagination A", { exact: true }).click();
  await sidebar.getByLabel("Expand Pagination A", { exact: true }).click();
  await expect(listA.locator(".chat-row")).toHaveCount(12);
  await page.reload();
  await expect(listA.locator(".chat-row")).toHaveCount(6);
  await expect(listB.locator(".chat-row")).toHaveCount(6);
  await page.screenshot({
    path: ".local/screenshots/interface-pagination.png",
  });
  expect(errors).toEqual([]);
  console.log(
    "Interface checks passed: complete native and fallback plans for all providers, revisions and reloads, missing-plan guard, one implementation per approval, independent sidebar doubling and archived limits. Providers were simulated.",
  );
} finally {
  await browser?.close();
  await app.close();
}
