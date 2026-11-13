import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  identitiesMatch,
  killIfMatched,
  processIdentity,
} from "./process-identity.mjs";

const runner = fileURLToPath(
  new URL("./command-watch-runner.mjs", import.meta.url),
);

export async function startDetached({ statusDir, command, shell, cwd }) {
  await mkdir(statusDir, { recursive: true });
  await writeFile(
    join(statusDir, "request.json"),
    JSON.stringify({ command, shell, cwd }),
  );
  const child = spawn(process.execPath, [runner, statusDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  let identity = null;
  try {
    identity = await processIdentity(child.pid);
  } catch {
    identity = null;
  }
  if (!identity) {
    try {
      child.kill();
    } catch {}
    child.unref();
    throw new Error(
      "The command runner started, but its process identity could not be read, so it was not kept.",
    );
  }
  child.unref();
  return { pid: identity.pid, createdAt: identity.createdAt, statusDir };
}

export async function readCommandResult(watch) {
  const dir = watch.runner?.statusDir ?? watch.statusDir;
  if (!dir) return { done: false };
  let result;
  try {
    result = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      return { done: false, ...(await readProgress(watch)) };
    throw error;
  }
  if (!Number.isInteger(result.exitCode))
    throw new Error("The command result has no valid exit code.");
  const output = await readFile(join(dir, "output.txt"), "utf8").catch(
    () => "",
  );
  return {
    done: true,
    exitCode: result.exitCode,
    output,
  };
}

// New runners publish bounded live output with their heartbeat. Old runners
// only have `at`; both formats remain readable after a host update.
export async function readProgress(watch) {
  const dir = watch.runner?.statusDir ?? watch.statusDir;
  if (!dir) return {};
  try {
    const data = JSON.parse(
      await readFile(join(dir, "heartbeat.json"), "utf8"),
    );
    return {
      heartbeatAt: Number.isFinite(data.at) ? data.at : null,
      output:
        typeof data.output === "string" ? data.output.slice(-8000) : undefined,
      outputBytes: Number.isFinite(data.outputBytes)
        ? data.outputBytes
        : undefined,
      lastOutputAt: Number.isFinite(data.lastOutputAt)
        ? data.lastOutputAt
        : undefined,
    };
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function readHeartbeat(watch) {
  return (await readProgress(watch)).heartbeatAt ?? null;
}

export const commandControls = {
  start: startDetached,
  read: readCommandResult,
  heartbeat: readHeartbeat,
  identity: processIdentity,
  killIfMatched: (recorded) => killIfMatched(recorded),
  matches: identitiesMatch,
};
