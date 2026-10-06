import { RpcProcess } from "../src/core/rpc.mjs";
import { executable } from "../src/core/executables.mjs";
import { subscriptionEnvironment } from "../src/security/environment.mjs";

const path = executable("codex");
if (!path) throw new Error("Install Codex CLI and sign in with ChatGPT first.");
const rpc = new RpcProcess(
  path,
  [
    "app-server",
    "-c",
    'model_provider="openai"',
    "-c",
    'forced_login_method="chatgpt"',
  ],
  { env: subscriptionEnvironment() },
);
rpc.on("request", (message) =>
  rpc.reject(message.id, "Read-only connection probe"),
);
try {
  const initialization = await rpc.call("initialize", {
    clientInfo: {
      name: "agentic_harness",
      title: "Agentic Harness",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  rpc.notify("initialized");
  const account = await rpc.call("account/read", { refreshToken: false });
  const limits = await rpc.call("account/rateLimits/read");
  const models = await rpc.call("model/list", {
    includeHidden: false,
    limit: 100,
  });
  console.log(
    JSON.stringify(
      {
        initialization,
        account: {
          type: account.account?.type,
          planType: account.account?.planType,
        },
        limits,
        models,
      },
      null,
      2,
    ),
  );
} finally {
  rpc.close();
}
