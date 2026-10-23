import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

test(
  "boot supervisor retries failed and stopped launchers with the selected data folder",
  { skip: process.platform !== "win32", timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "harness startup "));
    const data = join(root, "app data");
    await mkdir(join(root, "scripts"));
    await mkdir(data);
    await writeFile(
      join(root, "scripts", "launch.mjs"),
      `import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const file = join(process.env.HARNESS_DATA_DIR, 'attempts.jsonl');
let previous = '';
try { previous = readFileSync(file, 'utf8'); } catch {}
appendFileSync(file, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  data: process.env.HARNESS_DATA_DIR,
  restart: process.env.HARNESS_RESTART_REQUEST ?? ''
}) + '\\n');
// A missing desktop first, then a stopped host. Both must be retried.
if (!previous) { console.error('fixture desktop unavailable'); process.exit(1); }
console.log('fixture host stopped');
`,
    );
    const script = fileURLToPath(
      new URL("../scripts/service-start.ps1", import.meta.url),
    );
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Root",
        root,
        "-NodePath",
        process.execPath,
        "-DataDir",
        data,
        "-RetrySeconds",
        "1",
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          HARNESS_DATA_DIR: join(root, "wrong data"),
          HARNESS_RESTART_REQUEST: "stale-request",
        },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exited = new Promise((done, reject) => {
      child.once("exit", done);
      child.once("error", reject);
    });
    try {
      const deadline = Date.now() + 10000;
      let attempts = [];
      while (Date.now() < deadline) {
        attempts = await readFile(join(data, "attempts.jsonl"), "utf8")
          .then((text) => text.trim().split("\n").map(JSON.parse))
          .catch(() => []);
        if (attempts.length >= 3) break;
        assert.equal(child.exitCode, null, output);
        await new Promise((done) => setTimeout(done, 100));
      }
      assert.ok(attempts.length >= 3, output);
      for (const attempt of attempts) {
        assert.deepEqual(attempt.args, ["--supervise"]);
        assert.equal(attempt.cwd, root);
        assert.equal(attempt.data, data);
        assert.equal(attempt.restart, "");
      }
      const log = await readFile(join(data, "startup.log"), "utf8");
      assert.match(log, /fixture desktop unavailable/);
      assert.match(log, /exited \(1\); retrying/);
      assert.match(log, /fixture host stopped/);
      assert.match(log, /exited \(0\); retrying/);
    } finally {
      child.kill();
      await exited;
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);
