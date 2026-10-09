import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { runCommand } from "../src/core/commands.mjs";

const cwd = tmpdir();

test("a command's output and exit code come back, in the folder it was given", async () => {
  const result = await runCommand({
    command: `node -e "console.log(process.cwd()); console.error('to stderr'); process.exit(3)"`,
    cwd,
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.match(result.output, /to stderr/);
  assert.ok(
    result.output.toLowerCase().includes(cwd.toLowerCase().slice(0, 12)),
    result.output,
  );
});

test("long output keeps its beginning and end, and says what was left out", async () => {
  const result = await runCommand({
    command: `node -e "console.log('START'); for (let i = 0; i < 4000; i++) console.log('filler line ' + i); console.log('END')"`,
    cwd,
    limit: 2000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.match(result.output, /^START/);
  assert.match(result.output, /END\s*$/);
  assert.match(result.output, /\[\.\.\. [\d,]+ characters left out \.\.\.\]/);
  assert.ok(result.output.length < 2200);
});

test("a command is stopped when its time is up or the turn is stopped", async () => {
  const slow = `node -e "setTimeout(() => {}, 60000)"`,
    started = Date.now();
  const late = await runCommand({ command: slow, cwd, timeoutMs: 400 });
  assert.equal(late.timedOut, true);
  assert.ok(Date.now() - started < 20_000);
  const abort = new AbortController(),
    pending = runCommand({ command: slow, cwd, signal: abort.signal });
  setTimeout(() => abort.abort(), 300);
  await assert.rejects(pending, /stopped/);
});
