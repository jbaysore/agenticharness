import { spawn, execFile } from "node:child_process";
import { subscriptionEnvironment } from "../security/environment.mjs";

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
}) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32",
      child = spawn(
        windows ? "powershell.exe" : "/bin/sh",
        windows
          ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
          : ["-c", command],
        { cwd, env: subscriptionEnvironment(), windowsHide: true },
      );
    let head = "",
      tail = "",
      dropped = 0,
      timedOut = false;
    const take = (chunk) => {
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
    };
    const stop = () => {
      if (windows)
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) return reject(new Error("The turn was stopped"));
      resolve({
        exitCode,
        timedOut,
        truncated: dropped > 0,
        output: dropped
          ? `${head}\n[... ${dropped.toLocaleString("en-US")} characters left out ...]\n${tail}`
          : head + tail,
      });
    });
  });
}
