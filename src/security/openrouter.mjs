import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { subscriptionEnvironment } from "./environment.mjs";

// Keys never enter SQLite, prompts, exports, or child-process environments.
// DPAPI binds the encrypted file to this Windows user's account.
export class OpenRouterCredentials {
  constructor(dataDir, { crypt = windowsCrypt } = {}) {
    this.directory = join(dataDir, "secrets");
    this.path = join(this.directory, "openrouter.dpapi");
    this.crypt = crypt;
  }
  async has() {
    return readFile(this.path).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw new Error("OpenRouter key storage could not be read.");
      },
    );
  }
  async read() {
    try {
      return await this.crypt("unprotect", await readFile(this.path, "utf8"));
    } catch {
      throw new Error("Add your OpenRouter API key again on the Windows host.");
    }
  }
  async write(key) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{20,512}$/.test(key))
      throw new Error("Enter a valid OpenRouter API key.");
    const encrypted = await this.crypt("protect", key);
    await mkdir(this.directory, { recursive: true });
    const temporary = this.path + ".tmp";
    await writeFile(temporary, encrypted, { mode: 0o600 });
    await rename(temporary, this.path);
  }
  async remove() {
    await unlink(this.path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function windowsCrypt(operation, input) {
  if (process.platform !== "win32")
    throw new Error("OpenRouter key storage requires Windows DPAPI.");
  const protect = operation === "protect";
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$value=[Console]::In.ReadToEnd()",
    protect
      ? "$bytes=[Text.Encoding]::UTF8.GetBytes($value)"
      : "$bytes=[Convert]::FromBase64String($value)",
    `$result=[Security.Cryptography.ProtectedData]::${protect ? "Protect" : "Unprotect"}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    protect
      ? "[Console]::Out.Write([Convert]::ToBase64String($result))"
      : "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($result))",
  ].join("; ");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: subscriptionEnvironment(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let output = "";
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      output += text;
      if (output.length > 16384) child.kill();
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Windows protected key storage is unavailable."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && output) resolve(output);
      else reject(new Error("Windows protected key storage is unavailable."));
    });
    child.stdin.end(input);
  });
}

export function explicitOpenRouterModel(id) {
  return (
    typeof id === "string" &&
    id.length <= 200 &&
    /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?::free)?$/.test(id) &&
    !id.startsWith("openrouter/") &&
    !/(^|[\/-])latest([\-:]|$)/.test(id)
  );
}

export function openRouterModelProblem(model) {
  if (!model || !explicitOpenRouterModel(model.id))
    return "Model is unavailable or is a routing alias.";
  if (
    model.canonical_slug !== undefined &&
    (typeof model.canonical_slug !== "string" ||
      !explicitOpenRouterModel(model.canonical_slug))
  )
    return "The model's catalog identity is unavailable or is a routing alias.";
  if (!model.id.endsWith(":free"))
    return "Paid models are disabled. Approve a free variant.";
  const prices = model.pricing;
  const fields = [
    "prompt",
    "completion",
    "request",
    "image",
    "input_cache_read",
    "input_cache_write",
    "internal_reasoning",
    "audio",
    "input_audio",
    "output_audio",
  ];
  if (
    !prices ||
    !["prompt", "completion"].every((key) => prices[key] !== undefined) ||
    fields.some(
      (key) =>
        prices[key] !== undefined &&
        ((typeof prices[key] !== "string" && typeof prices[key] !== "number") ||
          String(prices[key]).trim() === "" ||
          !Number.isFinite(Number(prices[key])) ||
          Number(prices[key]) !== 0),
    )
  )
    return "Zero pricing could not be verified. Paid usage is disabled.";
  if (
    !Array.isArray(model.supported_parameters) ||
    !model.supported_parameters.includes("tools")
  )
    return "This model does not advertise tool calling.";
  if (
    !Array.isArray(model.architecture?.input_modalities) ||
    !Array.isArray(model.architecture?.output_modalities) ||
    !model.architecture.input_modalities.includes("text") ||
    !model.architecture.output_modalities.includes("text")
  )
    return "Choose a model with text input and output.";
  if (!Number.isFinite(model.context_length) || model.context_length < 1024)
    return "The model's context limit is unavailable.";
  return null;
}
