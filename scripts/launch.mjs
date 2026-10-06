import { readFile, mkdir, open, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir =
  process.env.HARNESS_DATA_DIR ??
  join(process.env.LOCALAPPDATA, "AgenticHarness");
await mkdir(dataDir, { recursive: true });
async function running() {
  try {
    const r = JSON.parse(await readFile(join(dataDir, "runtime.json"), "utf8"));
    const h = await fetch(r.origin + "/health", {
      signal: AbortSignal.timeout(1200),
    }).then((r) => r.json());
    return h.app === "Agentic Harness" && h.instanceId === r.instanceId
      ? r
      : null;
  } catch {
    return null;
  }
}
try {
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
    while (await running()) {
      if (Date.now() > deadline)
        throw new Error(
          "Host is still stopping. Try again after active work stops.",
        );
      await new Promise((r) => setTimeout(r, 250));
    }
    runtime = null;
  }
  if (process.argv.includes("--stop")) {
    console.log("Harness host stopped.");
    process.exit(0);
  }
  if (!runtime) {
    let config = {};
    try {
      config = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const out = await open(join(dataDir, "host.log"), "a"),
      err = await open(join(dataDir, "host-errors.log"), "a");
    const child = spawn(process.execPath, [join(root, "src", "server.mjs")], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out.fd, err.fd],
      env: {
        ...process.env,
        HARNESS_DATA_DIR: dataDir,
        ...(config.publicOrigin
          ? { HARNESS_PUBLIC_ORIGIN: config.publicOrigin }
          : {}),
        ...(config.remoteIdentityHash
          ? { HARNESS_REMOTE_IDENTITY_HASH: config.remoteIdentityHash }
          : {}),
        ...(config.initialProject
          ? { HARNESS_INITIAL_PROJECT: config.initialProject }
          : {}),
      },
    });
    child.unref();
    await out.close();
    await err.close();
    const deadline = Date.now() + 20000;
    while (!runtime && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      runtime = await running();
    }
    if (!runtime)
      throw new Error(
        "Harness did not start. See " + join(dataDir, "host-errors.log"),
      );
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
  await appendFile(
    join(dataDir, "launcher-errors.log"),
    new Date().toISOString() + " " + error.message + "\n",
  );
  console.error(error.message);
  process.exitCode = 1;
  if (!process.argv.includes("--no-browser")) {
    const child = spawn("notepad.exe", [join(dataDir, "launcher-errors.log")], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
}
