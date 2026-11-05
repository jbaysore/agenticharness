import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

// JSON-RPC puts the useful reason in `data` and a generic code name in
// `message`. Cursor's missing-session failure is message "Invalid params"
// and data.message `Session "<id>" not found`. Field errors are kept; the
// rejected value is not, so a bad request cannot echo a token into the chat.
export function rpcErrorMessage(error = {}) {
  const message =
    typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : "Agent request failed";
  const detail = rpcErrorDetail(error.data);
  if (!detail || message.includes(detail)) return message;
  return `${message}: ${detail}`;
}
function rpcErrorDetail(data) {
  if (typeof data === "string") return clip(data);
  if (!data || typeof data !== "object") return null;
  if (typeof data.message === "string" && data.message.trim())
    return clip(data.message);
  const fields = zodFieldErrors(data);
  return fields.length ? clip(fields.join("; ")) : null;
}
function zodFieldErrors(data, prefix = "") {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const errors = [];
  if (Array.isArray(data._errors))
    for (const item of data._errors)
      if (typeof item === "string" && item.trim())
        errors.push(prefix ? `${prefix}: ${item.trim()}` : item.trim());
  for (const [key, value] of Object.entries(data)) {
    if (key === "_errors") continue;
    errors.push(...zodFieldErrors(value, prefix ? `${prefix}.${key}` : key));
    if (errors.length >= 8) break;
  }
  return errors.slice(0, 8);
}
function clip(text) {
  const value = text.trim();
  return value.length > 300 ? value.slice(0, 300) + "…" : value;
}

// Both Codex app-server and ACP use newline-delimited JSON, not LSP framing.
export class RpcProcess extends EventEmitter {
  constructor(command, args = [], options = {}) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = "";
    this.closed = false;
    this.child = spawn(command, args, {
      ...options,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (data) => this.consume(data));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (data) => this.emit("diagnostic", data));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) =>
      this.fail(new Error(`Agent exited (${code ?? signal})`)),
    );
  }

  consume(data) {
    this.buffer += data;
    if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) {
      this.fail(new Error("Agent protocol message exceeds 32 MB"));
      this.close();
      return;
    }
    let end;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit("protocolWarning", "Agent emitted a non-JSON protocol line");
        continue;
      }
      if (message.method) {
        this.emit(
          message.id === undefined ? "notification" : "request",
          message,
        );
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const error = new Error(rpcErrorMessage(message.error));
          error.code = message.error.code;
          error.data = message.error.data;
          pending.reject(error);
        } else pending.resolve(message.result);
      }
    }
  }

  send(message) {
    if (this.closed) throw new Error("Agent connection is closed");
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n",
    );
  }

  call(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(
          `Agent request timed out: ${method}. It was not retried.`,
        );
        error.code = "AGENT_RPC_TIMEOUT";
        error.method = method;
        error.timeoutMs = timeoutMs;
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }
  respond(id, result) {
    this.send({ id, result });
  }
  reject(id, message = "This client does not support that request") {
    this.send({ id, error: { code: -32601, message } });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }

  close() {
    this.fail(new Error("Agent connection closed"));
    this.child.stdin.end();
    this.child.kill();
  }
}
