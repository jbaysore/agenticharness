import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { browserStreams } from "../src/core/browser-stream.mjs";
import { terminalStreams } from "../src/core/terminal-stream.mjs";

// A stand-in for the shared Chrome: it records input, and the first mouse-down
// is slow, as a real one can be.
function fakeHost() {
  const seen = [];
  let viewer = null;
  return {
    seen,
    frame: (frame) => viewer.frame(frame),
    async watch(v) {
      viewer = v;
      v.state({ type: "state", running: true, tabs: [] });
      return () => (viewer = null);
    },
    async input(message) {
      if (message.type === "navigate") await new Promise(() => {});
      if (message.type === "copy") return { type: "copied", text: "hello" };
      if (message.action === "down")
        await new Promise((resolve) => setTimeout(resolve, 50));
      seen.push(message.action ?? message.type);
    },
  };
}

async function serve(host, allowed = true) {
  const server = createServer();
  const authorize = async () =>
    allowed ? { allowed: () => true } : { status: 401 };
  const browser = browserStreams(server, { host, authorize });
  const terminals = terminalStreams(server, {
    terminals: { sessions: new Map() },
    authorize,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${server.address().port}/api/browser/stream`;
  return {
    url,
    async close() {
      await browser.close();
      await terminals.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const open = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on("message", (data, binary) =>
      messages.push(binary ? data : JSON.parse(data.toString())),
    );
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("unexpected-response", (_, res) => reject(res.statusCode));
    ws.on("error", reject);
  });

test("the Browser panel's input reaches the page in order, past a slow load", async () => {
  const host = fakeHost(),
    harness = await serve(host);
  const { ws, messages } = await open(harness.url);
  for (const message of [
    { type: "navigate", url: "example.com" },
    { type: "mouse", action: "down", x: 1, y: 1 },
    { type: "mouse", action: "up", x: 1, y: 1 },
    { type: "key", action: "down", key: "a" },
  ])
    ws.send(JSON.stringify(message));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(host.seen, ["down", "up", "down"]);
  assert.equal(messages[0].type, "state");
  host.frame({ data: Buffer.from([1, 2, 3]), width: 1280, height: 800 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(messages[1], { type: "frame", width: 1280, height: 800 });
  assert.deepEqual([...messages[2]], [1, 2, 3]);
  ws.send(JSON.stringify({ type: "copy" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(messages.at(-1), { type: "copied", text: "hello" });
  ws.close();
  await harness.close();
});

test("the Browser panel's stream needs the same access as a terminal", async () => {
  const harness = await serve(fakeHost(), false);
  await assert.rejects(open(harness.url), (status) => status === 401);
  await harness.close();
});
