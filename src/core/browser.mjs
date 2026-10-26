import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { RpcProcess } from "./rpc.mjs";
import { screenshotLinks } from "./browser-images.mjs";
import { BrowserHost } from "./browser-host.mjs";

const cli = join(
  dirname(
    createRequire(import.meta.url).resolve("@playwright/mcp/package.json"),
  ),
  "cli.js",
);
// Runs arbitrary Node code on the host, outside every agent's sandbox.
const withheld = new Set(["browser_run_code_unsafe"]);
const BROWSER_TEXT_CAP = 12_000;
export const isBrowserTool = (name) =>
  name === "browser" || /^browser_/.test(String(name));

// One tool for the model. Playwright's schemas stay on the host and are used
// to check a call before it runs.
export function browserGateway(tools) {
  const lines = tools.map((tool) => {
    const sentence = String(tool.description ?? "")
      .split(/(?<=\.)\s/)[0]
      .replace(/\s+/g, " ")
      .trim();
    const short = sentence.length > 80 ? sentence.slice(0, 79) + "…" : sentence;
    return `- ${tool.name}: ${short || "Playwright action"}`;
  });
  return {
    name: "browser",
    description: `Drive the shared Chrome. Set action to one of the names below and pass that action's arguments.\n${lines.join("\n")}`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: tools.map((tool) => tool.name) },
        arguments: { type: "object" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    readOnly: tools.every((tool) => tool.readOnly),
  };
}

export function validateToolInput(schema, args) {
  if (!schema || schema.type !== "object") return null;
  if (args != null && (typeof args !== "object" || Array.isArray(args)))
    return "Arguments must be an object";
  const input = args ?? {},
    properties = schema.properties ?? {};
  for (const key of schema.required ?? [])
    if (input[key] == null || input[key] === "") return `Missing ${key}`;
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    for (const key of Object.keys(input))
      if (!allowed.has(key)) return `Unexpected ${key}`;
  }
  for (const [key, value] of Object.entries(input)) {
    const prop = properties[key];
    if (!prop) continue;
    if (prop.enum && !prop.enum.includes(value))
      return `${key} must be one of: ${prop.enum.join(", ")}`;
    if (prop.type === "string" && typeof value !== "string")
      return `${key} must be a string`;
    if (prop.type === "integer" && !Number.isInteger(value))
      return `${key} must be an integer`;
    if (prop.type === "number" && typeof value !== "number")
      return `${key} must be a number`;
    if (prop.type === "boolean" && typeof value !== "boolean")
      return `${key} must be a boolean`;
  }
  return null;
}

export function capBrowserResult(result, limit = BROWSER_TEXT_CAP) {
  if (!result?.content) return result;
  let used = 0,
    truncated = false;
  const content = [];
  for (const part of result.content) {
    if (part.type !== "text" || typeof part.text !== "string") {
      content.push(part);
      continue;
    }
    const room = limit - used;
    if (room <= 0) {
      truncated = true;
      continue;
    }
    if (part.text.length <= room) {
      content.push(part);
      used += part.text.length;
      continue;
    }
    truncated = true;
    content.push({
      ...part,
      text:
        part.text.slice(0, room) +
        "\n[Browser output truncated; the page is still open.]",
    });
    used = limit;
  }
  return truncated ? { ...result, content } : result;
}
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
// profile, and every agent's browser actions pass the same approval. Chrome
// runs without a window; the Browser panel shows it.
export class Browser {
  constructor(dataDir, { command = process.execPath, args, host } = {}) {
    this.dir = join(dataDir, "browser");
    this.command = command;
    this.args = args;
    this.host =
      host ?? (args ? null : new BrowserHost(join(this.dir, "profile")));
    // If Chrome goes away, MCP's connection to it is stale; start both again.
    this.host?.on("closed", () => this.close({ host: false }));
    this.queue = Promise.resolve();
  }
  async connect() {
    if (this.rpc && !this.rpc.closed) return this.rpc;
    this.starting ??= (async () => {
      await mkdir(this.dir, { recursive: true });
      const args = this.args ?? [
        cli,
        "--cdp-endpoint",
        await this.host.endpoint(),
        "--output-dir",
        join(this.dir, "output"),
      ];
      const rpc = new RpcProcess(this.command, args, { cwd: this.dir });
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
  async validate(name, args) {
    const tool = (await this.tools()).find((t) => t.name === name);
    if (!tool) return `The browser has no tool named ${name}`;
    return validateToolInput(tool.inputSchema, args);
  }
  // Chats share one browser, so calls run one at a time.
  call(name, args) {
    const next = this.queue.then(async () => {
      if (withheld.has(name)) throw new Error(`${name} is not available`);
      const failure = await this.validate(name, args);
      if (failure)
        return {
          isError: true,
          content: [{ type: "text", text: failure }],
        };
      await this.host?.start();
      const result = await (
        await this.connect()
      ).call("tools/call", { name, arguments: args ?? {} }, 5 * 60 * 1000);
      return capBrowserResult(
        name === "browser_take_screenshot"
          ? screenshotLinks(result, join(this.dir, "output"))
          : result,
      );
    });
    this.queue = next.catch(() => {});
    return next;
  }
  close({ host = true } = {}) {
    this.rpc?.close();
    this.rpc = null;
    if (host) this.host?.close();
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
