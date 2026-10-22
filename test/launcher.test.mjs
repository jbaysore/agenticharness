import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";

const exec = promisify(execFile);
async function fixture(port = 0) {
  const root = await mkdtemp(join(tmpdir(), "harness-launcher-"));
  const data = join(root, "data");
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "src", "core"));
  await copyFile(
    new URL("../src/core/restart-state.mjs", import.meta.url),
    join(root, "src", "core", "restart-state.mjs"),
  );
  await mkdir(data);
  await copyFile(
    new URL("../scripts/launch.mjs", import.meta.url),
    join(root, "scripts", "launch.mjs"),
  );
  const server = pathToFileURL(
    fileURLToPath(new URL("../src/server.mjs", import.meta.url)),
  ).href;
  await writeFile(
    join(root, "src", "server.mjs"),
    `import { createHarness } from ${JSON.stringify(server)};\nawait createHarness({ startProviders: false });\n`,
  );
  const launch = (...args) =>
    exec(
      process.execPath,
      [join(root, "scripts", "launch.mjs"), "--no-browser", ...args],
      {
        env: {
          ...process.env,
          HARNESS_DATA_DIR: data,
          HARNESS_PORT: String(port),
        },
        windowsHide: true,
        timeout: 8000,
      },
    );
  return {
    data,
    root,
    launch,
    async close() {
      await launch("--stop");
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
      // Windows can briefly retain the fixture host's working-directory handle
      // after shutdown has acknowledged and its launcher has exited.
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    },
  };
}

test("launcher starts an isolated host and reuses its saved runtime", async () => {
  const app = await fixture();
  try {
    assert.match((await app.launch()).stdout, /Harness host ready/);
    const first = JSON.parse(
      await readFile(join(app.data, "runtime.json"), "utf8"),
    );
    // A healthy host must be reused even if a fresh desktop handoff would fail.
    await writeFile(
      join(app.root, "scripts", "run-in-user-session.ps1"),
      `@{ ok = $false; error = 'fixture session unavailable' } | ConvertTo-Json -Compress`,
    );
    assert.match((await app.launch()).stdout, /Harness host ready/);
    const second = JSON.parse(
      await readFile(join(app.data, "runtime.json"), "utf8"),
    );
    assert.equal(second.instanceId, first.instanceId);
    const health = await fetch(first.origin + "/health").then((r) => r.json());
    assert.equal(health.instanceId, first.instanceId);
  } finally {
    await app.close();
  }
});

test(
  "a failed Windows desktop handoff is reported without starting a service-session host",
  { skip: process.platform !== "win32" },
  async () => {
    const app = await fixture();
    try {
      await writeFile(
        join(app.root, "scripts", "run-in-user-session.ps1"),
        `@{ ok = $false; error = 'fixture session unavailable' } | ConvertTo-Json -Compress`,
      );
      await assert.rejects(app.launch(), /fixture session unavailable/);
      await assert.rejects(readFile(join(app.data, "runtime.json"), "utf8"));
    } finally {
      await app.close();
    }
  },
);

test("supervise keeps the launcher alive until the host stops", async () => {
  const app = await fixture();
  let output = "";
  const child = spawn(
    process.execPath,
    [join(app.root, "scripts", "launch.mjs"), "--supervise"],
    {
      env: {
        ...process.env,
        HARNESS_DATA_DIR: app.data,
        HARNESS_PORT: "0",
      },
      windowsHide: true,
    },
  );
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  try {
    const readyAt = Date.now() + 8000;
    while (!output.includes("Harness host ready") && Date.now() < readyAt) {
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(output, /Harness host ready/);
    assert.equal(child.exitCode, null);
    await app.launch("--stop");
    const exited = await new Promise((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.once("exit", resolve);
      setTimeout(() => resolve("timeout"), 8000);
    });
    assert.equal(exited, 0);
    assert.match(output, /Harness host stopped/);
  } finally {
    child.kill();
    await app.close();
  }
});

test("missing runtime plus an occupied port reports the fresh host error without waiting for the startup deadline", async () => {
  const occupied = createServer((req, res) => res.end("occupied"));
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const app = await fixture(occupied.address().port);
  try {
    await writeFile(
      join(app.data, "host-errors.log"),
      "Error: stale failure from a previous launch\n",
    );
    await assert.rejects(app.launch(), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /host exited during startup \(code 1\)/);
      assert.match(error.stderr, /EADDRINUSE/);
      assert.doesNotMatch(error.stderr, /stale failure|startup deadline/);
      return true;
    });
    const log = await readFile(join(app.data, "launcher-errors.log"), "utf8");
    assert.match(log, /EADDRINUSE/);
    assert.equal(
      (await fetch(`http://127.0.0.1:${occupied.address().port}`)).status,
      200,
    );
  } finally {
    await app.close();
    await new Promise((resolve) => occupied.close(resolve));
  }
});
