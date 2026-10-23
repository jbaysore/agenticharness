import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { runCommand } from "../src/core/commands.mjs";
import { commandShell } from "../src/core/command-shells.mjs";

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

test(
  "Windows PowerShell receives multiline quoting, variables and Unicode intact",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await runCommand({
      cwd,
      shell: "powershell",
      command:
        "$text = @'\n$variable `literal` \"quoted\" café 😀\n'@\nWrite-Output $text",
    });
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /\$variable `literal` "quoted" café 😀/);
  },
);

test(
  "Node package commands run without the blocked PowerShell wrapper",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await runCommand({
      cwd,
      shell: "powershell",
      command: "npm --version",
    });
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /\d+\.\d+\.\d+/);
  },
);

test(
  "a PowerShell error after a successful native command still fails",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await runCommand({
      cwd,
      shell: "powershell",
      command: 'node -e "process.exit(0)"\nWrite-Error "expected diagnostic"',
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /expected diagnostic/);
  },
);

test(
  "cmd supports explicit && chains and keeps their failure exit codes",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await runCommand({
      cwd,
      shell: "cmd",
      command:
        'node -e "console.log(123)" && node -e "process.exit(7)" && echo MUST_NOT_RUN',
    });
    assert.match(result.output, /123/);
    assert.doesNotMatch(result.output, /MUST_NOT_RUN/);
    assert.equal(result.exitCode, 7);
    const quoted = await runCommand({
      cwd,
      shell: "cmd",
      command: `"${process.execPath}" -e "console.log('quoted executable')"`,
    });
    assert.equal(quoted.exitCode, 0, quoted.output);
    assert.match(quoted.output, /quoted executable/);
  },
);

test("Bash heredocs use an explicit Bash shell", async (t) => {
  try {
    commandShell("bash");
  } catch {
    return t.skip("Bash is not installed");
  }
  const result = await runCommand({
    cwd,
    shell: "bash",
    command:
      "node <<'NODE'\nconsole.log('literal $value and \"quotes\"');\nNODE",
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /literal \$value and "quotes"/);
});

test("an already stopped command never starts", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    runCommand({ command: "echo MUST_NOT_RUN", cwd, signal: abort.signal }),
    /stopped/,
  );
});
