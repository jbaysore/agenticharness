import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as tick } from "node:timers/promises";
import { Store } from "../src/core/store.mjs";
import { createHarness } from "../src/server.mjs";
import {
  appendDiagnosticRecord,
  waitForDiagnostics,
} from "../src/core/diagnostic-writes.mjs";
import {
  PerformanceDiagnostics,
  timingRoute,
} from "../src/core/performance.mjs";
import { runCodex } from "../src/providers/codex.mjs";

test("saved steps use run and type lookups to skip older chat history", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const project = store.addProject("Fixture", process.cwd());
  const chat = store.createConversation({ projectId: project.id });
  const other = store.createConversation({ projectId: project.id });
  const createRun = (actionId) =>
    store.createRun({
      conversationId: chat.id,
      actionId,
      provider: "codex",
      model: "fixture",
      text: "Inspect",
    });
  const oldest = createRun("oldest");
  store.setRun(oldest.id, "completed");
  store.db
    .prepare("UPDATE runs SET created_at=? WHERE id=?")
    .run("2020-01-01T00:00:00.000Z", oldest.id);
  for (let n = 0; n < 29; n++)
    store.setRun(createRun(`newer-${n}`).id, "completed");
  const run = createRun("steps");
  store.appendEvent(chat.id, run.id, "text", {
    messageId: "reply",
    delta: "Inspecting",
  });
  store.appendEvent(chat.id, run.id, "text", {
    messageId: "follow-up",
    delta: "Reporting",
  });
  store.appendEvent(chat.id, run.id, "text", {
    messageId: "reply",
    delta: "Older reply update",
  });
  const command = {
    kind: "host-command",
    id: "command",
    command: "node --version",
    status: "ok",
  };
  store.appendEvent(chat.id, run.id, "work", command);
  assert.equal(store.steps(chat.id)[run.id][0].after, "follow-up");
  const expected = store.steps(chat.id);
  store.appendEvent(chat.id, oldest.id, "work", command);
  store.appendEvent(other.id, run.id, "work", { ...command, id: "wrong-chat" });
  store.db.exec("BEGIN");
  const insert = store.db.prepare(
    "INSERT INTO events(conversation_id,run_id,type,payload,created_at) VALUES(?,?,'work',?,?)",
  );
  for (let n = 0; n < 30_000; n++)
    insert.run(
      chat.id,
      oldest.id,
      '{"kind":"command-output","delta":"older output"}',
      store.now(),
    );
  store.db.exec("COMMIT");
  const prepare = store.db.prepare;
  let query, controlQuery;
  t.mock.method(store.db, "prepare", function (sql) {
    if (sql.includes("SELECT e.id, e.run_id")) query = sql;
    if (sql.includes("SELECT payload FROM events WHERE run_id=?"))
      controlQuery = sql;
    return prepare.call(this, sql);
  });
  assert.deepEqual(store.steps(chat.id), expected);
  const plan = prepare
    .call(store.db, "EXPLAIN QUERY PLAN " + query)
    .all(chat.id, chat.id, chat.id);
  assert.equal(
    plan.filter((row) =>
      row.detail.includes("SEARCH e USING INDEX events_run_type_time (run_id=? AND type=?)"),
    ).length,
    2,
  );
  store.runProgress(run.id);
  const controlPlan = prepare
    .call(store.db, "EXPLAIN QUERY PLAN " + controlQuery)
    .all(run.id, "cancellation");
  assert.ok(
    controlPlan.some((row) =>
      /USING INDEX events_run_control/.test(row.detail),
    ),
  );
});

test(
  "Codex preflight reads run concurrently and all checks finish before a turn is submitted",
  { timeout: 3000 },
  async () => {
    const gates = Object.fromEntries(
      ["account/read", "account/rateLimits/read", "config/read"].map((name) => [
        name,
        Promise.withResolvers(),
      ]),
    );
    const rpc = new EventEmitter(),
      calls = [];
    rpc.close = () => {
      rpc.closed = true;
    };
    rpc.call = async (method) => {
      calls.push(method);
      if (gates[method]) return gates[method].promise;
      if (method === "thread/start")
        return { thread: { id: "fixture-thread" } };
      if (method === "turn/start") {
        setImmediate(() =>
          rpc.emit("notification", {
            method: "turn/completed",
            params: {
              threadId: "fixture-thread",
              turn: { id: "fixture-turn", status: "completed" },
            },
          }),
        );
        return { turn: { id: "fixture-turn" } };
      }
      assert.fail("Unexpected RPC: " + method);
    };
    const running = runCodex(
      {
        project: { path: process.cwd() },
        mode: "default",
        model: "fixture",
        text: "Hi",
        signal: new AbortController().signal,
        emit() {},
        saveSession() {},
      },
      { open: async () => rpc },
    );
    await tick();
    assert.deepEqual(calls, Object.keys(gates));
    gates["account/read"].resolve({
      account: { type: "chatgpt", planType: "pro" },
    });
    await tick();
    assert.ok(!calls.includes("turn/start"));
    gates["account/rateLimits/read"].resolve({
      ordinaryUsageAllowed: true,
      rateLimits: {
        primary: { usedPercent: 1 },
        credits: { hasCredits: false, unlimited: false, balance: "0" },
      },
    });
    gates["config/read"].resolve({ config: { model_provider: "openai" } });
    assert.equal((await running).status, "completed");
    assert.equal(calls.filter((method) => method === "turn/start").length, 1);
  },
);

