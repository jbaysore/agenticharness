import { RpcProcess } from "../src/core/rpc.mjs";
import { cursorCommand } from "../src/core/executables.mjs";
import { subscriptionEnvironment } from "../src/security/environment.mjs";
import { cursorClientCapabilities } from "../src/providers/cursor.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const cwd = resolve(".local/probe-project");
await mkdir(cwd, { recursive: true });
const command = cursorCommand();
if (!command.command) throw new Error("Cursor CLI missing");
const rpc = new RpcProcess(command.command, [...command.args, "acp"], {
  cwd,
  env: subscriptionEnvironment(),
});
rpc.on("request", (m) =>
  m.method === "session/request_permission"
    ? rpc.respond(m.id, { outcome: { outcome: "cancelled" } })
    : rpc.reject(m.id),
);
rpc.on("notification", ({ method, params }) => {
  if (params?.update?.sessionUpdate === "agent_message_chunk")
    process.stdout.write(params.update.content?.text ?? "");
});
try {
  const init = await rpc.call("initialize", {
    protocolVersion: 1,
    clientCapabilities: cursorClientCapabilities(),
    clientInfo: { name: "agentic-harness", version: "0.1.0" },
  });
  await rpc.call("authenticate", { methodId: "cursor_login" });
  const session = await rpc.call("session/new", { cwd, mcpServers: [] });
  const selected = await rpc.call("session/set_config_option", {
    sessionId: session.sessionId,
    configId: "model",
    value: "composer-2.5",
  });
  const slowed = await rpc.call("session/set_config_option", {
    sessionId: session.sessionId,
    configId: "fast",
    value: "false",
  });
  console.log(
    JSON.stringify({
      model: slowed.configOptions?.find((option) => option.id === "model")
        ?.currentValue,
      fast: slowed.configOptions?.find((option) => option.id === "fast")
        ?.currentValue,
      hadFastDefault: selected.configOptions?.find(
        (option) => option.id === "fast",
      )?.currentValue,
    }),
  );
  await writeFile(
    ".local/probe-cursor-capabilities.json",
    JSON.stringify({ init, session }, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        init,
        sessionKeys: Object.keys(session),
        modelCount: session.models?.availableModels?.length,
        configOptions: session.configOptions?.map((c) => ({
          id: c.id,
          name: c.name,
          category: c.category,
          currentValue: c.currentValue,
          optionCount: c.options?.length,
        })),
        currentModelId: session.models?.currentModelId,
      },
      null,
      2,
    ),
  );
  if (process.argv.includes("--smoke")) {
    const result = await rpc.call(
      "session/prompt",
      {
        sessionId: session.sessionId,
        prompt: [
          {
            type: "text",
            text: "Reply with exactly: subscription connection verified. Do not use tools.",
          },
        ],
      },
      120000,
    );
    console.log(JSON.stringify({ result }));
  }
} finally {
  rpc.close();
}
