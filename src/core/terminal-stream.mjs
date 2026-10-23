import { WebSocketServer, WebSocket } from "ws";

// Each terminal gets an ordered bidirectional stream. Output already lives in
// its bounded in-memory replay buffer; typing never waits for HTTP or SQLite.
export function terminalStreams(server, { terminals, authorize }) {
  const streams = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  const upgrade = async (req, socket, head) => {
    socket.on("error", () => {});
    const reject = (status, message) => {
      if (!socket.destroyed)
        socket.end(
          `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
    };
    try {
      const match = /^\/api\/terminals\/([^/]+)\/stream$/.exec(
        new URL(req.url, "http://localhost").pathname,
      );
      if (!match) return reject(404, "Not Found");
      const access = await authorize(req);
      if (access.status) return reject(access.status, "Forbidden");
      const id = match[1],
        session = terminals.sessions.get(id);
      if (!session) return reject(404, "Not Found");
      if (socket.destroyed) return;
      streams.handleUpgrade(req, socket, head, (ws) => {
        let alive = true;
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
          if (ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > 2 * 1024 * 1024) return ws.terminate();
          ws.send(JSON.stringify(message));
        };
        const unsubscribe = terminals.subscribe(id, (type, data) => {
          if (type === "terminal-output")
            send({ type: "output", data: data.data });
          if (type === "terminal-exit")
            send({ type: "exit", exitCode: data.exitCode });
          if (["terminal-exit", "terminal-closed"].includes(type))
            ws.close(1000);
        });
        ws.on("close", unsubscribe);
        ws.on("message", (data, binary) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            if (!access.allowed())
              throw new Error("Terminal access expired. Sign in again.");
            if (binary) throw new Error("Expected a terminal text message");
            const message = JSON.parse(data.toString());
            if (message.type === "input") terminals.write(id, message.data);
            else if (message.type === "resize")
              terminals.resize(id, message.cols, message.rows);
            else throw new Error("Unknown terminal message");
          } catch (error) {
            send({ type: "error", error: error.message });
            ws.close(1008);
          }
        });
        send({
          type: "snapshot",
          output: session.output,
          status: session.status,
        });
        if (session.status === "exited") ws.close(1000);
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
