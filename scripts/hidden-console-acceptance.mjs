// Real desktop visibility/focus checks. No providers or inference are started.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  appendFile,
  readdir,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
const powershell = async (code) =>
  (
    await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(
          "$ProgressPreference='SilentlyContinue'\n" + code,
          "utf16le",
        ).toString("base64"),
      ],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
    )
  ).stdout;
const jsonFile = async (file) =>
  JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));

async function worker() {
  const data = process.env.HARNESS_CONSOLE_ACCEPTANCE;
  if (process.env.HARNESS_CONSOLE_PHASE === "launcher") {
    await appendFile(
      join(data, "launchers.jsonl"),
      JSON.stringify({
        pid: process.pid,
        cwd: process.cwd(),
        args: process.argv.slice(2),
      }) + "\n",
    );
    return;
  }
  if (process.env.HARNESS_CONSOLE_PHASE === "terminals") {
    // Match launch.mjs: the real host is detached with file-backed output.
    // A worker directly beneath CreateNoWindow does not reproduce that state.
    const out = openSync(join(data, "host.stdout.log"), "a");
    const err = openSync(join(data, "host.stderr.log"), "a");
    try {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", out, err],
        env: { ...process.env, HARNESS_CONSOLE_PHASE: "terminal-host" },
      });
      await new Promise((done, reject) => {
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0
            ? done()
            : reject(
                new Error(`Fixture host failed (${code}); see host.stderr.log`),
              ),
        );
      });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    return;
  }
  const source = process.env.HARNESS_CONSOLE_SOURCE_ROOT;
  const { createHarness } = await import(
    pathToFileURL(join(source, "src/server.mjs"))
  );
  const app = await createHarness({
    dataDir: join(data, "host"),
    port: 0,
    startProviders: false,
  });
  const project = app.store.addProject("Hidden console fixture", data);
  const checks = [];
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 6000;
    while (!predicate() && Date.now() < deadline) await delay(50);
    assert.ok(predicate(), message);
  };
  try {
    for (const shell of ["powershell", "cmd"]) {
      for (let cycle = 0; cycle < 2; cycle++) {
        const session = app.terminals.create(project, { shell });
        app.terminals.write(
          session.id,
          shell === "powershell"
            ? "Write-Output 'HIDDEN_OK'\r"
            : "echo HIDDEN_OK\r",
        );
        await waitFor(
          () =>
            (
              app.terminals.sessions
                .get(session.id)
                ?.output.match(/HIDDEN_OK/g) || []
            ).length >= 2,
          `${shell} command did not complete`,
        );
        await app.terminals.close(session.id);
        await delay(400);
        checks.push(`${shell} command and close`);
      }
      const unused = app.terminals.create(project, { shell });
      assert.equal(await app.terminals.discardUnused(unused.groupId), true);
      await delay(400);
      checks.push(`${shell} unused terminal removal`);
    }
    const session = app.terminals.create(project);
    const node = process.execPath.replaceAll("'", "''");
    app.terminals.write(
      session.id,
      `& '${node}' -e "console.log('DESCENDANT_PID=' + process.pid);setInterval(()=>{},1000)"\r`,
    );
    await waitFor(
      () =>
        /DESCENDANT_PID=(\d+)/.test(
          app.terminals.sessions.get(session.id)?.output || "",
        ),
      "Terminal descendant did not start",
    );
    const descendant = Number(
      app.terminals.sessions
        .get(session.id)
        .output.match(/DESCENDANT_PID=(\d+)/)[1],
    );
    await app.terminals.close(session.id);
    await waitFor(() => {
      try {
        process.kill(descendant, 0);
        return false;
      } catch (e) {
        if (e.code === "ESRCH") return true;
        throw e;
      }
    }, "Terminal descendant survived cleanup");
    checks.push("running terminal descendant cleanup");
    app.terminals.create(project, { shell: "powershell" });
    app.terminals.create(project, { shell: "cmd" });
    await app.close();
    await delay(1000);
    checks.push("host shutdown with both shells");
    await writeFile(
      join(data, "terminal-checks.json"),
      JSON.stringify({ pid: process.pid, checks }),
    );
  } finally {
    await app.close();
  }
}

