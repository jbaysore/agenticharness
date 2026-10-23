// Split large pastes without breaking surrogate pairs or the host's input cap.
export function* terminalInputChunks(text) {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 10000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    yield text.slice(offset, end);
    offset = end;
  }
}

export function connectTerminal(
  id,
  { onMessage, onOpen, onReconnect, report },
) {
  const url = new URL(`/api/terminals/${id}/stream`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let socket,
    disposed = false,
    opened = false,
    initial = true,
    pending = [],
    pendingSize = 0,
    timer,
    delay = 250,
    reported = false;
  const send = (message) => socket.send(JSON.stringify(message));
  const connect = () => {
    socket = new WebSocket(url);
    socket.onopen = () => {
      if (disposed) return socket.close();
      opened = true;
      reported = false;
      delay = 250;
      onOpen?.();
      for (const data of pending) send({ type: "input", data });
      pending = [];
      pendingSize = 0;
    };
    socket.onmessage = (event) => {
      if (!disposed) onMessage(JSON.parse(event.data));
    };
    socket.onclose = (event) => {
      initial = false;
      pending = [];
      pendingSize = 0;
      if (disposed || [1000, 1008, 1009].includes(event.code)) return;
      onReconnect?.();
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 5000);
    };
  };
  connect();
  return {
    input(data) {
      if (disposed) return;
      if (socket.readyState === WebSocket.OPEN) {
        for (const chunk of terminalInputChunks(data))
          send({ type: "input", data: chunk });
      } else if (
        !opened &&
        initial &&
        socket.readyState === WebSocket.CONNECTING &&
        pendingSize + data.length <= 200000
      ) {
        pending.push(...terminalInputChunks(data));
        pendingSize += data.length;
      } else if (!reported) {
        reported = true;
        report(
          new Error(
            "Terminal is disconnected. Wait for it to reconnect before typing. Unsent input was not replayed.",
          ),
        );
      }
    },
    resize(cols, rows) {
      if (!disposed && socket.readyState === WebSocket.OPEN)
        send({ type: "resize", cols, rows });
    },
    dispose() {
      disposed = true;
      pending = [];
      clearTimeout(timer);
      socket.close();
    },
  };
}
