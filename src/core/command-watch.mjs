import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  identitiesMatch,
  killIfMatched,
  processIdentity,
} from "./process-identity.mjs";

const runner = fileURLToPath(new URL("./command-watch-runner.mjs", import.meta.url));

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
  try {
    const result = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
    const output = await readFile(join(dir, "output.txt"), "utf8").catch(() => "");
    return {
      done: true,
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 1,
      output,
    };
  } catch {
    return { done: false };
  }
}

export const commandControls = {
  start: startDetached,
  read: readCommandResult,
  identity: processIdentity,
  killIfMatched: (recorded) => killIfMatched(recorded),
  matches: identitiesMatch,
};
