import { readFile, mkdir, open, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireHostLock,
  readRestartState,
  validateRuntime,
  samePath,
  processAlive,
} from "../src/core/restart-state.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function ensureTaskbarShortcut() {
  const script = join(root, "scripts", "taskbar-shortcut.ps1");
  if (process.platform !== "win32" || !existsSync(script))
    return Promise.resolve();
  return new Promise((resolvePromise) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Root",
        root,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    child.on("exit", () => resolvePromise());
    child.on("error", () => resolvePromise());
  });
}
const taskbarShortcut = ensureTaskbarShortcut();
const dataDir =
  process.env.HARNESS_DATA_DIR ??
  join(process.env.LOCALAPPDATA, "AgenticHarness");
await mkdir(dataDir, { recursive: true });
let lastHealthError;
async function running() {
  try {
    const r = JSON.parse(await readFile(join(dataDir, "runtime.json"), "utf8"));
    const response = await fetch(r.origin + "/health", {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok)
      throw new Error(`Health check returned HTTP ${response.status}`);
    const h = await response.json();
    if (h.app !== "Agentic Harness" || h.instanceId !== r.instanceId)
      throw new Error("The running host does not match the saved runtime file");
    lastHealthError = null;
    return r;
  } catch (error) {
    lastHealthError = error.cause?.code ?? error.code ?? error.message;
    return null;
  }
}
async function startupError(path, offset) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const start = Math.max(offset, size - 8192);
    const buffer = Buffer.alloc(Math.max(0, size - start));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .trim()
      .split(/\r?\n/);
    return (
      lines.find((line) => /^(?:\w*Error:|Error \[)/.test(line)) ??
      lines.filter(Boolean).at(-1)
    );
  } finally {
    await file.close();
  }
}
async function launchInUserSession() {
  const script = join(root, "scripts", "run-in-user-session.ps1");
  if (process.platform !== "win32" || !existsSync(script)) return false;
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-File",
      script,
      "-NodePath",
      process.execPath,
      "-ScriptPath",
      fileURLToPath(import.meta.url),
      "-WorkingDirectory",
      root,
      "-DataDir",
      dataDir,
    ],
    { env: process.env, windowsHide: true, timeout: 40000 },
  );
  const result = JSON.parse(stdout.trim());
  if (!result.ok)
    throw new Error(result.error ?? "Windows desktop launch failed");
  return result.handedOff;
}
let releaseControl;
try {
  releaseControl = await acquireHostLock(dataDir);
  let savedRestart = await readRestartState(dataDir);
  if (savedRestart?.handoff) {
    const { recoverAbandonedRestart } = await import("./restart-host.mjs");
    await recoverAbandonedRestart(dataDir);
    savedRestart = await readRestartState(dataDir);
  }
  let runtime = await running();
  if (
    runtime &&
    (process.argv.includes("--stop") || process.argv.includes("--restart"))
  ) {
    const response = await fetch(runtime.origin + "/internal/shutdown", {
      method: "POST",
      headers: { Authorization: "Bearer " + runtime.controlToken },
    });
    if (!response.ok)
      throw new Error(
        "This host does not support graceful shutdown. Close active work before updating it.",
      );
    const deadline = Date.now() + 30000;
    // The port closes before the host process exits; stopped means both.
    while ((await running()) || processAlive(runtime.pid)) {
      if (Date.now() > deadline)
        throw new Error(
          "Host is still stopping. Try again after active work stops.",
        );
      await new Promise((r) => setTimeout(r, 250));
    }
    runtime = null;
  }
  if (process.argv.includes("--stop")) {
    await releaseControl();
    releaseControl = null;
    console.log("Harness host stopped.");
    process.exit(0);
  }
  // Hosts started by a service inherit session 0. Codex's sandbox children
  // cannot initialize USER32 there (the legacy runner reports a pipe timeout).
  // Start the host as this same user in their signed-in session instead.
  if (!runtime) {
    // The desktop handoff invokes this launcher again. Let it acquire the same
    // lock, then recheck health when control returns to this process.
    await releaseControl();
    releaseControl = null;
    const handedOff = await launchInUserSession();
    releaseControl = await acquireHostLock(dataDir);
    runtime = await running();
    if (handedOff && !runtime)
      throw new Error("The Windows desktop host did not pass its health check");
  }
  if (!runtime) {
    savedRestart = await readRestartState(dataDir);
    const launchRoot =
      savedRestart?.active &&
      samePath(savedRestart.source.path, root) &&
      !samePath(savedRestart.active.root, root)
        ? await validateRuntime(dataDir, savedRestart.active)
        : root;
    let config = {};
    try {
      config = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const errorLog = join(dataDir, "host-errors.log"),
      out = await open(join(dataDir, "host.log"), "a"),
      err = await open(errorLog, "a"),
      errorOffset = (await err.stat()).size;
    let startupFailure;
    const child = spawn(
      process.execPath,
      [join(launchRoot, "src", "server.mjs")],
      {
        cwd: launchRoot,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", out.fd, err.fd],
        env: {
          ...process.env,
          HARNESS_DATA_DIR: dataDir,
          HARNESS_RESTART_REQUEST: "",
          ...(config.publicOrigin
            ? { HARNESS_PUBLIC_ORIGIN: config.publicOrigin }
            : {}),
          ...(config.remoteIdentityHash
            ? { HARNESS_REMOTE_IDENTITY_HASH: config.remoteIdentityHash }
            : {}),
          ...(config.access
            ? {
                HARNESS_ACCESS_TEAM_DOMAIN: config.access.teamDomain,
                HARNESS_ACCESS_AUDIENCE: config.access.audience,
              }
            : {}),
          ...(config.tunnel
            ? {
                HARNESS_TUNNEL_EXE: config.tunnel.exe,
                HARNESS_TUNNEL_CONFIG: config.tunnel.config,
              }
            : {}),
          ...(config.initialProject
            ? { HARNESS_INITIAL_PROJECT: config.initialProject }
            : {}),
        },
      },
    );
    child.once("error", (error) => {
      startupFailure = `Harness could not start its host: ${error.message}.`;
    });
    child.once("exit", (code, signal) => {
      startupFailure = `Harness host exited during startup (${signal ?? `code ${code}`}).`;
    });
    child.unref();
    await out.close();
    await err.close();
    const deadline = Date.now() + 20000;
    while (!runtime && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      runtime = await running();
      if (!runtime && startupFailure) break;
    }
    if (!runtime) {
      const detail = await startupError(errorLog, errorOffset).catch(
        () => null,
      );
      throw new Error(
        [
          startupFailure ??
            "Harness did not respond before the startup deadline.",
          detail ??
            (lastHealthError && `Last health check: ${lastHealthError}.`),
          `See ${errorLog}`,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
  }
  await releaseControl();
  releaseControl = null;
  if (process.argv.includes("--supervise")) {
    console.log("Harness host ready at " + runtime.origin);
    // Hub treats a launcher that exits as a failed start, so stay attached while the host is healthy.
    let misses = 0;
    while (misses < 2) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await running()) misses = 0;
      else {
        const restart = await readRestartState(dataDir);
        if (
          restart?.handoff &&
          restart.handoff.deadline > Date.now() &&
          processAlive(restart.handoff.pid)
        )
          misses = 0;
        else misses += 1;
      }
    }
    console.log("Harness host stopped.");
    process.exit(0);
  }
  if (process.argv.includes("--no-browser")) {
    console.log("Harness host ready at " + runtime.origin);
    process.exit(0);
  }
  const response = await fetch(runtime.origin + "/internal/launch", {
    method: "POST",
    headers: { Authorization: "Bearer " + runtime.controlToken },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error("The host refused the local launch capability.");
  const { url } = await response.json();
  await taskbarShortcut;
  const edge = [
    join(
      process.env["ProgramFiles(x86)"] ?? "",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    join(
      process.env.ProgramFiles ?? "",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
  ].find((p) => existsSync(p));
  // An app window has no browser chrome and uses the normal, persistent Edge profile.
  const child = edge
    ? spawn(edge, ["--app=" + url], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      })
    : spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
  child.unref();
} catch (error) {
  await releaseControl?.();
  await appendFile(
    join(dataDir, "launcher-errors.log"),
    new Date().toISOString() + " " + error.message + "\n",
  );
  console.error(error.message);
  process.exitCode = 1;
  const headless =
    process.argv.includes("--no-browser") ||
    process.argv.includes("--supervise");
  if (!headless) {
    const child = spawn("notepad.exe", [join(dataDir, "launcher-errors.log")], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
}
