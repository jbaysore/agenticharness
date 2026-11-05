import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RpcProcess } from "../src/core/rpc.mjs";
import { openCodex } from "../src/providers/codex.mjs";
import {
  appendStartupRecord,
  codexNativeStartup,
  CodexStartupLog,
  startupDiagnostic,
} from "../src/core/codex-startup-log.mjs";

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "harness-codex-startup-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const logPath = (dir) => join(dir, "diagnostics", "codex-startup.jsonl");
const records = async (dir) =>
  (await readFile(logPath(dir), "utf8")).trim().split("\n").map(JSON.parse);
function fixture(code, nativeLogPath, timeoutMs = 1000) {
  let rpc;
  return {
    deps: {
      resolveExecutable: () => process.execPath,
      environment: () => ({}),
      createRpc: () => (rpc = new RpcProcess(process.execPath, ["-e", code])),
      nativeLogPath,
      timeoutMs,
    },
    get rpc() {
      return rpc;
    },
  };
}
const echo = `const r=require('node:readline').createInterface({input:process.stdin});
r.on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize'){
 process.stderr.write('WARN database is locked\\nAuthor');
 setTimeout(()=>process.stderr.write('ization: Bearer fixture-secret\\n'),5);
 process.stdout.write('not-json fixture-secret\\n');
 process.stdout.write(JSON.stringify({method:'skills/changed',params:{content:'fixture-secret'}})+'\\n');
 setTimeout(()=>process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'fixture-secret'}})+'\\n'),30);
}else if(m.id){process.stderr.write('private-after-handshake\\n');process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');}});`;

test("Codex startup records milestones, timing and filtered stderr, then stops before model work", async (t) => {
  const dir = await directory(t);
  const f = fixture(echo, join(dir, "missing.sqlite"));
  const rpc = await openCodex(
    process.cwd(),
    { dataDir: dir, chatId: "fixture-chat", purpose: "chat" },
    f.deps,
  );
  try {
    await rpc.call("after", { input: "private prompt" });
    const rows = await records(dir);
    assert.deepEqual(
      new Set(rows.map((r) => r.phase)),
      new Set(["spawn", "spawned", "initialize-sent", "ready"]),
    );
    assert.equal(new Set(rows.map((r) => r.attempt)).size, 1);
    const last = rows.at(-1);
    assert.equal(last.pid, rpc.child.pid);
    assert.equal(last.chatId, "fixture-chat");
    assert.ok(last.elapsedMs >= 0);
    assert.ok(last.stdoutBytes > 0);
    assert.ok(last.stderrBytes > 0);
    assert.equal(last.protocolWarnings, 1);
    assert.equal(last.protocol[0].method, "skills/changed");
    assert.ok(last.stderr.some((r) => r.message === "WARN database is locked"));
    assert.doesNotMatch(
      JSON.stringify(rows),
      /fixture-secret|private-after-handshake|private prompt|userAgent/,
    );
    assert.equal(rpc.listenerCount("diagnostic"), 0);
    assert.equal(rpc.listenerCount("notification"), 0);
  } finally {
    rpc.close();
  }
});

test("Codex initialization timeout leaves an actionable log without retrying or submitting a prompt", async (t) => {
  const dir = await directory(t);
  const nativePath = join(dir, "native.sqlite");
  const f = fixture(
    `process.stdin.resume();process.stderr.write('WARN waiting for catalog');`,
    nativePath,
    300,
  );
  let launches = 0;
  const create = f.deps.createRpc;
  f.deps.createRpc = () => {
    launches++;
    const rpc = create();
    const db = new DatabaseSync(nativePath);
    db.exec(
      "CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,level TEXT,target TEXT,process_uuid TEXT,feedback_log_body TEXT)",
    );
    db.prepare("INSERT INTO logs VALUES (1,?,?,?,?,?)").run(
      Math.floor(Date.now() / 1000),
      "INFO",
      "codex_core::models_manager",
      `pid:${rpc.child.pid}:fixture`,
      "fetching model catalog",
    );
    db.close();
    return rpc;
  };
  await assert.rejects(
    openCodex(process.cwd(), { dataDir: dir }, f.deps),
    (error) => {
      assert.equal(error.code, "AGENT_RPC_TIMEOUT");
      assert.match(
        error.message,
        /initialize.*not retried.*Startup diagnostics:/,
      );
      assert.ok(error.message.endsWith(logPath(dir)));
      return true;
    },
  );
  assert.equal(launches, 1);
  assert.equal(f.rpc.sequence, 1);
  assert.equal(f.rpc.closed, true);
  const last = (await records(dir)).at(-1);
  assert.equal(last.phase, "failed");
  assert.equal(last.timeoutMs, 300);
  assert.equal(last.code, "AGENT_RPC_TIMEOUT");
  assert.ok(last.stderr.some((r) => r.message.includes("waiting for catalog")));
  assert.equal(last.native.status, "captured");
  assert.equal(last.native.records[0].message, "fetching model catalog");
});

test("Codex early process exit and cancellation retain their distinct outcomes", async (t) => {
  const dir = await directory(t);
  const f = fixture(
    "process.stderr.write('ERROR startup failed\\n',()=>process.exit(7));",
    join(dir, "missing.sqlite"),
  );
  await assert.rejects(
    openCodex(process.cwd(), { dataDir: dir }, f.deps),
    /Agent exited \(7\).*Startup diagnostics:/,
  );
  assert.equal((await records(dir)).at(-1).exit.code, 7);
  const abort = new AbortController();
  const hanging = fixture(
    "process.stdin.resume()",
    join(dir, "missing.sqlite"),
  );
  const opening = openCodex(
    process.cwd(),
    { dataDir: dir, signal: abort.signal },
    hanging.deps,
  );
  abort.abort();
  await assert.rejects(opening, /connection closed/);
  assert.equal((await records(dir)).at(-1).phase, "cancelled");
  assert.equal(hanging.rpc.closed, true);
});

