import {
  readFile,
  writeFile,
  rename,
  mkdir,
  open,
  rm,
  realpath,
} from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { retryFileOperation } from "./file-retry.mjs";

export const restartFile = (dataDir) => join(dataDir, "self-restart.json");
export async function readRestartState(dataDir) {
  try {
    return JSON.parse(await readFile(restartFile(dataDir), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export async function atomicJson(path, value, { replace = rename, retry = {} } = {}) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await retryFileOperation(() => replace(temporary, path), retry);
  } finally {
    await rm(temporary, { force: true });
  }
}
export const writeRestartState = (dataDir, state) =>
  atomicJson(restartFile(dataDir), state);
export const samePath = (a, b) =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
export function inside(parent, path) {
  const part = relative(resolve(parent), resolve(path));
  return (
    part !== "" &&
    part !== ".." &&
    !part.startsWith("..\\") &&
    !part.startsWith("../") &&
    !isAbsolute(part)
  );
}
export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
export async function runtimeHealth(dataDir) {
  try {
    const runtime = JSON.parse(
      await readFile(join(dataDir, "runtime.json"), "utf8"),
    );
    const url = new URL(runtime.origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return null;
    const response = await fetch(url.origin + "/health", {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return null;
    const health = await response.json();
    return health.app === "Agentic Harness" &&
      health.instanceId === runtime.instanceId
      ? { runtime, health }
      : null;
  } catch {
    return null;
  }
}
export async function validateRuntime(dataDir, descriptor) {
  if (!descriptor || !/^[a-f0-9]{40,64}$/.test(descriptor.revision ?? ""))
    throw new Error("Invalid restart revision");
  const root = await realpath(descriptor.root);
  const runtimes = await realpath(join(dataDir, "self-runtimes"));
  if (!inside(runtimes, root))
    throw new Error("Runtime is outside Harness's prepared runtimes");
  const manifest = JSON.parse(
    await readFile(join(root, "HARNESS-RUNTIME.json"), "utf8"),
  );
  if (manifest.revision !== descriptor.revision || !manifest.checked)
    throw new Error("Runtime has not passed its checks");
  return root;
}
// Every launcher and the detached helper use this same lock. A dead owner can
// be reclaimed; a live owner is never displaced just because startup is slow.
export async function acquireHostLock(dataDir, { timeoutMs = 120000 } = {}) {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "host-control.lock"),
    deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const file = await open(path, "wx", 0o600);
      const id = randomUUID();
      await file.writeFile(JSON.stringify({ pid: process.pid, id }));
      await file.close();
      return async () => {
        const owner = JSON.parse(
          await readFile(path, "utf8").catch(() => "{}"),
        );
        if (owner.id === id) await rm(path, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readFile(path, "utf8")
        .then(JSON.parse)
        .catch(() => null);
      if (owner?.pid && !processAlive(owner.pid)) {
        // Serialize stale-lock reclamation too: two launchers must not both
        // remove the other's newly acquired lock after observing a dead owner.
        const reclaim = path + ".reclaim";
        let claim;
        try {
          claim = await open(reclaim, "wx", 0o600);
          const latest = await readFile(path, "utf8")
            .then(JSON.parse)
            .catch(() => null);
          if (latest?.id === owner.id && !processAlive(latest.pid))
            await rm(path, { force: true });
        } catch (failure) {
          if (failure.code !== "EEXIST") throw failure;
        } finally {
          if (claim) {
            await claim.close();
            await rm(reclaim, { force: true });
          }
        }
      }
      if (Date.now() >= deadline)
        throw new Error(
          "Harness is still changing hosts. Try again after it finishes.",
        );
      await pause(100);
    }
  }
}
