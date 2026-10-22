import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

let registeredSearchDirectory;

// The Windows desktop app bundles ripgrep, but its resources directory is not
// on a standalone host's PATH. Reuse the installed tool without downloading it
// or replacing tools the user already has on PATH.
function bundledSearchDirectory(source) {
  const programFiles = Object.entries(source).find(
    ([key]) => key.toLowerCase() === "programfiles",
  )?.[1];
  if (!programFiles) return null;
  const packages = join(programFiles, "WindowsApps");
  try {
    for (const name of readdirSync(packages)
      .filter((name) =>
        /^OpenAI\.Codex_[\d.]+_(?:x64|arm64)__2p2nqsd0c76g0$/.test(name),
      )
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))) {
      const resources = join(packages, name, "app", "resources");
      if (existsSync(join(resources, "rg.exe"))) return resources;
    }
  } catch {
    // A normal desktop token can read its package but cannot list WindowsApps.
  }
  if (
    registeredSearchDirectory &&
    existsSync(join(registeredSearchDirectory, "rg.exe"))
  )
    return registeredSearchDirectory;
  if (registeredSearchDirectory !== null) {
    registeredSearchDirectory = null;
    try {
      const installed = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation",
        ],
        {
          env: source,
          encoding: "utf8",
          windowsHide: true,
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      if (
        installed &&
        existsSync(join(installed, "app", "resources", "rg.exe"))
      )
        registeredSearchDirectory = join(installed, "app", "resources");
    } catch {
      // A CLI-only installation does not supply a bundled search tool.
    }
  }
  return registeredSearchDirectory;
}

// Credentials remain in the providers' own stores. Never read or proxy OAuth tokens.
// Do not inherit API credentials, model gateways, SDK switches, or paid fallbacks.
export function subscriptionEnvironment(
  source = process.env,
  { platform = process.platform } = {},
) {
  const env = {};
  const blocked =
    /^(OPENAI_|CODEX_(?!HOME$)|ANTHROPIC_|CLAUDE_CODE_|CURSOR_|AWS_|AZURE_|GOOGLE_|VERTEX_|BEDROCK_|NODE_OPTIONS$)/i;
  for (const [key, value] of Object.entries(source)) {
    if (!blocked.test(key) && value !== undefined) env[key] = value;
  }
  if (platform === "win32") {
    const directory = bundledSearchDirectory(env);
    if (directory) {
      const key =
        Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
      const entries = (env[key] ?? "").split(";").filter(Boolean);
      if (
        !entries.some(
          (entry) => entry.toLowerCase() === directory.toLowerCase(),
        )
      )
        env[key] = [...entries, directory].join(";");
    }
  }
  return env;
}
