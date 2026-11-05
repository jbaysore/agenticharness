import { existsSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";

export function commandShell(
  shell = process.platform === "win32" ? "powershell" : "bash",
) {
  const windows = process.platform === "win32";
  if (shell === "powershell") {
    const modern = join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    return {
      command:
        windows && existsSync(modern)
          ? modern
          : windows
            ? "powershell.exe"
            : "pwsh",
      name:
        windows && !existsSync(modern)
          ? "Windows PowerShell 5.1"
          : "PowerShell 7",
    };
  }
  if (shell === "cmd" && windows)
    return { command: "cmd.exe", name: "Command Prompt" };
  if (shell === "bash") {
    if (!windows)
      return existsSync("/bin/bash")
        ? { command: "/bin/bash", name: "Bash" }
        : { command: "/bin/sh", name: "sh" };
    const candidates = [
      process.env.HARNESS_BASH_PATH,
      join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "Git",
        "bin",
        "bash.exe",
      ),
      join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Git",
        "bin",
        "bash.exe",
      ),
    ].filter(Boolean);
    const command = candidates.find(existsSync);
    if (command) return { command, name: "Git Bash" };
    throw new Error(
      "Git Bash is not installed. Choose powershell or cmd, or configure HARNESS_BASH_PATH.",
    );
  }
  throw new Error("Choose a supported command shell: powershell, cmd or bash.");
}

export function dependencyInstructions(path) {
  if (!path || !existsSync(join(path, "package-lock.json"))) return "";
  try {
    const expected = JSON.parse(
      readFileSync(join(path, "package-lock.json"), "utf8"),
    );
    const installed = JSON.parse(
      readFileSync(join(path, "node_modules", ".package-lock.json"), "utf8"),
    );
    const root = expected.packages?.[""] ?? {};
    const names = Object.keys({
      ...root.dependencies,
      ...root.devDependencies,
    });
    const stale = names.some(
      (name) =>
        expected.packages?.["node_modules/" + name]?.version !==
        installed.packages?.["node_modules/" + name]?.version,
    );
    if (!stale) return "";
  } catch {
    // A missing or unreadable dependency manifest also needs preparation.
  }
  let shared = false;
  try {
    shared = lstatSync(join(path, "node_modules")).isSymbolicLink();
  } catch {}
  return `Node dependencies are missing or do not match this worktree's lockfile.${shared ? " The current node_modules is shared with the project." : ""} Before Node builds/tests, use run_command with command: npm.cmd ci --include=dev on Windows (npm ci --include=dev elsewhere). Harness detaches a shared node_modules link before this direct installation; it never deletes the shared target.`;
}

export function commandInstructions(project) {
  if (process.platform !== "win32")
    return (
      "Use run_command for foreground shell commands. It applies this chat's permission review and returns the actual exit code. Use native execution tools for interactive/background sessions, and explicitly wait or poll required results during the active turn. Background process completion does not resume the agent after the turn ends. Never replay a command merely because the native runner lost its connection.\n" +
      dependencyInstructions(project?.path)
    );
  const power = commandShell("powershell"),
    bash = (() => {
      try {
        return commandShell("bash").name;
      } catch {
        return null;
      }
    })();
  return `Windows command support: Prefer Harness run_command for foreground commands, builds, tests and Git operations. It runs in this chat's worktree with the current permission review and does not depend on the native sandbox's command runner. Native interactive/background tools remain available; explicitly wait or poll required results during the active turn. Background process completion does not resume the agent after the turn ends.
The powershell shell is ${power.name}. ${power.name === "Windows PowerShell 5.1" ? "It does not support && or ||. Use shell: cmd for Windows command chains, shell: bash for Bash syntax, or explicit PowerShell conditionals." : "It supports && and ||."}
${bash ? `The bash shell is ${bash}; use it explicitly for Bash heredocs and Unix syntax.` : "Bash is not installed; use PowerShell here-strings or cmd instead of Bash heredocs."} Do not mix cmd switches, Bash expansion and PowerShell syntax in one shell. Use npm.cmd/npx.cmd on Windows when invoking Node package tools directly.
Use rg -g '*.mjs' scripts rather than passing scripts/*.mjs as a literal Windows path. A search exit code of 1 with no diagnostic means no matches; retain that exit code instead of disguising errors as success.
Keep dependencies local to the worktree when installing or changing them. run_command detaches a shared node_modules link before a direct package installation; set isolateDependencies: true for installations inside compound scripts. Use run_command for authorized builds or Git operations that a native sandbox cannot access. After a runner pipe/startup failure, check whether the command started before retrying; never automatically replay an action with an uncertain outcome.
${dependencyInstructions(project?.path)}`;
}
