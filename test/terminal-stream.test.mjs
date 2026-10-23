import test from "node:test";
import assert from "node:assert/strict";
import { once, on } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import WebSocket from "ws";
import { createHarness } from "../src/server.mjs";
import {
  connectTerminal,
  terminalInputChunks,
} from "../src/ui/terminal-stream.mjs";

test("large terminal pastes preserve text and Unicode within each host input limit", () => {
  const text = "a".repeat(9999) + "😀\r\n" + "b".repeat(20001),
    chunks = [...terminalInputChunks(text)];
  assert.equal(chunks.join(""), text);
  assert.ok(
    chunks.every((s) => s.length <= 10000 && !/[\uD800-\uDBFF]$/.test(s)),
  );
  assert.deepEqual([...terminalInputChunks("")], []);
});

test("the terminal client sends immediately in order and reconnects without replaying disconnected input", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalSocket = globalThis.WebSocket,
    originalLocation = globalThis.location,
    sockets = [],
    errors = [],
    messages = [];
  let reconnects = 0;
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    sent = [];
    constructor(url) {
      this.url = String(url);
      sockets.push(this);
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    open() {
      this.readyState = 1;
      this.onopen();
    }
    close(code = 1000) {
      this.readyState = 3;
      this.onclose({ code });
    }
  }
  globalThis.WebSocket = Socket;
  globalThis.location = { href: "https://harness.example/" };
  let connection;
  try {
    connection = connectTerminal("fixture", {
      report: (error) => errors.push(error),
      onMessage: (message) => messages.push(message),
      onReconnect: () => reconnects++,
    });
    connection.input("before open");
    assert.equal(
      sockets[0].url,
      "wss://harness.example/api/terminals/fixture/stream",
    );
    sockets[0].open();
    connection.input("a");
    connection.input("b");
    assert.deepEqual(
      sockets[0].sent.map((m) => m.data),
      ["before open", "a", "b"],
    );
    sockets[0].onmessage({
      data: JSON.stringify({ type: "output", data: "ab" }),
    });
    assert.deepEqual(messages, [{ type: "output", data: "ab" }]);
    sockets[0].close(1006);
    connection.input("must not replay\r");
    assert.equal(errors.length, 1);
    t.mock.timers.tick(250);
    sockets[1].open();
    assert.deepEqual(sockets[1].sent, []);
    connection.input("new input");
    assert.deepEqual(
      sockets[1].sent.map((m) => m.data),
      ["new input"],
    );
    assert.equal(reconnects, 1);
    connection.dispose();
    t.mock.timers.tick(5000);
    connection.input("disposed");
    assert.equal(sockets.length, 2);
    assert.equal(sockets[1].sent.length, 1);
  } finally {
    connection?.dispose();
    globalThis.WebSocket = originalSocket;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

test("terminal streams preserve ordered input, replay and live output without per-key HTTP or event writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-terminal-stream-")),
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false }),
    writes = [],
    sizes = [],
    id = "terminal-stream-fixture";
  app.terminals.sessions.set(id, {
    id,
    status: "running",
    output: "saved output\r\n",
    process: {
      write: (text) => writes.push(text),
      resize: (...size) => sizes.push(size),
      kill() {},
    },
  });
  const url =
    app.runtime.origin.replace("http:", "ws:") + `/api/terminals/${id}/stream`;
  let ws;
  try {
    ws = new WebSocket(url, { headers: { Origin: app.runtime.origin } });
    const messages = on(ws, "message");
    await once(ws, "open");
    const read = async () =>
      JSON.parse((await messages.next()).value[0].toString());
    assert.deepEqual(await read(), {
      type: "snapshot",
      output: "saved output\r\n",
      status: "running",
    });
    const text = "echo rapid typing 😀\r" + "x".repeat(23000);
    for (const data of terminalInputChunks(text))
      ws.send(JSON.stringify({ type: "input", data }));
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    // A pong is sent after earlier ordered frames have been processed.
    const processed = once(ws, "pong");
    ws.ping();
    await processed;
    assert.equal(writes.join(""), text);
    assert.deepEqual(sizes, [[120, 40]]);
    const before = app.store.latestEventId();
    app.terminals.publish("terminal-output", { id, data: "live output" });
    assert.deepEqual(await read(), { type: "output", data: "live output" });
    assert.equal(app.store.latestEventId(), before);
    const closed = once(ws, "close");
    await app.close();
    await closed;
    assert.equal(app.terminals.listeners.size, 0);
  } finally {
    ws?.terminate();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminal upgrades enforce origin, pairing and remote-owner checks; revoked or invalid input cannot reach the shell", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-terminal-auth-")),
    app = await createHarness({
      dataDir: dir,
      port: 0,
      startProviders: false,
      publicOrigin: "https://harness.example",
    }),
    writes = [],
    id = "terminal-auth-fixture",
    sockets = [];
  app.terminals.sessions.set(id, {
    id,
    status: "running",
    output: "",
    process: { write: (text) => writes.push(text), resize() {}, kill() {} },
  });
  const url =
    app.runtime.origin.replace("http:", "ws:") + `/api/terminals/${id}/stream`;
  const denied = (headers) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      sockets.push(ws);
      ws.on("error", reject);
      ws.on("open", () => reject(new Error("Unexpected authorized stream")));
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        resolve(res.statusCode);
        ws.terminate();
      });
    });
  const connect = async (headers) => {
    const ws = new WebSocket(url, { headers });
    sockets.push(ws);
    ws.on("error", () => {});
    await once(ws, "open");
    return ws;
  };
  try {
    assert.equal(await denied({}), 403);
    assert.equal(await denied({ Origin: "https://evil.example" }), 403);
    assert.equal(
      await denied({ Origin: app.runtime.origin, Host: "evil.example" }),
      403,
    );
    assert.equal(
      await denied({
        Origin: app.runtime.origin,
        "cf-connecting-ip": "192.0.2.5",
      }),
      401,
    );
    assert.equal(
      await denied({
        Origin: "https://harness.example",
        Host: "harness.example",
      }),
      403,
    );
    const token = app.auth.pair(app.auth.pairing(), "fixture"),
      paired = await connect({
        Origin: app.runtime.origin,
        "cf-connecting-ip": "192.0.2.5",
        Cookie: `harness_session=${token}`,
      });
    app.store.setting("browser-sessions", {});
    const revoked = once(paired, "close");
    paired.send(JSON.stringify({ type: "input", data: "revoked\r" }));
    assert.equal((await revoked)[0], 1008);
    for (const data of [
      "invalid JSON",
      JSON.stringify({ type: "input", data: "x".repeat(10001) }),
      JSON.stringify({ type: "unknown" }),
    ]) {
      const ws = await connect({ Origin: app.runtime.origin }),
        closed = once(ws, "close");
      ws.send(data);
      ws.send(
        JSON.stringify({ type: "input", data: "after rejected frame\r" }),
      );
      assert.equal((await closed)[0], 1008);
    }
    assert.deepEqual(writes, []);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a remote terminal stream accepts the verified owner and stops input when the Access assertion expires", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }),
    email = "owner@example.test",
    dir = await mkdtemp(join(tmpdir(), "harness-terminal-owner-")),
    app = await createHarness({
      dataDir: dir,
      port: 0,
      startProviders: false,
      publicOrigin: "https://harness.example",
      remoteIdentityHash: createHash("sha256").update(email).digest("hex"),
      access: { teamDomain: "team.example", audience: "terminal-fixture" },
      accessKeys: async () => [
        { ...publicKey.export({ format: "jwk" }), kid: "fixture" },
      ],
    }),
    encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url"),
    unsigned =
      encode({ alg: "RS256", kid: "fixture" }) +
      "." +
      encode({
        iss: "https://team.example",
        aud: ["terminal-fixture"],
        email,
        exp: Math.floor(now / 1000) + 60,
      }),
    assertion =
      unsigned +
      "." +
      sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString(
        "base64url",
      ),
    writes = [],
    id = "terminal-owner-fixture";
  app.terminals.sessions.set(id, {
    id,
    status: "running",
    output: "",
    process: { write: (text) => writes.push(text), resize() {}, kill() {} },
  });
  const ws = new WebSocket(
    app.runtime.origin.replace("http:", "ws:") + `/api/terminals/${id}/stream`,
    {
      headers: {
        Host: "harness.example",
        Origin: "https://harness.example",
        "cf-access-jwt-assertion": assertion,
      },
    },
  );
  try {
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "input", data: "allowed" }));
    const processed = once(ws, "pong");
    ws.ping();
    await processed;
    assert.deepEqual(writes, ["allowed"]);
    t.mock.timers.tick(61000);
    const closed = once(ws, "close");
    ws.send(JSON.stringify({ type: "input", data: "expired\r" }));
    assert.equal((await closed)[0], 1008);
    assert.deepEqual(writes, ["allowed"]);
  } finally {
    ws.terminate();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