test("status polling is authenticated, small, and never rebuilds a transcript", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harness-status-"));
  const app = await createHarness({
    dataDir: dir,
    port: 0,
    startProviders: false,
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const project = app.store.addProject("Fixture", dir);
  const chat = app.store.createConversation({
    projectId: project.id,
    mode: "goal",
  });
  const run = app.store.createRun({
    conversationId: chat.id,
    actionId: "status",
    provider: "codex",
    model: "fixture",
    text: "Work",
  });
  app.store.appendEvent(chat.id, run.id, "work", {
    kind: "cancellation",
    state: "requested",
  });
  for (const method of ["messages", "steps", "conversationSnapshot"])
    t.mock.method(app.store, method, () => {
      throw new Error("Heavy read: " + method);
    });
  const url = app.runtime.origin + `/api/chats/${chat.id}/status`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("server-timing"), /^harness;dur=/);
  const status = await response.json();
  assert.equal(status.id, chat.id);
  assert.equal(status.activeRun.id, run.id);
  assert.equal(status.pause.state, "requested");
  assert.equal(status.lastEventId, app.store.latestEventId());
  assert.equal(status.messages, undefined);
  assert.ok(JSON.stringify(status).length < 2000);
  app.store.setRun(run.id, "cancelled");
  app.store.appendEvent(chat.id, run.id, "work", {
    kind: "cancellation",
    state: "confirmed",
  });
  const stopped = await (await fetch(url)).json();
  assert.ok(!stopped.activeRun);
  assert.equal(stopped.pause.state, "confirmed");
  assert.equal(
    (await fetch(url, { headers: { "Cf-Connecting-IP": "203.0.113.9" } }))
      .status,
    401,
  );
  assert.equal(
    (await fetch(url, { headers: { Origin: "https://evil.example" } })).status,
    403,
  );
  assert.equal(
    (await fetch(app.runtime.origin + "/api/chats/missing/status")).status,
    404,
  );
});

test("diagnostic queues shed excess records and recover after a stalled disk", async () => {
  const gate = Promise.withResolvers(),
    saved = [];
  const io = {
    mkdir: () => gate.promise,
    stat: async () => ({ size: 0 }),
    appendFile: async (_path, line) => saved.push(JSON.parse(line)),
  };
  const write = (n) =>
    appendDiagnosticRecord("fixture-bounded", { n }, { io, maxPending: 2 });
  const first = write(1),
    second = write(2);
  assert.equal(await write(3), false);
  assert.equal(await waitForDiagnostics(first, 5), false);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(await write(4), true);
  assert.deepEqual(
    saved.map((row) => row.n),
    [1, 2, 4],
  );
});

test("performance diagnostics record bounded metadata and separate HTTP from event-loop delay", async () => {
  const rows = [];
  let clock = 0;
  const histogram = { enable() {}, disable() {}, reset() {}, count: 0 };
  const diagnostics = new PerformanceDiagnostics("fixture", {
    write: async (_path, row) => rows.push(row),
    now: () => clock,
    histogram,
  });
  try {
    const done = diagnostics.start("thread-setup", {
      chatId: "chat",
      runId: "run",
      provider: "codex",
      prompt: "private",
      token: "private",
    });
    clock = 45;
    done();
    done("failed");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].elapsedMs, 45);
    assert.equal(rows[0].prompt, undefined);
    assert.equal(rows[0].token, undefined);
    const res = new EventEmitter();
    res.setHeader = (key, value) => {
      res[key] = value;
    };
    res.writeHead = (status) => {
      res.statusCode = status;
    };
    diagnostics.request(
      { url: "/api/chats/private-id/status?token=private", method: "GET" },
      res,
    );
    clock = 345;
    res.writeHead(200);
    res.emit("finish");
    assert.equal(res["Server-Timing"], "harness;dur=300.0");
    assert.equal(rows.at(-1).route, "/api/chats/:id/status");
    assert.doesNotMatch(JSON.stringify(rows), /private/);
    assert.equal(timingRoute("/api/file/private-name"), "/api/other");
    await assert.rejects(
      diagnostics.measure("context-preparation", () =>
        Promise.reject(new Error("fixture")),
      ),
      /fixture/,
    );
    assert.equal(rows.at(-1).outcome, "failed");
  } finally {
    diagnostics.close();
  }
});
