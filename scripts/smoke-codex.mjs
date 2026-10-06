import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { RpcProcess } from "../src/core/rpc.mjs";
import { executable } from "../src/core/executables.mjs";
import { subscriptionEnvironment } from "../src/security/environment.mjs";

const cwd = resolve(".local/probe-project");
await mkdir(cwd, { recursive: true });
const rpc = new RpcProcess(
  executable("codex"),
  [
    "app-server",
    "-c",
    'model_provider="openai"',
    "-c",
    'forced_login_method="chatgpt"',
  ],
  { env: subscriptionEnvironment(), cwd },
);
rpc.on("request", (message) =>
  rpc.reject(message.id, "No tools permitted in this smoke test"),
);
try {
  await rpc.call("initialize", {
    clientInfo: { name: "agentic_harness", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  rpc.notify("initialized");
  const { account } = await rpc.call("account/read");
  const limits = await rpc.call("account/rateLimits/read");
  if (
    account?.type !== "chatgpt" ||
    limits.ordinaryUsageAllowed !== true ||
    limits.rateLimits.credits?.hasCredits !== false ||
    limits.rateLimits.credits?.unlimited !== false
  )
    throw new Error("Subscription-only billing cannot be established");
  const { data: models } = await rpc.call("model/list", {
    includeHidden: false,
  });
  const model = models.find((m) => m.isDefault) ?? models[0];
  const { thread } = await rpc.call("thread/start", {
    model: model.model,
    modelProvider: "openai",
    allowProviderModelFallback: false,
    serviceTier: "default",
    cwd,
    approvalPolicy: "untrusted",
    sandbox: "read-only",
    ephemeral: true,
    environments: [],
  });
  const complete = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Smoke test timed out")),
      90_000,
    );
    rpc.on("notification", ({ method, params }) => {
      if (method === "item/completed" && params.item?.type === "agentMessage")
        console.log(JSON.stringify({ response: params.item.text }));
      if (method === "turn/completed") {
        clearTimeout(timeout);
        resolve(params.turn);
      }
    });
  });
  await rpc.call("turn/start", {
    threadId: thread.id,
    input: [
      {
        type: "text",
        text: "Reply with exactly: subscription connection verified. Do not use tools.",
      },
    ],
    effort: model.supportedReasoningEfforts[0].reasoningEffort,
    serviceTierForTurn: "default",
    environments: [],
  });
  const result = await complete;
  console.log(
    JSON.stringify({
      provider: "codex",
      model: model.model,
      plan: account.planType,
      status: result.status,
      error: result.error,
    }),
  );
} finally {
  rpc.close();
}
