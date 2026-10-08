import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function powershell(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args],
      { windowsHide: true },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err || out || "shortcut script failed"));
    });
  });
}

test("the Harness shortcut keeps the Edge app identity instead of the browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-shortcut-"));
  const links = await mkdtemp(join(tmpdir(), "harness-links-"));
  await mkdir(join(root, "dist", "icons"), { recursive: true });
  await writeFile(join(root, "Launch Harness.vbs"), 'WScript.Echo "ok"\r\n');
  await writeFile(join(root, "dist", "icons", "harness.ico"), "icon");
  const desktop = join(links, "desktop.lnk");
  const startMenu = join(links, "start.lnk");
  const script = fileURLToPath(
    new URL("../scripts/taskbar-shortcut.ps1", import.meta.url),
  );
  const written = await powershell([
    "-File",
    script,
    "-Root",
    root,
    "-DesktopPath",
    desktop,
    "-StartMenuPath",
    startMenu,
  ]);
  assert.equal(written, "MSEdge.127.0.0.1_/");
  const read = await powershell([
    "-File",
    script,
    "-Root",
    root,
    "-ReadPath",
    startMenu,
  ]);
  assert.equal(read, "MSEdge.127.0.0.1_/");
});
