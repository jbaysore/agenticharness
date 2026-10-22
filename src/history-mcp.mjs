import { createInterface } from "node:readline";
import { historyTools } from "./core/history.mjs";
const reply = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return;
  try {
    if (m.method === "initialize")
      reply({
        id: m.id,
        result: {
          protocolVersion: m.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "harness-history", version: "0.1.0" },
        },
      });
    else if (m.method === "ping") reply({ id: m.id, result: {} });
    else if (m.method === "tools/list") {
      // The browser's tools are listed only while Harness offers them.
      const response = await fetch(
        process.env.HARNESS_BRIDGE_URL + "/internal/tools",
        {
          headers: {
            Authorization: "Bearer " + process.env.HARNESS_BRIDGE_TOKEN,
          },
          signal: AbortSignal.timeout(15000),
        },
      ).catch(() => null);
      reply({
        id: m.id,
        result: {
          tools: response?.ok ? (await response.json()).tools : historyTools,
        },
      });
    } else if (m.method === "tools/call") {
      const response = await fetch(
        process.env.HARNESS_BRIDGE_URL + "/internal/history",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + process.env.HARNESS_BRIDGE_TOKEN,
          },
          body: JSON.stringify(m.params),
          // Browser actions and mode suggestions may wait for user approval.
          // Landing runs the project's check command.
          signal: AbortSignal.timeout(
            /^(?:browser(?:_|$)|land_changes|suggest_mode)$/.test(
              m.params?.name,
            )
              ? 15 * 60 * 1000
              : 15000,
          ),
        },
      );
      const value = await response.json();
      if (value?.mcp) return reply({ id: m.id, result: value.mcp });
      reply({
        id: m.id,
        result: {
          isError: !response.ok,
          content: [{ type: "text", text: JSON.stringify(value) }],
        },
      });
    } else
      reply({
        id: m.id,
        error: { code: -32601, message: "Method not supported" },
      });
  } catch (error) {
    reply({ id: m.id, error: { code: -32603, message: error.message } });
  }
});
