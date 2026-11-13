import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCommandResult, readProgress } from "../src/core/command-watch.mjs";
import {
  identitiesMatch,
  killIfMatched,
  processIdentity,
} from "../src/core/process-identity.mjs";

test("process identity matches this process and a reused id is not killed", async () => {
  const self = await processIdentity(process.pid);
  assert.ok(self?.createdAt);
  assert.equal(identitiesMatch(self, self), true);
  const shifted = {
    pid: self.pid,
    createdAt: new Date(Date.parse(self.createdAt) + 5000).toISOString(),
  };
  assert.equal(identitiesMatch(self, shifted), false);
  const kills = [];
  const outcome = await killIfMatched(self, {
    identity: async () => shifted,
    kill: async (pid) => kills.push(pid),
  });
  assert.equal(outcome.killed, false);
  assert.deepEqual(kills, []);
});

const until = async (read, accept, timeout = 12_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Timed out waiting for the test command runner");
};
async function runnerFixture(script, { missingCwd = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "harness-runner-test-"));
  // Encode the fixture script as data rather than interpolate JS into a shell.
  const command = `"${process.execPath}" -e "eval(Buffer.from('${Buffer.from(script).toString("base64")}','base64').toString())"`;
  await writeFile(
    join(dir, "request.json"),
    JSON.stringify({
      command,
      shell: process.platform === "win32" ? "cmd" : "bash",
      cwd: missingCwd ? join(dir, "missing") : dir,
    }),
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../src/core/command-watch-runner.mjs", import.meta.url),
      ),
      dir,
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  const exited = once(child, "exit");
  return {
    dir,
    watch: { statusDir: dir },
    async close() {
      if (child.exitCode === null) child.kill();
      await exited;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("the real runner publishes bounded output before exit and preserves the final code and capture", async () => {
  const f = await runnerFixture(
    "process.stdout.write('HEAD'+'x'.repeat(250000)+'TAIL');setTimeout(()=>{process.stderr.write('END');process.exit(7)},3500)",
  );
  try {
    const live = await until(
      () => readCommandResult(f.watch),
      (r) => !r.done && r.output?.endsWith("TAIL"),
    );
    assert.ok(live.output.length <= 8000);
    assert.ok(
      live.output.endsWith("TAIL"),
      JSON.stringify({ end: live.output.slice(-120), bytes: live.outputBytes }),
    );
    assert.ok(live.lastOutputAt <= live.heartbeatAt);
    const result = await until(
      () => readCommandResult(f.watch),
      (r) => r.done,
    );
    assert.equal(result.exitCode, 7);
    assert.ok(result.output.startsWith("HEAD"));
    assert.ok(result.output.endsWith("END"));
    assert.ok(result.output.length < 201000);
  } finally {
    await f.close();
  }
});

test("a shell spawn failure produces a durable failed result", async () => {
  const f = await runnerFixture("process.exit(0)", { missingCwd: true });
  try {
    const result = await until(
      () => readCommandResult(f.watch),
      (r) => r.done,
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /ENOENT/);
  } finally {
    await f.close();
  }
});

test("a shell exit is reported even while a descendant holds inherited output pipes", async () => {
  const marker = `descendant-${Date.now()}.done`;
  const descendant = `setTimeout(()=>{require('node:fs').writeFileSync('${marker}','done');process.exit(0)},6000)`;
  const script = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit',windowsHide:true,detached:true});child.on('spawn',()=>setTimeout(()=>process.exit(0),100))`;
  const f = await runnerFixture(script);
  try {
    const result = await until(
      () => readCommandResult(f.watch),
      (r) => r.done,
    );
    assert.equal(result.exitCode, 0);
    await assert.rejects(readFile(join(f.dir, marker)), { code: "ENOENT" });
  } finally {
    // The descendant has a fixed six-second lifetime; observe its completion
    // before removing its directory or ending this test.
    try {
      await until(
        () => readFile(join(f.dir, marker)).catch(() => null),
        Boolean,
      );
    } finally {
      await f.close();
    }
  }
});

test("legacy heartbeat records remain readable and corrupt final results are surfaced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-legacy-runner-"));
  try {
    await writeFile(join(dir, "heartbeat.json"), JSON.stringify({ at: 1234 }));
    assert.equal((await readProgress({ statusDir: dir })).heartbeatAt, 1234);
    await writeFile(join(dir, "result.json"), "{broken");
    await assert.rejects(readCommandResult({ statusDir: dir }), SyntaxError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
