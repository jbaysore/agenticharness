// Real browser and HTTP with simulated question requests; no inference.
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";

await mkdir(".local/screenshots", { recursive: true });
const app = await createHarness({
  dataDir: await mkdtemp(resolve(".local/questions-")),
  port: 0,
  startProviders: false,
  seedProject: process.cwd(),
});
app.controller.providers = ["codex", "claude", "cursor"].map((id) => ({
  id,
  name: id,
  connected: true,
  models: [{ id: "fixture", name: "Question fixture", efforts: [] }],
}));
let request, browser;
const received = [],
  errors = [];
for (const provider of app.controller.providers)
  app.controller.runners[provider.id] = async (ctx) => {
    received.push(await ctx.approve(request));
    return { status: "completed" };
  };
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.runtime.origin);
  const approval = page.locator(".approval"),
    send = approval.getByRole("button", { name: "Send answer", exact: true });
  const ask = async (provider, questions) => {
    request = {
      kind: "question",
      title: "Help choose the next step",
      questions,
    };
    await chooseModel(page, app.controller.providers, provider, "fixture");
    await page
      .getByLabel("Message your coding agent")
      .fill("Ask the fixture question");
    await page.getByLabel("Send message").click();
    await expect(approval).toBeVisible();
    await expect(send).toBeDisabled();
  };
  const sent = async (answer) => {
    await expect(approval).toHaveCount(0);
    await expect.poll(() => received.at(-1)).toEqual(answer);
    await expect(page.getByLabel("Stop work")).toHaveCount(0);
  };

  await ask("codex", [
    {
      id: "approach",
      question: "How should we deliver the change?",
      options: [
        {
          label: "Focused update (Recommended)",
          description:
            "Fix the question UI quickly while keeping the existing workflow.",
        },
        {
          label: "Broader redesign",
          description:
            "Revisit the full conversation layout when consistency matters more than speed.",
        },
      ],
    },
    { id: "notes", question: "Anything else to keep in mind?" },
  ]);
  await expect(approval.locator("select, datalist, input[list]")).toHaveCount(
    0,
  );
  await expect(
    approval.getByText(
      "Fix the question UI quickly while keeping the existing workflow.",
    ),
  ).toBeVisible();
  await page.screenshot({ path: ".local/screenshots/questions-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await approval.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await approval.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/questions-phone.png",
    fullPage: true,
  });
  const group = approval.getByRole("group", {
      name: "How should we deliver the change?",
    }),
    focused = group.getByRole("radio", {
      name: "Focused update (Recommended)",
      exact: true,
    });
  await focused.focus();
  await page.keyboard.press("Space");
  await expect(focused).toBeChecked();
  await page.keyboard.press("ArrowDown");
  await expect(
    group.getByRole("radio", { name: "Broader redesign", exact: true }),
  ).toBeChecked();
  await group.getByRole("radio", { name: "Other", exact: true }).check();
  const other = approval.getByRole("textbox", {
    name: "Your Other response",
    exact: true,
  });
  await expect(other).toBeFocused();
  await other.fill("   ");
  await approval
    .getByRole("textbox", { name: "Your response", exact: true })
    .fill("Keep keyboard support.");
  await expect(send).toBeDisabled();
  await other.fill("A smaller accessibility pass");
  await expect(send).toBeEnabled();
  // Switching back preserves the Other draft but sends only the selected choice.
  await focused.check();
  await expect(other).toHaveCount(0);
  await group.getByRole("radio", { name: "Other", exact: true }).check();
  await expect(other).toHaveValue("A smaller accessibility pass");

  // A failed save retains answers and permits retry.
  await page.route("**/api/approvals/*", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Fixture response failed" }),
    }),
  );
  await send.click();
  await expect(approval.getByText("Fixture response failed")).toBeVisible();
  await expect(send).toBeEnabled();
  await expect(other).toHaveValue("A smaller accessibility pass");
  await page.unroute("**/api/approvals/*");
  // Freeze the successful request long enough to verify submission is locked.
  let release;
  const held = new Promise((done) => {
    release = done;
  });
  await page.route("**/api/approvals/*", async (route) => {
    await held;
    await route.continue();
  });
  await send.click();
  await expect(send).toBeDisabled();
  await expect(other).toBeDisabled();
  release();
  await sent({
    allow: true,
    answers: {
      approach: "A smaller accessibility pass",
      notes: "Keep keyboard support.",
    },
  });
  await page.unroute("**/api/approvals/*");

  await page.setViewportSize({ width: 1512, height: 982 });
  await ask("claude", [
    {
      question: "Which checks should run?",
      header: "Checks",
      multiSelect: true,
      options: [
        {
          label: "Browser",
          description: "Verify the interaction in a real browser.",
        },
        {
          label: "Unit",
          description: "Check provider answer mapping in isolation.",
        },
      ],
    },
  ]);
  await approval
    .getByRole("checkbox", { name: "Browser", exact: true })
    .check();
  await approval.getByRole("checkbox", { name: "Unit", exact: true }).check();
  await approval.getByRole("checkbox", { name: "Other", exact: true }).check();
  await expect(send).toBeDisabled();
  await approval
    .getByRole("textbox", { name: "Your Other response" })
    .fill("Mobile review");
  await send.click();
  await sent({
    allow: true,
    answers: { "Which checks should run?": "Browser, Unit, Mobile review" },
  });

  await ask("cursor", [
    {
      id: "checks",
      question: "Which checks should run?",
      multiple: true,
      selectionOnly: true,
      options: [
        {
          id: "browser",
          label: "Browser — Verify keyboard and pointer interactions.",
        },
        { id: "unit", label: "Unit — Verify how answers reach each provider." },
      ],
    },
  ]);
  await expect(
    approval.getByText("Verify keyboard and pointer interactions.", {
      exact: true,
    }),
  ).toBeVisible();
  await approval
    .getByRole("checkbox", { name: "Browser", exact: true })
    .check();
  await approval.getByRole("checkbox", { name: "Unit", exact: true }).check();
  await send.click();
  await sent({ allow: true, answers: { checks: ["browser", "unit"] } });

  // Legacy string options still work, and hidden Other text is never submitted.
  await ask("codex", [
    {
      id: "legacy",
      question: "Choose a version",
      options: ["Current", "Previous", "Other"],
    },
  ]);
  await expect(
    approval.getByRole("radio", { name: "Other", exact: true }),
  ).toHaveCount(1);
  await approval.getByRole("radio", { name: "Other", exact: true }).check();
  await approval
    .getByRole("textbox", { name: "Your Other response" })
    .fill("Do not send this draft");
  await approval.getByRole("radio", { name: "Current", exact: true }).check();
  await send.click();
  await sent({ allow: true, answers: { legacy: "Current" } });

  await ask("cursor", [
    {
      id: "custom",
      question: "Choose an approach",
      selectionOnly: true,
      options: [{ id: "a", label: "Existing approach" }],
    },
  ]);
  await approval.getByRole("radio", { name: "Other", exact: true }).check();
  await approval
    .getByRole("textbox", { name: "Your Other response" })
    .fill("Use a new approach");
  await send.click();
  await sent({ allow: true, answers: { custom: "Use a new approach" } });

  await ask("codex", [
    { id: "decline", question: "Choose an approach", options: ["Proceed"] },
  ]);
  await approval.getByRole("button", { name: "Decline", exact: true }).click();
  await sent({ allow: false, answers: {} });
  expect(errors).toEqual([]);
  console.log(
    "Question checks passed: styled choices, descriptions, Other, keyboard, mobile, single/multiple answers, provider formats, validation, retry, submission lock, and decline. Providers were simulated; no inference.",
  );
} finally {
  await browser?.close();
  await app.close();
}
