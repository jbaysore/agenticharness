import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { RpcProcess } from "./rpc.mjs";

const cli = join(
  dirname(
    createRequire(import.meta.url).resolve("@playwright/mcp/package.json"),
  ),
  "cli.js",
);
// Runs arbitrary Node code on the host, outside every agent's sandbox.
const withheld = new Set(["browser_run_code_unsafe"]);
export const isBrowserTool = (name) => /^browser_/.test(String(name));
// What an approval prompt says, e.g. "Browser: navigate · https://example.com".
export const browserTitle = (name, input = {}) => {
  const target = [input.url, input.element, input.key, input.text, input.action]
    .find((v) => typeof v === "string" && v)
    ?.slice(0, 120);
  return (
    "Browser: " +
    String(name)
      .replace(/^browser_/, "")
      .replace(/_/g, " ") +
    (target ? " · " + target : "")
  );
};

// One Chrome, driven through Playwright MCP and shared by every chat. Harness
// owns it, so a page survives between turns, sign-ins persist in its own
// profile, and every agent's browser actions pass the same approval.
export class Browser {
  constructor(dataDir, { command = process.execPath, args } = {}) {
    this.dir = join(dataDir, "browser");
    this.command = command;
    this.args = args ?? [
      cli,
      "--browser",
      "chrome",
      "--user-data-dir",
      join(this.dir, "profile"),
      "--output-dir",
      join(this.dir, "output"),
    ];
    this.queue = Promise.resolve();
  }
  async connect() {
    if (this.rpc && !this.rpc.closed) return this.rpc;
    this.starting ??= (async () => {
      await mkdir(this.dir, { recursive: true });
      const rpc = new RpcProcess(this.command, this.args, { cwd: this.dir });
      // Playwright MCP may ask for workspace roots; it has none.
      rpc.on("request", (m) =>
        m.method === "roots/list"
          ? rpc.respond(m.id, { roots: [] })
          : rpc.reject(m.id),
      );
      await rpc.call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agentic-harness", version: "1" },
      });
      rpc.notify("notifications/initialized");
      return (this.rpc = rpc);
    })().finally(() => (this.starting = null));
    return this.starting;
  }
  // Listing tools starts the MCP server but not Chrome; Chrome opens on first use.
  async tools() {
    this.list ??= (async () => {
      const { tools } = await (await this.connect()).call("tools/list");
      return tools
        .filter((t) => !withheld.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          readOnly: t.annotations?.readOnlyHint === true,
        }));
    })().catch((error) => {
      this.list = null;
      throw error;
    });
    return this.list;
  }
  async needsApproval(name) {
    const tool = (await this.tools()).find((t) => t.name === name);
    if (!tool) throw new Error(`The browser has no tool named ${name}`);
    return !tool.readOnly;
  }
  // Chats share one browser, so calls run one at a time.
  call(name, args) {
    const next = this.queue.then(async () => {
      if (withheld.has(name)) throw new Error(`${name} is not available`);
      return (await this.connect()).call(
        "tools/call",
        { name, arguments: args ?? {} },
        5 * 60 * 1000,
      );
    });
    this.queue = next.catch(() => {});
    return next;
  }
  close() {
    this.rpc?.close();
    this.rpc = null;
  }
}
// An MCP result as plain text, for channels that carry text only.
export const resultText = (result) =>
  (result?.content ?? [])
    .map((c) =>
      c.type === "text"
        ? c.text
        : `[${c.mimeType ?? c.type} omitted; the saved file is linked above]`,
    )
    .join("\n");
