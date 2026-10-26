import { WebSocketServer, WebSocket } from "ws";

export const BROWSER_STREAM_PATH = "/api/browser/stream";
const loads = new Set(["navigate", "back", "forward", "reload"]);

// The Browser panel's live view: page frames out as binary JPEG messages, a
// small JSON header before each, and the user's clicks, keys and navigation in.
export function browserStreams(server, { host, authorize }) {
  const streams = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  const upgrade = async (req, socket, head) => {
    if (new URL(req.url, "http://localhost").pathname !== BROWSER_STREAM_PATH)
      return;
    socket.on("error", () => {});
    const reject = (status, message) => {
      if (!socket.destroyed)
        socket.end(
          `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
    };
    try {
      if (!host) return reject(503, "Service Unavailable");
      const access = await authorize(req);
      if (access.status) return reject(access.status, "Forbidden");
      if (socket.destroyed) return;
      streams.handleUpgrade(req, socket, head, (ws) => {
        let alive = true,
          stop = null,
          closed = false;
        ws.on("error", () => {});
        ws.on("pong", () => {
          alive = true;
        });
        ws.checkAlive = () => {
          if (!alive) return ws.terminate();
          alive = false;
          ws.ping();
        };
        const send = (message) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify(message));
        };
        // A slow connection skips frames rather than queueing them. The
        // newest skipped one is sent once it catches up, since a page that
        // has stopped changing sends no more.
        let skipped = null,
          retry = null;
        const viewer = {
          state: send,
          frame(frame) {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount > 1024 * 1024) {
              skipped = frame;
              retry ??= setTimeout(() => {
                retry = null;
                const next = skipped;
                skipped = null;
                if (next) viewer.frame(next);
              }, 100);
              return;
            }
            skipped = null;
            ws.send(
              JSON.stringify({
                type: "frame",
                width: frame.width,
                height: frame.height,
              }),
            );
            ws.send(frame.data, { binary: true });
          },
        };
        ws.on("close", () => {
          closed = true;
          clearTimeout(retry);
          stop?.();
        });
        // Input applies in the order it was sent, so a mouse-up never
        // overtakes the mouse-down before it.
        let queue = Promise.resolve();
        ws.on("message", (data, binary) => {
          queue = queue.then(async () => {
            if (ws.readyState !== WebSocket.OPEN) return;
            try {
              if (!access.allowed())
                throw new Error("Browser access expired. Sign in again.");
              if (binary) throw new Error("Expected a browser text message");
              const message = JSON.parse(data.toString()),
                work = host.input(message);
              // A page load can take a while; clicks after it still go through.
              if (loads.has(message.type))
                work.catch((error) =>
                  send({ type: "error", error: error.message }),
                );
              else {
                const reply = await work;
                if (reply) send(reply);
              }
            } catch (error) {
              send({ type: "error", error: error.message });
            }
          });
        });
        host
          .watch(viewer)
          .then((unwatch) => {
            if (closed) unwatch();
            else stop = unwatch;
          })
          .catch((error) => {
            send({
              type: "error",
              error: "Chrome could not start: " + error.message,
            });
            ws.close(1011);
          });
      });
    } catch {
      reject(400, "Bad Request");
    }
  };
  server.on("upgrade", upgrade);
  const heartbeat = setInterval(() => {
    for (const ws of streams.clients)
      if (ws.readyState === WebSocket.OPEN) ws.checkAlive();
  }, 30000);
  heartbeat.unref();
  return {
    async close() {
      clearInterval(heartbeat);
      server.off("upgrade", upgrade);
      for (const ws of streams.clients) ws.terminate();
      await new Promise((resolve) => streams.close(resolve));
    },
  };
}
