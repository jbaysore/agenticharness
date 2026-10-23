import { createInterface } from "node:readline";
import { historyTools } from "./core/history.mjs";
import { progressToken, toolBridgeTimeoutMs } from "./core/tool-bridge.mjs";
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
      // Questions and mode suggestions have no deadline. A progress ping keeps
      // a provider from treating the quiet call as idle while someone reads
      // or types. Browser actions and landing keep a bounded wait.
      const timeoutMs = toolBridgeTimeoutMs(m.params?.name);
      const token = progressToken(m);
      let progress = 0;
      const beat =
        token == null
          ? null
          : setInterval(() => {
              progress += 1;
              reply({
                method: "notifications/progress",
                params: { progressToken: token, progress },
              });
            }, 10_000);
      try {
        const response = await fetch(
          process.env.HARNESS_BRIDGE_URL + "/internal/history",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + process.env.HARNESS_BRIDGE_TOKEN,
            },
            body: JSON.stringify(m.params),
            ...(timeoutMs != null && {
              signal: AbortSignal.timeout(timeoutMs),
            }),
          },
        );
        const value = await response.json();
        if (value?.mcp) reply({ id: m.id, result: value.mcp });
        else
          reply({
            id: m.id,
            result: {
              isError: !response.ok,
              content: [{ type: "text", text: JSON.stringify(value) }],
            },
          });
      } finally {
        if (beat) clearInterval(beat);
      }
    } else
      reply({
        id: m.id,
        error: { code: -32601, message: "Method not supported" },
      });
  } catch (error) {
    reply({ id: m.id, error: { code: -32603, message: error.message } });
  }
});
