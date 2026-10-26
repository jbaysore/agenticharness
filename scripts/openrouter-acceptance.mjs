// Real setup/model-picker UI and agent loop with simulated HTTP; no inference.
import { chromium, expect, devices } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHarness } from "../src/server.mjs";
import { chooseModel } from "./model-picker-helpers.mjs";

await mkdir(".local/screenshots", { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "harness-openrouter-ui-"));
const project = join(directory, "project");
await mkdir(project);
await writeFile(join(project, "fixture.txt"), "a simulated project file");
const ids = ["fixture/coder-v1:free", "fixture/other-v1:free"];
const models = ids.map((id, i) => ({
  id,
  canonical_slug: id.replace(":free", "-20261026"),
  name: i ? "Other Coder" : "Fixture Coder",
  pricing: { prompt: "0", completion: "0" },
  context_length: 262144,
  supported_parameters: ["tools"],
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
}));
let key = null,
  inference = 0;
const app = await createHarness({
  dataDir: directory,
  port: 0,
  startProviders: false,
  seedProject: project,
  openrouterOptions: {
    credentials: {
      has: async () => !!key,
      read: async () => key,
      write: async (value) => {
        key = value;
      },
      remove: async () => {
        key = null;
      },
    },
    fetch: async (url, options) => {
      if (url.endsWith("/models")) return Response.json({ data: models });
      if (url.endsWith("/key"))
        return Response.json({
          data: { free_model_daily_requests: { remaining: 48, limit: 50 } },
        });
      const request = JSON.parse(options.body);
      expect(request.model).toBe(ids[0]);
      expect(request.models).toBeUndefined();
      const first = ++inference === 1;
      if (!first)
        expect(
          request.messages.find((m) => m.role === "tool").content,
        ).toContain("a simulated project file");
      const event = {
        model: ids[0],
        choices: [
          {
            index: 0,
            delta: first
              ? {
                  content: "Reading the fixture.",
                  tool_calls: [
                    {
                      index: 0,
                      id: "read-fixture",
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: JSON.stringify({ path: "fixture.txt" }),
                      },
                    },
                  ],
                }
              : {
                  content: "The simulated project file was read successfully.",
                },
            finish_reason: first ? "tool_calls" : "stop",
          },
        ],
        usage: { cost: 0 },
      };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    },
  },
});
app.controller.browser = null;
app.controller.providers = [
  ...["codex", "claude", "cursor"].map((id) => ({
    id,
    name: { codex: "Codex", claude: "Claude Code", cursor: "Cursor" }[id],
    connected: false,
    models: [],
    blockReason: "Simulated disconnected provider",
  })),
  ...app.controller.providers,
];
const errors = [];
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.runtime.origin);
  await page
    .getByRole("button", { name: /Connections & usage/ })
    .first()
    .click();
  const setup = page.getByRole("region", { name: "OpenRouter setup" });
  await expect(
    setup.getByLabel("Enable OpenRouter", { exact: true }),
  ).toBeDisabled();
  await setup.getByRole("button", { name: "Refresh model catalog" }).click();
  await expect(
    setup.getByRole("checkbox", { name: /Fixture Coder/ }),
  ).toBeVisible();
  await expect(
    setup.getByRole("checkbox", { name: /Fixture Coder/ }),
  ).not.toBeChecked();
  expect(inference).toBe(0);
  await setup
    .getByLabel("OpenRouter API key", { exact: true })
    .fill("sk-or-v1-this-is-a-simulated-ui-key");
  await setup.getByRole("checkbox", { name: /I authorize sending/ }).check();
  await setup.getByLabel("Enable OpenRouter", { exact: true }).check();
  await setup.getByRole("checkbox", { name: /Fixture Coder/ }).check();
  await setup
    .getByRole("button", { name: "Save approvals & connection" })
    .click();
  await expect(setup.getByRole("status")).toHaveText(
    "OpenRouter settings saved.",
  );
  await expect(
    setup.getByLabel("OpenRouter API key", { exact: true }),
  ).toHaveValue("");
  await page.screenshot({
    path: ".local/screenshots/openrouter-setup-desktop.png",
  });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await chooseModel(page, app.controller.providers, "openrouter", ids[0]);
  await expect(
    page.getByLabel("Mode", { exact: true }).locator('option[value="goal"]'),
  ).toHaveAttribute("disabled", "");
  await page
    .getByLabel("Permissions", { exact: true })
    .selectOption("override");
  await page
    .getByLabel("Message your coding agent")
    .fill("Read fixture.txt and report what it says.");
  await page.getByLabel("Send message").click();
  await expect(
    page.getByText("The simulated project file was read successfully.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(inference).toBe(2);
  await page.screenshot({
    path: ".local/screenshots/openrouter-chat-desktop.png",
  });
  await page
    .getByRole("button", { name: /Connections & usage/ })
    .first()
    .click();
  await setup.getByRole("checkbox", { name: /Fixture Coder/ }).uncheck();
  await setup
    .getByRole("button", { name: "Save approvals & connection" })
    .click();
  await expect(setup.getByRole("status")).toHaveText(
    "OpenRouter settings saved.",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByLabel("Message your coding agent")
    .fill("This must be blocked.");
  await expect(page.getByLabel("Send message")).toBeDisabled();
  expect(inference).toBe(2);

  const context = await browser.newContext({ ...devices["iPhone 13"] });
  const mobile = await context.newPage();
  await mobile.goto(app.runtime.origin);
  await mobile
    .getByRole("button", { name: "Show sidebar", exact: true })
    .click();
  await mobile
    .getByRole("button", { name: /Connections & usage/ })
    .first()
    .click();
  const mobileSetup = mobile.getByRole("region", { name: "OpenRouter setup" });
  await mobileSetup
    .getByRole("button", { name: "Save approvals & connection" })
    .scrollIntoViewIfNeeded();
  await expect(
    mobileSetup.getByRole("button", { name: "Save approvals & connection" }),
  ).toBeInViewport();
  expect(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await mobile.screenshot({
    path: ".local/screenshots/openrouter-setup-mobile.png",
  });
  await context.close();
  expect(errors).toEqual([]);
  console.log(
    "PASS OpenRouter setup, data consent, allowlist, real tool loop, revocation and mobile layout; all model responses simulated.",
  );
} finally {
  await browser?.close();
  await app.close();
}