test("unwritable startup logging does not prevent a successful connection", async (t) => {
  const dir = await directory(t);
  const blocked = join(dir, "file");
  await writeFile(blocked, "fixture");
  const f = fixture(echo, join(dir, "missing.sqlite"));
  const warnings = [];
  t.mock.method(console, "error", (...args) => warnings.push(args));
  const rpc = await openCodex(process.cwd(), { dataDir: blocked }, f.deps);
  rpc.close();
  assert.ok(warnings.length);
  assert.match(warnings[0][0], /diagnostics could not be saved/);
});

test("startup diagnostics omit credentials, HTTP headers, payloads and overlong lines", () => {
  for (const line of [
    "Authorization: Bearer fixture-secret",
    '{"access_token":"fixture-secret"}',
    String.raw`{\\"access_token\\":\\"fixture-secret\\"}`,
    String.raw`headers={\\"set-cookie\\":\\"fixture-secret\\"}`,
    "set-cookie: fixture-secret",
    "password=fixture-secret",
    "api_key=fixture-secret",
    "account_id=fixture-secret",
    'payload={"content":"fixture-secret"}',
    'GET models status=200 OK headers={"set-cookie":"fixture-secret"}',
    "connect https://example.invalid/models?token=fixture-secret",
    "Bearer fixture-secret",
    "sk-fixture-secret",
    "mail fixture-secret@example.invalid",
  ])
    assert.doesNotMatch(startupDiagnostic(line), /fixture-secret/);
  assert.equal(
    startupDiagnostic("x".repeat(20_000)),
    "[overlong diagnostic omitted]",
  );
  assert.equal(
    startupDiagnostic("\x1b[31mERROR database is locked\x1b[0m"),
    "ERROR database is locked",
  );
});

test("stderr buffering and protocol history are bounded even for fragmented lines", async (t) => {
  const dir = await directory(t);
  const log = new CodexStartupLog({ dataDir: dir });
  log.takeStderr("Authorization: Bear");
  log.takeStderr("er fixture-secret\n" + "x".repeat(17_000));
  log.takeStderr(
    "fixture-secret\n" +
      Array.from({ length: 80 }, (_, i) => `WARN line ${i}\n`).join(""),
  );
  assert.ok(log.stderr.length <= 32);
  assert.ok(log.stderrBuffer.length <= 16_384);
  await log.finish("ready");
  const last = (await records(dir)).at(-1);
  assert.equal(last.stderr.length, 32);
  assert.equal(last.overlongLines, 1);
  assert.doesNotMatch(JSON.stringify(last), /fixture-secret/);
});

test("native startup snapshot keeps only this PID and time window, sanitizes headers, and limits history", async (t) => {
  const dir = await directory(t),
    path = join(dir, "native.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,level TEXT,target TEXT,process_uuid TEXT,feedback_log_body TEXT)",
  );
  const insert = db.prepare(
    "INSERT INTO logs(ts,level,target,process_uuid,feedback_log_body) VALUES (?,?,?,?,?)",
  );
  for (let i = 0; i < 45; i++)
    insert.run(
      1000,
      "INFO",
      "codex_http_client",
      "pid:123:fixture",
      `catalog ${i} status=200 headers={cookie:fixture-secret}`,
    );
  insert.run(
    1000,
    "ERROR",
    "other",
    "pid:456:fixture",
    "other-session-private",
  );
  insert.run(900, "ERROR", "old", "pid:123:fixture", "outside-window-private");
  db.close();
  const snapshot = codexNativeStartup(path, 123, 1_000_000, 1_001_000);
  assert.equal(snapshot.status, "captured");
  assert.equal(snapshot.records.length, 40);
  assert.match(snapshot.records[0].message, /catalog 5 status=200/);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /fixture-secret|other-session-private|outside-window-private/,
  );
  assert.equal(
    codexNativeStartup(join(dir, "missing.sqlite"), 123, 0, 1).status,
    "unavailable",
  );
});

test("concurrent writes rotate bounded JSONL files without losing or mixing records", async (t) => {
  const dir = await directory(t),
    path = join(dir, "startup.jsonl");
  await Promise.all(
    Array.from({ length: 20 }, (_, n) =>
      appendStartupRecord(path, { n }, { maxBytes: 50 }),
    ),
  );
  const names = await readdir(dir);
  assert.equal(names.length, 4);
  const rows = [];
  for (const name of [
    "startup.jsonl.3",
    "startup.jsonl.2",
    "startup.jsonl.1",
    "startup.jsonl",
  ]) {
    const text = await readFile(join(dir, name), "utf8");
    assert.ok(Buffer.byteLength(text) <= 50);
    rows.push(...text.trim().split("\n").map(JSON.parse));
  }
  assert.equal(rows.at(-1).n, 19);
  assert.equal(new Set(rows.map((r) => r.n)).size, rows.length);
  assert.deepEqual(
    rows.map((r) => r.n),
    rows.map((r) => r.n).toSorted((a, b) => a - b),
  );
});
