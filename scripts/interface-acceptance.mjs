// Browser and HTTP fixtures only; no provider inference or user data.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHarness } from "../src/server.mjs";
import { planRevisionRequest } from "../src/core/plans.mjs";

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
const errors = [],
  turns = [],
  planAnswers = [];
for (const provider of app.controller.providers) {
  app.controller.runners[provider.id] = async (ctx) => {
    turns.push({ text: ctx.text, mode: ctx.mode });
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
      const request = {
        kind: "plan",
        title: "Review the complete proposal",
        ...(scenario === "native"
          ? {
              plan: `# ${provider.id} native proposal\n\nBuild and verify the complete feature.`,
            }
          : {}),
      };
      let answer = await ctx.approve(request);
      planAnswers.push(answer);
      if (!answer.allow && answer.reason && scenario === "native") {
        answer = await ctx.approve({
          ...request,
          plan: request.plan + "\n\nInclude the requested revisions.",
        });
        planAnswers.push(answer);
      }
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
    permissions: ["clipboard-read", "clipboard-write"],
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
        await expect(card.getByRole("button", { name: "Copy plan" })).toHaveCount(0);
        await card.getByRole("button", { name: "Keep planning" }).click();
        await card.getByRole("textbox", { name: "What should change?" })
          .fill("Present the complete proposal first.");
        await card.getByRole("button", { name: "Send feedback" }).click();
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
      if (kind === "fallback") {
        await expect(page.locator(".reply", { hasText: "Inspecting the code." })).toBeVisible();
        await expect(page.locator(".reply", { hasText: "complete proposal" })).toHaveCount(0);
        await expect(page.locator(".reply", { hasText: "Old proposal" })).toHaveCount(0);
      }
      await expect(confirm).toBeEnabled();
      const copyPlan = card.getByRole("button", { name: "Copy plan" });
      await copyPlan.click();
      await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
        kind === "fallback" ? "complete proposal" : "native proposal",
      );
      await page.reload();
      await expect(card.locator(".plan-body")).toContainText(
        kind === "fallback" ? "revised behavior" : "complete feature",
      );
      expect(builds).toBe(0);
      // A review belongs to the plan it read, so a revised native plan in
      // the same run can be reviewed again.
      const reviewButton = card.getByRole("button", { name: "Get independent review" });
      if (kind === "native") {
        const pending = app.store.pendingApprovals(chat.id)[0];
        app.controller.recordPlanReview(app.store.conversation(chat.id), { id: pending.run_id }, {
          plan: pending.request.plan,
          status: "done",
          reviewer: null,
          result: {
            assessment: "sound",
            summary: "Fixture review of the first plan.",
            concerns: [],
            improvements: [],
            questions: [],
          },
          error: null,
        });
        await expect(card.getByText("Fixture review of the first plan.")).toBeVisible();
        await expect(reviewButton).toBeDisabled();
      }

      const turnCount = turns.length,
        answerCount = planAnswers.length,
        feedbackText = "Include invalidation.\nExplain how /default is handled.";
      await page.getByLabel("Message your coding agent").fill("Unsent draft");
      await card.getByRole("button", { name: "Keep planning" }).click();
      const feedback = card.getByRole("textbox", { name: "What should change?" }),
        sendFeedback = card.getByRole("button", { name: "Send feedback" });
      await expect(feedback).toBeFocused();
      await expect(sendFeedback).toBeDisabled();
      await feedback.fill("   ");
      await expect(sendFeedback).toBeDisabled();
      await feedback.fill(feedbackText);
      // Opening and backing out must not resume the agent or lose the draft.
      await card.getByRole("button", { name: "Back", exact: true }).click();
      await expect(confirm).toBeVisible();
      expect(turns.length).toBe(turnCount);
      expect(planAnswers.length).toBe(answerCount);
      await card.getByRole("button", { name: "Keep planning" }).click();
      await expect(feedback).toHaveValue(feedbackText);
      if (provider.id === "codex") {
        await page.setViewportSize({ width: 390, height: 844 });
        await feedback.scrollIntoViewIfNeeded();
        expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth))
          .toBe(true);
        await page.screenshot({
          path: `.local/screenshots/plan-feedback-${kind}-phone.png`,
          fullPage: true,
        });
      }
      const endpoint = kind === "fallback"
        ? `**/api/chats/${chat.id}/messages`
        : "**/api/approvals/*";
      await page.route(endpoint, (route) => route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture feedback failed" }),
      }));
      await sendFeedback.click();
      await expect(card.getByText("Fixture feedback failed")).toBeVisible();
      await expect(feedback).toHaveValue(feedbackText);
      await expect(sendFeedback).toBeEnabled();
      expect(turns.length).toBe(turnCount);
      expect(planAnswers.length).toBe(answerCount);
      await page.unroute(endpoint);
      await sendFeedback.click();
      await expect(confirm).toBeVisible();
      await expect(confirm).toBeEnabled();
      await expect(card.getByRole("textbox", { name: "What should change?" }))
        .toHaveCount(0);
      if (kind === "fallback") {
        expect(turns.length).toBe(turnCount + 1);
        expect(turns.at(-1)).toEqual({
          text: planRevisionRequest(feedbackText),
          mode: "plan",
        });
      } else {
        expect(turns.length).toBe(turnCount);
        expect(planAnswers.at(-1)).toEqual({
          allow: false,
          answers: {},
          reason: feedbackText,
        });
        await expect(card.locator(".plan-body")).toContainText("requested revisions");
        await expect(card.getByText("Fixture review of the first plan.")).toHaveCount(0);
        await expect(reviewButton).toBeEnabled();
      }
      await expect(page.getByLabel("Message your coding agent"))
        .toHaveValue("Unsent draft");
      expect(app.store.conversation(chat.id).mode).toBe("plan");
      expect(builds).toBe(0);
      await page.setViewportSize({ width: 1512, height: 982 });
      await confirm.click();
      await expect(card).toHaveCount(0);
      await expect.poll(() => builds).toBe(1);
      await expect
        .poll(() => app.store.conversation(chat.id).mode)
        .toBe("default");
      await expect(page.getByLabel("Stop work")).toHaveCount(0);
    }
  }
  // Independent review advises without deciding. Providers stay simulated.
  app.controller.openReviewer = null;
  const soundReview = {
    assessment: "sound",
    summary: "The plan covers the requested interface work.",
    concerns: [
      {
        severity: "low",
        confidence: "low",
        title: "Heading wrap",
        scenario: "A long heading wraps on a phone.",
        evidence: "The plan says complete proposal.",
        suggestion: "Shorten the heading.",
      },
    ],
    improvements: [
      {
        title: "Name the reload",
        detail: "Say which screen is reloaded after save.",
      },
    ],
    questions: ["Should the phone layout stay wrapped?"],
  };
  let releaseReview = () => {};
  const reviewAnswer = (signal) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      signal.addEventListener(
        "abort",
        () => {
          if (!settled) {
            settled = true;
            reject(new Error("The plan review was cancelled."));
          }
        },
        { once: true },
      );
      releaseReview = () =>
        finish({
          text: JSON.stringify(soundReview),
          usage: { input: 3, output: 2 },
        });
      if (signal.aborted) {
        settled = true;
        reject(new Error("The plan review was cancelled."));
      }
    });
  app.controller.workers = {
    codex: ({ signal }) => reviewAnswer(signal),
    claude: ({ signal }) => reviewAnswer(signal),
  };
  scenario = "fallback";
  const reviewed = app.store.createConversation({
    projectId: project.id,
    title: "Independent review",
    provider: "claude",
    model: "fixture",
    mode: "plan",
    permissions: "override",
  });
  await page.goto(
    `${app.runtime.origin}/?chat=${reviewed.id}#pair=${app.auth.pairing()}`,
  );
  await page.getByLabel("Message your coding agent").fill("Propose a small change");
  await page.getByLabel("Send message").click();
  const reviewedCard = page.locator(".approval");
  await reviewedCard.getByRole("button", { name: "Get independent review" }).click();
  await expect(reviewedCard.getByText(/Reviewing with Codex/)).toBeVisible();
  await expect(
    reviewedCard.getByRole("button", { name: "Confirm and build" }),
  ).toBeEnabled();
  releaseReview();
  await expect(reviewedCard.getByText("No significant concerns found")).toBeVisible();
  await expect(reviewedCard.getByText("Heading wrap", { exact: true })).toHaveCount(0);
  await reviewedCard.getByRole("button", { name: "Show 1 minor note" }).click();
  await expect(reviewedCard.getByText("Heading wrap", { exact: true })).toBeVisible();
  await expect(reviewedCard.getByText("Name the reload")).toBeVisible();
  await expect(
    reviewedCard.getByText("Should the phone layout stay wrapped?"),
  ).toBeVisible();
  await page.reload();
  await expect(reviewedCard.getByText("No significant concerns found")).toBeVisible();
  await reviewedCard.getByRole("button", { name: "Send review to agent" }).click();
  const reviewedFeedback = reviewedCard.getByRole("textbox", {
    name: "What should change?",
  });
  await expect(reviewedFeedback).toHaveValue(/Independent review \(Sound\)/);
  await expect(reviewedFeedback).toHaveValue(/Name the reload/);
  await expect(reviewedFeedback).toHaveValue(/Heading wrap/);
  await reviewedCard.getByRole("button", { name: "Back", exact: true }).click();
  await expect(reviewedCard.getByRole("button", { name: "Confirm and build" })).toBeVisible();

  scenario = "native";
  builds = 0;
  releaseReview = () => {};
  const pending = app.store.createConversation({
    projectId: project.id,
    title: "Review during approval",
    provider: "codex",
    model: "fixture",
    mode: "plan",
    permissions: "override",
  });
  await page.goto(
    `${app.runtime.origin}/?chat=${pending.id}#pair=${app.auth.pairing()}`,
  );
  await page.getByLabel("Message your coding agent").fill("Propose the native plan");
  await page.getByLabel("Send message").click();
  const pendingCard = page.locator(".approval");
  await pendingCard.getByRole("button", { name: "Get independent review" }).click();
  await expect(pendingCard.getByText(/Reviewing with Claude Code/)).toBeVisible();
  await expect(
    pendingCard.getByRole("button", { name: "Confirm and build" }),
  ).toBeEnabled();
  await pendingCard.getByRole("button", { name: "Confirm and build" }).click();
  await expect(pendingCard).toHaveCount(0);
  await expect.poll(() => builds).toBe(1);
  releaseReview();
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
    "Interface checks passed: complete native and fallback plans for all providers, feedback before resuming, feedback delivery and retry, preserved drafts and Plan mode, phone layout, revisions and reloads, missing-plan guard, one implementation per approval, independent plan review, confirm during review, independent sidebar doubling and archived limits. Providers were simulated; no inference.",
  );
} finally {
  await browser?.close();
  await app.close();
}
