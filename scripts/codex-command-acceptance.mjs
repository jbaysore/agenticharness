// Exercises installed Codex commands and sandbox boundaries. No model turn,
// inference, account credential, or paid route is used.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openCodex } from "../src/providers/codex.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const local = join(root, ".local");
await mkdir(local, { recursive: true });
const reportPath = join(local, "codex-command-acceptance.json");
if (process.platform === "win32") {
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-File",
      join(root, "scripts", "run-in-user-session.ps1"),
      "-NodePath",
      process.execPath,
      "-ScriptPath",
      fileURLToPath(import.meta.url),
      "-WorkingDirectory",
      root,
      "-DataDir",
      local,
    ],
    { windowsHide: true, timeout: 40000 },
  );
  const handoff = JSON.parse(stdout.trim());
  assert.equal(handoff.ok, true, handoff.error);
  if (handoff.handedOff) {
    console.log(await readFile(reportPath, "utf8"));
    process.exit(0);
  }
}

const fixture = await mkdtemp(join(local, "codex-command-check-"));
const project = join(fixture, "project");
await mkdir(project);
await rm(reportPath, { force: true });
let rpc;
const checks = [];
const policy = {
  type: "workspaceWrite",
  writableRoots: [project],
  networkAccess: false,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: true,
};
const command = (argv, extra = {}) =>
  rpc.call(
    "command/exec",
    {
      command: argv,
      cwd: project,
      sandboxPolicy: policy,
      timeoutMs: 5000,
      ...extra,
    },
    15000,
  );
try {
  rpc = await openCodex(project);
  const start = Date.now();
  if (process.platform === "win32") {
    const ps = await command([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Write-Output POWERSHELL_OK",
    ]);
    assert.equal(ps.exitCode, 0, JSON.stringify(ps));
    assert.match(ps.stdout, /POWERSHELL_OK/);
    checks.push("PowerShell starts");
  }
  const output = await command([
    process.execPath,
    "-e",
    "console.log('STDOUT_OK'); console.error('STDERR_OK'); process.exit(7)",
  ]);
  assert.equal(output.exitCode, 7, JSON.stringify(output));
  assert.match(output.stdout, /STDOUT_OK/);
  assert.match(output.stderr, /STDERR_OK/);
  checks.push("Node output and real exit code");
  const search = await command([
    process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    ...(process.platform === "win32"
      ? ["/d", "/c", "rg --version"]
      : ["-c", "rg --version"]),
  ]);
  assert.equal(search.exitCode, 0, JSON.stringify(search));
  assert.match(search.stdout, /ripgrep/);
  checks.push("ripgrep resolves on PATH");
  const inside = join(project, "inside.txt");
  const write = await command([
    process.execPath,
    "-e",
    "require('fs').writeFileSync(process.argv[1], 'WORKSPACE_OK')",
    inside,
  ]);
  assert.equal(write.exitCode, 0, JSON.stringify(write));
  assert.equal(await readFile(inside, "utf8"), "WORKSPACE_OK");
  const outside = join(fixture, "outside.txt");
  const denied = await command([
    process.execPath,
    "-e",
    "require('fs').writeFileSync(process.argv[1], 'must be denied')",
    outside,
  ]);
  assert.notEqual(denied.exitCode, 0, JSON.stringify(denied));
  await assert.rejects(access(outside));
  checks.push("workspace writes succeed and outside writes are denied");
  const streamed = [];
  rpc.on("notification", ({ method, params }) => {
    if (
      method === "command/exec/outputDelta" &&
      params.processId === "command-check"
    )
      streamed.push(Buffer.from(params.deltaBase64, "base64").toString("utf8"));
  });
  const stream = await command(
    [
      process.execPath,
      "-e",
      "console.log('BEFORE');setTimeout(()=>console.log('AFTER'), 500)",
    ],
    {
      processId: "command-check",
      streamStdoutStderr: true,
    },
  );
  assert.equal(stream.exitCode, 0, JSON.stringify(stream));
  assert.match(streamed.join(""), /BEFORE[\s\S]*AFTER/);
  checks.push("live command output");
  const report = {
    status: "passed",
    at: new Date().toISOString(),
    elapsedMs: Date.now() - start,
    checks,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(
    reportPath,
    JSON.stringify(
      { status: "failed", at: new Date().toISOString(), error: error.message },
      null,
      2,
    ),
  );
  throw error;
} finally {
  rpc?.close();
  assert.equal(dirname(fixture), local);
  await rm(fixture, { recursive: true, force: true });
}
