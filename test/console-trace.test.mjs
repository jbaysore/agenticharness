import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../src/core/commands.mjs";

const windows = process.platform === "win32";
const exec = promisify(execFile);
const script = fileURLToPath(
  new URL("../scripts/trace-console-windows.ps1", import.meta.url),
);
const source = fileURLToPath(
  new URL("../scripts/console-window-trace.cs", import.meta.url),
);
const encoded = (text) => Buffer.from(text, "utf16le").toString("base64");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const trace = async (data, action, extra = []) => {
  const { stdout } = await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-DataDirectory",
      data,
      "-Action",
      action,
      ...extra,
    ],
    { windowsHide: true, timeout: 25000 },
  );
  return JSON.parse(stdout.trim());
};

test(
  "PowerShell launch metadata identifies encoded Harness work without retaining its content",
  { skip: !windows },
  async () => {
    const payload =
      "$OutputEncoding = [Console]::OutputEncoding; Write-Output SENSITIVE_TRACE_FIXTURE; $harnessCommandSucceeded = $?";
    const cases = [
      {
        name: "powershell.exe",
        command: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded(payload)}`,
      },
      {
        name: "pwsh.exe",
        command:
          'pwsh.exe -WindowStyle Hidden -File "C:\\a folder\\service-start.ps1" -Token SENSITIVE_TRACE_FIXTURE',
      },
      {
        name: "powershell.exe",
        command: "powershell.exe -Command Get-CimInstance Win32_Process",
      },
      {
        name: "powershell.exe",
        command: "powershell.exe -EncodedCommand invalid!",
      },
      { name: "powershell.exe", command: null },
      { name: "node.exe", command: "node.exe ignored" },
    ];
    const code = `Add-Type -Path '${source.replaceAll("'", "''")}' -ReferencedAssemblies System.Web.Extensions,System.Core
$cases = $env:HARNESS_TRACE_CASES | ConvertFrom-Json
$results = @()
foreach ($case in $cases) { $results += ,([Harness.Diagnostics.ConsoleWindowTrace]::DescribePowerShell($case.name, $case.command)) }
ConvertTo-Json -InputObject $results -Compress`;
    const { stdout } = await exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(code)],
      {
        windowsHide: true,
        env: { ...process.env, HARNESS_TRACE_CASES: JSON.stringify(cases) },
        timeout: 20000,
      },
    );
    const result = JSON.parse(stdout);
    assert.equal(result[0].mode, "encoded");
    assert.equal(result[0].payloadSha256, digest(payload));
    assert.equal(result[0].knownAction, "harness-foreground-command");
    assert.equal(result[0].nonInteractive, true);
    assert.equal(result[1].scriptName, "service-start.ps1");
    assert.equal(result[1].windowStyle, "hidden");
    assert.equal(result[2].knownAction, "process-parent-scan");
    assert.equal(result[3].mode, "invalid-encoded");
    // A null command marshals to an empty string in PowerShell; unreadable live
    // processes still get an explicit unavailable mode inside ReadProcess.
    assert.equal(result[4].mode, "interactive");
    assert.equal(result[5], null);
    assert.ok(!stdout.includes("SENSITIVE_TRACE_FIXTURE"));
    assert.ok(!stdout.includes(encoded(payload)));
  },
);

test(
  "desktop capture records hidden PowerShell ancestry, stays private, reports and stops",
  { skip: !windows, timeout: 60000 },
  async () => {
    const data = await mkdtemp(join(tmpdir(), "harness-console-trace-"));
    let started;
    try {
      started = await trace(data, "Start", ["-DurationSeconds", "45"]);
      assert.equal(started.running, true);
      assert.equal(started.status.captureCommandLines, false);
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          encoded(
            "Write-Output SENSITIVE_TRACE_FIXTURE; Start-Sleep -Milliseconds 900",
          ),
        ],
        { windowsHide: true },
      );
      const childId = child.pid;
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      const command = await runCommand({
        command:
          "Write-Output SENSITIVE_TRACE_FIXTURE; Start-Sleep -Milliseconds 900",
        cwd: data,
      });
      assert.equal(command.exitCode, 0);
      const stopped = await trace(data, "Stop");
      assert.equal(stopped.running, false);
      const raw = await readFile(
        join(started.runDirectory, "events.jsonl"),
        "utf8",
      );
      assert.ok(!raw.includes("SENSITIVE_TRACE_FIXTURE"));
      const entries = raw.trim().split("\n").map(JSON.parse);
      const start = entries.find((e) => e.type === "started");
      assert.equal(start.station.toLowerCase(), "winsta0");
      assert.equal(start.desktop.toLowerCase(), "default");
      const shell = entries.find(
        (e) => e.type === "powershell-start" && e.process.id === childId,
      );
      assert.ok(shell, "short-lived shell has its own start record");
      assert.equal(shell.process.command, null);
      assert.equal(shell.process.powerShell.mode, "encoded");
      assert.ok(
        shell.ancestry.some((p) => p.id === process.pid),
        "owning Node process is preserved",
      );
      assert.ok(
        entries.some(
          (e) =>
            e.type === "powershell-start" &&
            e.process.powerShell.knownAction === "harness-foreground-command",
        ),
      );
      for (const event of entries.filter((e) => e.type === "window"))
        assert.equal(event.window.title, null);
      const report = await trace(data, "Report");
      assert.ok(report.powerShellStarts >= 2);
      assert.ok(
        report.recentPowerShellStarts.some((p) => p.processId === childId),
      );
    } finally {
      if (started) await trace(data, "Stop");
      await rm(data, { recursive: true, force: true });
    }
  },
);

test(
  "capture status rejects a stale heartbeat and reports metadata without old raw commands",
  { skip: !windows },
  async () => {
    const data = await mkdtemp(join(tmpdir(), "harness-console-status-"));
    const run = join(data, "capture");
    await mkdir(run);
    try {
      const code =
        "(Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')";
      // Use a real still-running process for identity; the stale heartbeat alone
      // must prevent this capture from being reported as healthy.
      const helper = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `${code}; Start-Sleep -Seconds 15`,
        ],
        { windowsHide: true },
      );
      try {
        const timestamp = await new Promise((resolve, reject) => {
          helper.once("error", reject);
          helper.stdout.once("data", (bytes) =>
            resolve(bytes.toString().trim()),
          );
        });
        await writeFile(
          join(data, "active.json"),
          JSON.stringify({
            processId: helper.pid,
            processStartedUtc: timestamp,
            runDirectory: run,
          }),
        );
        await writeFile(
          join(run, "status.json"),
          JSON.stringify({
            state: "running",
            heartbeatUtc: new Date(Date.now() - 60000).toISOString(),
            expiresUtc: new Date(Date.now() + 60000).toISOString(),
          }),
        );
        assert.equal((await trace(data, "Status")).running, false);
        await writeFile(
          join(run, "events.jsonl"),
          JSON.stringify({
            type: "window",
            utc: new Date().toISOString(),
            kind: "show",
            window: {
              console: true,
              visible: true,
              foreground: true,
              title: "SENSITIVE_TRACE_FIXTURE",
              ancestry: [
                {
                  id: 10,
                  parent: 9,
                  name: "powershell.exe",
                  command: "SENSITIVE_TRACE_FIXTURE",
                },
              ],
            },
          }) + "\n",
        );
        const report = await trace(data, "Report");
        assert.equal(report.visibleConsoleEvents, 1);
        assert.equal(report.visible[0].ancestry[0].name, "powershell.exe");
        assert.ok(!JSON.stringify(report).includes("SENSITIVE_TRACE_FIXTURE"));
      } finally {
        helper.kill();
      }
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  },
);
