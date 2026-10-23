import { spawn, execFile } from "node:child_process";
import { subscriptionEnvironment } from "../security/environment.mjs";
import { commandShell } from "./command-shells.mjs";

export const COMMAND_SHELL = process.platform === "win32" ? "PowerShell" : "sh";

// Runs one user-approved command in a project folder and returns what it
// printed. Long output keeps its beginning and end; a stop or timeout ends the
// whole process tree.
export function runCommand({
  command,
  cwd,
  signal,
  timeoutMs = 10 * 60 * 1000,
  limit = 400_000,
  shell = process.platform === "win32" ? "powershell" : "bash",
  onOutput,
}) {
  if (signal?.aborted) return Promise.reject(new Error("The turn was stopped"));
  const selected = commandShell(shell);
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const script = `$ProgressPreference = 'SilentlyContinue'\n$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()\n${command}\n$harnessCommandSucceeded = $?\nif ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\nif (-not $harnessCommandSucceeded) { exit 1 }`;
    const args =
      shell === "powershell"
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-OutputFormat",
            "Text",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ]
        : shell === "cmd"
          ? ["/d", "/s", "/c", `"${command}"`]
          : process.platform === "win32"
            ? ["--noprofile", "--norc", "-c", command]
            : ["-c", command];
    const child = spawn(selected.command, args, {
      cwd,
      env: subscriptionEnvironment(),
      windowsHide: true,
      ...(shell === "cmd" && { windowsVerbatimArguments: true }),
    });
    let head = "",
      tail = "",
      dropped = 0,
      timedOut = false;
    const take = (chunk) => {
      const text = chunk.toString("utf8"),
        room = limit / 2 - head.length;
      onOutput?.(text);
      if (room > 0) head += text.slice(0, room);
      const rest = room > 0 ? text.slice(room) : text;
      if (!rest) return;
      tail += rest;
      if (tail.length > limit / 2) {
        dropped += tail.length - limit / 2;
        tail = tail.slice(-limit / 2);
      }
    };
    const stop = () => {
      if (!child.pid) return;
      if (windows)
        execFile(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true },
          () => {},
        );
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) return reject(new Error("The turn was stopped"));
      resolve({
        exitCode,
        shell: selected.name,
        timedOut,
        truncated: dropped > 0,
        output: dropped
          ? `${head}\n[... ${dropped.toLocaleString("en-US")} characters left out ...]\n${tail}`
          : head + tail,
      });
    });
  });
}
