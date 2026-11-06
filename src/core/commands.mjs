import { spawn, execFile } from "node:child_process";
import { subscriptionEnvironment } from "../security/environment.mjs";
import { commandShell } from "./command-shells.mjs";

export const COMMAND_SHELL = process.platform === "win32" ? "PowerShell" : "sh";

export function commandLaunch(shell, command) {
  const selected = commandShell(shell);
  const script = `$ProgressPreference = 'SilentlyContinue'\n$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()\n${command}\n$harnessCommandSucceeded = $?\nif ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\nif (-not $harnessCommandSucceeded) { exit 1 }`;
  if (shell === "powershell")
    return {
      command: selected.command,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      shellName: selected.name,
    };
  if (shell === "cmd")
    return {
      command: selected.command,
      args: ["/d", "/s", "/c", `"${command}"`],
      verbatim: true,
      shellName: selected.name,
    };
  return {
    command: selected.command,
    args:
      process.platform === "win32"
        ? ["--noprofile", "--norc", "-c", command]
        : ["-c", command],
    shellName: selected.name,
  };
}

export function captureOutput(limit = 400_000) {
  let head = "",
    tail = "",
    dropped = 0;
  return {
    push(chunk) {
      const text = chunk.toString("utf8"),
        room = limit / 2 - head.length;
      if (room > 0) head += text.slice(0, room);
      const rest = room > 0 ? text.slice(room) : text;
      if (!rest) return;
      tail += rest;
      if (tail.length > limit / 2) {
        dropped += tail.length - limit / 2;
        tail = tail.slice(-limit / 2);
      }
    },
    text() {
      return dropped
        ? `${head}\n[... ${dropped.toLocaleString("en-US")} characters left out ...]\n${tail}`
        : head + tail;
    },
    get truncated() {
      return dropped > 0;
    },
  };
}

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
  const selected = commandLaunch(shell, command);
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(selected.command, selected.args, {
      cwd,
      env: subscriptionEnvironment(),
      windowsHide: true,
      ...(selected.verbatim && { windowsVerbatimArguments: true }),
    });
    const output = captureOutput(limit);
    let timedOut = false;
    const take = (chunk) => {
      onOutput?.(chunk.toString("utf8"));
      output.push(chunk);
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
        shell: selected.shellName,
        timedOut,
        truncated: output.truncated,
        output: output.text(),
      });
    });
  });
}
