import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { patchNodePty } from "../scripts/patch-node-pty.mjs";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const dependency = dirname(require.resolve("node-pty/package.json"));

test("the installed terminal cleanup helper is hidden, and the check never rewrites it", async () => {
  const file = join(dependency, "lib", "windowsPtyAgent.js");
  const before = await readFile(file, "utf8");
  await patchNodePty(dependency, { check: true });
  assert.equal(await readFile(file, "utf8"), before);
});

test("the dependency patch survives reinstalls and refuses unexpected helper changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-pty-patch-"));
  try {
    await mkdir(join(dir, "lib"));
    const file = join(dir, "lib", "windowsPtyAgent.js");
    const installed = await readFile(
      join(dependency, "lib", "windowsPtyAgent.js"),
      "utf8",
    );
    const pristine = installed.replace(
      "[_this._innerPid.toString()], { windowsHide: true });",
      "[_this._innerPid.toString()]);",
    );
    assert.notEqual(pristine, installed);
    await writeFile(join(dir, "package.json"), '{"version":"1.1.0"}');
    await writeFile(file, pristine);
    await assert.rejects(patchNodePty(dir, { check: true }), /Run npm ci/);
    assert.equal(await readFile(file, "utf8"), pristine);
    await patchNodePty(dir);
    assert.equal(await readFile(file, "utf8"), installed);
    await patchNodePty(dir);
    assert.equal(await readFile(file, "utf8"), installed);
    await writeFile(file, "an upstream helper changed");
    await assert.rejects(patchNodePty(dir), /helper changed/);
    assert.equal(await readFile(file, "utf8"), "an upstream helper changed");
    await writeFile(join(dir, "package.json"), '{"version":"1.2.0"}');
    await assert.rejects(patchNodePty(dir), /before using node-pty 1.2.0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function desktopFixture(t) {
  const { stdout } = await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Diagnostics.Process]::GetCurrentProcess().SessionId",
    ],
    { windowsHide: true },
  );
  if (Number(stdout.trim()) === 0) {
    t.skip("The hidden desktop worker requires a signed-in Windows session.");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "harness hidden ü & "));
  t.after(() =>
    rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const script = join(dir, "a script ü.mjs");
  const response = join(dir, "response.json");
  const request = join(dir, "request.json");
  const wrapper = fileURLToPath(
    new URL("../scripts/run-in-user-session.vbs", import.meta.url),
  );
  const worker = fileURLToPath(
    new URL("../scripts/run-in-user-session.ps1", import.meta.url),
  );
  return {
    dir,
    script,
    async run(code, nodePath = process.execPath) {
      await writeFile(script, code);
      await writeFile(
        request,
        JSON.stringify({
          nodePath,
          scriptPath: script,
          workingDirectory: dir,
          environment: { HARNESS_TEST_HIDDEN: "forwarded ü value" },
          responseFile: response,
        }),
      );
      await exec("wscript.exe", ["//B", "//Nologo", wrapper, worker, request], {
        windowsHide: true,
        timeout: 35000,
      });
      return JSON.parse(
        (await readFile(response, "utf8")).replace(/^\uFEFF/, ""),
      );
    },
  };
}

test(
  "hidden desktop launch forwards paths, environment and args while draining both output streams",
  {
    skip: process.platform !== "win32",
    timeout: 45000,
  },
  async (t) => {
    const f = await desktopFixture(t);
    if (!f) return;
    const result = await f.run(`
import { writeFileSync } from 'node:fs';
writeFileSync('received.json', JSON.stringify({ cwd:process.cwd(), args:process.argv.slice(2), value:process.env.HARNESS_TEST_HIDDEN }));
process.stdout.write('out'.repeat(100000));
process.stderr.write('err'.repeat(100000));
`);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.handedOff, true);
    assert.ok(result.sessionId > 0);
    assert.deepEqual(
      JSON.parse(await readFile(join(f.dir, "received.json"), "utf8")),
      {
        cwd: f.dir,
        args: ["--no-browser"],
        value: "forwarded ü value",
      },
    );
  },
);

test(
  "hidden desktop launch reports child exit codes and Unicode stderr",
  {
    skip: process.platform !== "win32",
    timeout: 45000,
  },
  async (t) => {
    const f = await desktopFixture(t);
    if (!f) return;
    const result = await f.run(
      "console.log('output ü'); console.error('ошибка'); process.exitCode = 7;",
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /exited \(7\)/);
    assert.match(result.error, /output ü/);
    assert.match(result.error, /ошибка/);
  },
);

test(
  "hidden desktop launch reports a missing runtime",
  {
    skip: process.platform !== "win32",
    timeout: 45000,
  },
  async (t) => {
    const f = await desktopFixture(t);
    if (!f) return;
    const result = await f.run("", join(f.dir, "missing node.exe"));
    assert.equal(result.ok, false);
    assert.ok(result.error);
  },
);

test(
  "hidden desktop launch bounds a stalled child and stops only that child",
  {
    skip: process.platform !== "win32",
    timeout: 45000,
  },
  async (t) => {
    const f = await desktopFixture(t);
    if (!f) return;
    const result = await f.run(
      "import { writeFileSync } from 'node:fs'; writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000);",
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /25-second startup limit/);
    const pid = Number(await readFile(join(f.dir, "child.pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);
