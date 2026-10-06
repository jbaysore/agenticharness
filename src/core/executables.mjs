import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function executable(name) {
  const override = process.env[`HARNESS_${name.toUpperCase()}_PATH`];
  if (override && existsSync(override)) return override;
  const local = process.env.LOCALAPPDATA;
  const candidates =
    name === "claude"
      ? [join(homedir(), ".local", "bin", "claude.exe")]
      : name === "agent" && local
        ? [
            join(local, "cursor-agent", "agent.exe"),
            join(local, "cursor-agent", "cursor-agent.exe"),
          ]
        : [];
  if (name === "codex" && local) {
    const bin = join(local, "OpenAI", "Codex", "bin");
    if (existsSync(bin))
      candidates.push(
        ...readdirSync(bin, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join(bin, e.name, "codex.exe"))
          .filter((p) => existsSync(p))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs),
      );
  }
  try {
    if (!candidates.some((path) => existsSync(path)))
      candidates.push(
        ...execFileSync(
          process.platform === "win32" ? "where.exe" : "which",
          [name],
          {
            encoding: "utf8",
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
          },
        )
          .trim()
          .split(/\r?\n/),
      );
  } catch {
    /* Report unavailable without starting a login or inference. */
  }
  return (
    candidates.find(
      (path) =>
        existsSync(path) &&
        (process.platform !== "win32" || path.endsWith(".exe")),
    ) ?? null
  );
}

export function cursorCommand() {
  if (process.platform !== "win32")
    return {
      command: executable("agent") ?? executable("cursor-agent"),
      args: [],
    };
  const root =
    process.env.HARNESS_CURSOR_HOME ??
    join(process.env.LOCALAPPDATA ?? "", "cursor-agent");
  const versions = join(root, "versions");
  if (existsSync(versions)) {
    const names = readdirSync(versions)
      .filter((name) => /^\d{4}\.\d{2}\.\d{2}-[\w-]+$/.test(name))
      .sort()
      .reverse();
    for (const name of names) {
      const directory = join(versions, name),
        command = join(directory, "node.exe"),
        script = join(directory, "index.js");
      if (existsSync(command) && existsSync(script))
        return { command, args: [script] };
    }
  }
  return { command: executable("agent"), args: [] };
}