async function controller() {
  assert.equal(
    process.platform,
    "win32",
    "Run this acceptance check on Windows with a signed-in desktop.",
  );
  const sourceFlag = process.argv.indexOf("--source-root");
  const source = sourceFlag < 0 ? root : resolve(process.argv[sourceFlag + 1]);
  await mkdir(join(root, ".local"), { recursive: true });
  const data = await mkdtemp(join(root, ".local", "hidden-console-"));
  const traceData = join(data, "trace");
  const trace = async (action) => {
    // The passive logger outlives the Start command. Give that command files,
    // not execFile pipes whose inherited handles can postpone its close event.
    const output = join(data, `trace-${action}.json`);
    const errors = join(data, `trace-${action}.err`);
    const out = openSync(output, "w"),
      err = openSync(errors, "w");
    try {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(root, "scripts/trace-console-windows.ps1"),
          "-Action",
          action,
          "-DataDirectory",
          traceData,
          "-DurationSeconds",
          "180",
        ],
        { windowsHide: true, stdio: ["ignore", out, err] },
      );
      await new Promise((done, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`Trace ${action} timed out`));
        }, 30000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          code === 0
            ? done()
            : reject(new Error(`Trace ${action} failed (${code})`));
        });
      });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    return jsonFile(output);
  };
  const environment = {
    HARNESS_CONSOLE_ACCEPTANCE: data,
    HARNESS_CONSOLE_SOURCE_ROOT: source,
    HARNESS_CONSOLE_WORKER: "1",
  };
  const workerFile = fileURLToPath(import.meta.url);
  const tasks = [];
  const schedule = async (name, logon, executable, args) => {
    tasks.push(name);
    await powershell(`$ErrorActionPreference='Stop'
$action=New-ScheduledTaskAction -Execute ${quote(executable)} -Argument ${quote(args)} -WorkingDirectory ${quote(root)}
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType ${logon} -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName ${quote(name)} -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName ${quote(name)}`);
  };
  const waitFile = async (file) => {
    const deadline = Date.now() + 100000;
    while (Date.now() < deadline) {
      try {
        return await jsonFile(file);
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
      }
      await delay(200);
    }
    throw new Error(`Timed out waiting for ${file}`);
  };
  let started;
  try {
    started = await trace("Start");
    assert.equal(started.running, true);
    // Exercise the exact interactive task action used by the handoff. Creating
    // a new S4U service task requires admin rights; the desktop action does not.
    for (let i = 0; i < 5; i++) {
      const request = join(data, `launcher-${i}.request.json`);
      const response = join(data, `launcher-${i}.response.json`);
      await writeFile(
        request,
        JSON.stringify({
          nodePath: process.execPath,
          scriptPath: workerFile,
          workingDirectory: root,
          environment: { ...environment, HARNESS_CONSOLE_PHASE: "launcher" },
          responseFile: response,
        }),
      );
      const wrapper = join(source, "scripts/run-in-user-session.vbs");
      const worker = join(source, "scripts/run-in-user-session.ps1");
      await schedule(
        "Harness-Console-Check-" + randomUUID(),
        "Interactive",
        source === root
          ? join(process.env.SystemRoot, "System32/wscript.exe")
          : join(
              process.env.SystemRoot,
              "System32/WindowsPowerShell/v1.0/powershell.exe",
            ),
        source === root
          ? `//B //Nologo "${wrapper}" "${worker}" "${request}"`
          : `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${worker}" -RequestFile "${request}"`,
      );
      const result = await waitFile(response);
      assert.equal(result.ok, true, result.error);
      assert.equal(result.handedOff, true);
      assert.ok(result.sessionId > 0);
    }
    const request = join(data, "terminal-request.json");
    const response = join(data, "terminal-response.json");
    await writeFile(
      request,
      JSON.stringify({
        nodePath: process.execPath,
        scriptPath: workerFile,
        workingDirectory: root,
        environment: { ...environment, HARNESS_CONSOLE_PHASE: "terminals" },
        responseFile: response,
      }),
    );
    await schedule(
      "Harness-Console-Check-" + randomUUID(),
      "Interactive",
      join(process.env.SystemRoot, "System32/wscript.exe"),
      `//B //Nologo "${join(root, "scripts/run-in-user-session.vbs")}" "${join(root, "scripts/run-in-user-session.ps1")}" "${request}"`,
    );
    const terminals = await waitFile(response);
    assert.equal(terminals.ok, true, terminals.error);
    const checks = await jsonFile(join(data, "terminal-checks.json"));
    assert.equal(checks.checks.length, 8);
    await delay(1000);
    await trace("Stop");
    const files = (await readdir(started.runDirectory)).filter((f) =>
      /^events(?:\.\d+)?\.jsonl$/.test(f),
    );
    const events = (
      await Promise.all(
        files.map((f) => readFile(join(started.runDirectory, f), "utf8")),
      )
    ).flatMap((text) =>
      text.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse),
    );
    const begin = events.find((e) => e.type === "started");
    assert.equal(begin.station, "WinSta0");
    assert.equal(begin.desktop, "Default");
    const displayed = events.filter(
      (e) =>
        e.type === "window" &&
        e.window.console &&
        (e.window.foreground ||
          (e.window.visible &&
            ["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS"].includes(
              e.window.className,
            ))),
    );
    const windows = [
      ...new Map(
        displayed.map((e) => [
          [e.window.handle, e.window.processId, e.window.firstSeenUtc].join(
            "/",
          ),
          {
            utc: e.utc,
            className: e.window.className,
            processId: e.window.processId,
            ancestry: e.window.ancestry.map((p) => ({
              id: p.id,
              name: p.name,
              role: p.role,
            })),
          },
        ]),
      ).values(),
    ];
    const report = {
      source,
      data,
      runDirectory: started.runDirectory,
      scheduledLaunches: 5,
      terminalChecks: checks.checks,
      displayedConsoleWindows: windows.length,
      windows,
    };
    await writeFile(join(data, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (source === root)
      assert.equal(
        windows.length,
        0,
        "A console window appeared or took focus during the acceptance check.",
      );
    else
      assert.ok(
        windows.length > 0,
        "Baseline did not reproduce a console window.",
      );
  } finally {
    for (const name of tasks)
      await powershell(
        `Stop-ScheduledTask -TaskName ${quote(name)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${quote(name)} -Confirm:$false -ErrorAction SilentlyContinue; exit 0`,
      );
    if (started) await trace("Stop");
  }
}

if (process.env.HARNESS_CONSOLE_WORKER === "1") await worker();
else await controller();
