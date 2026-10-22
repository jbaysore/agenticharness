// Runs outside the provider's process tree, survives host exit, and never calls
// an inference provider. Control tokens arrive over IPC, not command arguments.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, readFile, copyFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireHostLock,
  readRestartState,
  writeRestartState,
  validateRuntime,
  runtimeHealth,
  processAlive,
  pause,
  samePath,
} from "../src/core/restart-state.mjs";
import { subscriptionEnvironment } from "../src/security/environment.mjs";

async function waitUntil(test, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!(await test())) {
    if (Date.now() >= deadline) throw new Error(message);
    await pause(100);
  }
}
export async function launchRuntime(
  descriptor,
  dataDir,
  environment = {},
  requestId = null,
) {
  const root = await validateRuntime(dataDir, descriptor);
  const out = await open(join(dataDir, "host.log"), "a"),
    err = await open(join(dataDir, "host-errors.log"), "a");
  try {
    const child = spawn(process.execPath, [join(root, "src", "server.mjs")], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out.fd, err.fd],
      env: {
        ...subscriptionEnvironment(),
        ...environment,
        HARNESS_DATA_DIR: dataDir,
        HARNESS_RESTART_REQUEST: requestId ?? "",
      },
    });
    let failure;
    child.once("error", (error) => {
      failure = error;
    });
    child.unref();
    return { child, failure: () => failure };
  } finally {
    await out.close();
    await err.close();
  }
}
async function waitForRuntime(started, spec, descriptor, timeoutMs) {
  let found;
  await waitUntil(
    async () => {
      if (started.failure()) throw started.failure();
      if (started.child.exitCode !== null)
        throw new Error("Replacement host exited during startup");
      const current = await runtimeHealth(spec.dataDir);
      if (
        current?.runtime.pid === started.child.pid &&
        current.health.ready === true &&
        current.health.revision === descriptor.revision
      )
        found = current;
      return !!found;
    },
    timeoutMs,
    "Replacement host did not pass its readiness check",
  );
  return found;
}
async function stopCandidate(started, dataDir) {
  if (!started || !started.child.pid || started.child.exitCode !== null) return;
  const current = await runtimeHealth(dataDir);
  if (current?.runtime.pid === started.child.pid) {
    await fetch(current.runtime.origin + "/internal/shutdown", {
      method: "POST",
      headers: { Authorization: "Bearer " + current.runtime.controlToken },
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }
  for (
    let attempt = 0;
    attempt < 30 && processAlive(started.child.pid);
    attempt++
  )
    await pause(100);
  if (processAlive(started.child.pid)) {
    // No work was admitted to this candidate. End its descendants too, such as
    // the remote tunnel, before bringing the previous host back on the same port.
    if (process.platform === "win32") {
      await promisify(execFile)(
        "taskkill.exe",
        ["/PID", String(started.child.pid), "/T", "/F"],
        { windowsHide: true },
      ).catch((error) => {
        if (processAlive(started.child.pid)) throw error;
      });
    } else {
      try {
        process.kill(-started.child.pid, "SIGKILL");
      } catch (error) {
        if (processAlive(started.child.pid)) throw error;
      }
    }
  }
  await waitUntil(
    () => !processAlive(started.child.pid),
    10000,
    "Failed candidate did not stop; database recovery was withheld",
  );
}
export async function restoreDatabase(dataDir, snapshot) {
  // The recovery copy includes browser pairings; it is private and is never
  // returned by the downloadable backup API. Never mix it with a previous WAL.
  if (
    !samePath(
      snapshot,
      join(
        dataDir,
        "self-restart-" +
          (await readRestartState(dataDir)).request.id +
          ".sqlite",
      ),
    )
  )
    throw new Error("Invalid restart recovery snapshot");
  const database = join(dataDir, "workspace.sqlite");
  await rm(database + "-wal", { force: true });
  await rm(database + "-shm", { force: true });
  await copyFile(snapshot, database);
}
export async function performRestart(
  spec,
  { startupMs = 30000, exitMs = 30000 } = {},
) {
  const { dataDir } = spec;
  let candidate;
  await waitUntil(
    () => !processAlive(spec.runtime.pid),
    exitMs,
    "Original host is still stopping; it has not been terminated",
  );
  try {
    const launching = await readRestartState(dataDir);
    launching.handoff.launching = true;
    await writeRestartState(dataDir, launching);
    candidate = await launchRuntime(
      spec.candidate,
      dataDir,
      spec.environment,
      spec.requestId,
    );
    launching.handoff.candidatePid = candidate.child.pid;
    await writeRestartState(dataDir, launching);
    const { runtime } = await waitForRuntime(
      candidate,
      spec,
      spec.candidate,
      startupMs,
    );
    const response = await fetch(
      runtime.origin + "/internal/restart/activate",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + runtime.controlToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requestId: spec.requestId }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok)
      throw new Error("Replacement host refused restart activation");
  } catch (error) {
    let state = await readRestartState(dataDir);
    // Activation is durable before admission opens. A lost HTTP response must
    // never roll back a host that may already have accepted new user work.
    if (
      state.request?.id === spec.requestId &&
      state.request.status === "updated"
    )
      return;
    await stopCandidate(candidate, dataDir);
    state.request.status = "recovering";
    state.request.error = error.message;
    await writeRestartState(dataDir, state);
    await restoreDatabase(dataDir, spec.snapshot);
    state.active = spec.fallback;
    state.request.status = "failed";
    delete state.handoff;
    await writeRestartState(dataDir, state);
    const fallback = await launchRuntime(
      spec.fallback,
      dataDir,
      spec.environment,
    );
    await waitForRuntime(fallback, spec, spec.fallback, startupMs);
    console.error(
      "Self restart recovered the previous runtime: " + error.message,
    );
  }
}

export async function recoverAbandonedRestart(dataDir) {
  let state = await readRestartState(dataDir);
  if (!state?.handoff) return;
  if (processAlive(state.handoff.pid))
    throw new Error("The restart helper is still running");
  if (processAlive(state.handoff.oldPid))
    throw new Error(
      "The original host is still stopping. Close it before recovery.",
    );
  const current = await runtimeHealth(dataDir);
  if (
    current?.health.acceptingWork === false &&
    current.runtime.pid === state.handoff.candidatePid
  ) {
    await stopCandidate(
      {
        child: {
          pid: current.runtime.pid,
          exitCode: null,
          kill: () => process.kill(current.runtime.pid),
        },
      },
      dataDir,
    );
  } else if (current)
    throw new Error(
      "A host is still running. Recovery will not overwrite its database.",
    );
  // A candidate can die before publishing runtime.json. Also check its durable
  // PID before touching SQLite; a live candidate must be recovered by its helper.
  const runtime = await readFile(join(dataDir, "runtime.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (runtime?.pid && processAlive(runtime.pid))
    throw new Error(
      "A replacement host is still running. Recovery was withheld.",
    );
  if (state.handoff.candidatePid && processAlive(state.handoff.candidatePid))
    throw new Error(
      "A replacement process is still running. Recovery was withheld.",
    );
  if (state.handoff.launching && !state.handoff.candidatePid)
    throw new Error(
      "The helper stopped while starting a process. Recovery requires checking that process has ended.",
    );
  await restoreDatabase(dataDir, state.handoff.snapshot);
  state.active = state.previous;
  state.request.status = "failed";
  state.request.error =
    "The restart helper stopped unexpectedly. The previous runtime was restored.";
  delete state.handoff;
  await writeRestartState(dataDir, state);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  let release;
  try {
    const spec = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("No restart handoff received")),
        10000,
      );
      process.once("message", (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    await validateRuntime(spec.dataDir, spec.candidate);
    await validateRuntime(spec.dataDir, spec.fallback);
    release = await acquireHostLock(spec.dataDir, { timeoutMs: 5000 });
    const go = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Restart was not handed off")),
        15000,
      );
      process.once("message", (message) => {
        clearTimeout(timer);
        message.go ? resolve() : reject(new Error("Invalid restart handoff"));
      });
      process.once("disconnect", async () => {
        clearTimeout(timer);
        const state = await readRestartState(spec.dataDir).catch(() => null);
        state?.handoff?.requestId === spec.requestId
          ? resolve()
          : reject(new Error("Host disconnected before committing restart"));
      });
    });
    process.send({ ready: true });
    await go;
    await performRestart(spec);
  } catch (error) {
    if (process.connected) process.send({ error: error.message }, () => {});
    console.error(new Date().toISOString() + " " + error.message);
    process.exitCode = 1;
  } finally {
    await release?.();
    if (process.connected) process.disconnect();
  }
}
