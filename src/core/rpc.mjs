import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// Both Codex app-server and ACP use newline-delimited JSON, not LSP framing.
export class RpcProcess extends EventEmitter {
  constructor(command, args = [], options = {}) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = '';
    this.closed = false;
    this.child = spawn(command, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', data => this.consume(data));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', data => this.emit('diagnostic', data));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Agent exited (${code ?? signal})`)));
  }

  consume(data) {
    this.buffer += data;
    if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) {
      this.fail(new Error('Agent protocol message exceeds 32 MB'));
      this.close();
      return;
    }
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        this.emit('protocolWarning', 'Agent emitted a non-JSON protocol line');
        continue;
      }
      if (message.method) {
        this.emit(message.id === undefined ? 'notification' : 'request', message);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const error = new Error(message.error.message ?? 'Agent request failed');
          error.code = message.error.code;
          pending.reject(error);
        } else pending.resolve(message.result);
      }
    }
  }

  send(message) {
    if (this.closed) throw new Error('Agent connection is closed');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  call(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent request timed out: ${method}. It was not retried.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) { this.send({ method, params }); }
  respond(id, result) { this.send({ id, result }); }
  reject(id, message = 'This client does not support that request') {
    this.send({ id, error: { code: -32601, message } });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    this.emit('closed', error);
  }

  close() {
    this.fail(new Error('Agent connection closed'));
    this.child.stdin.end();
    this.child.kill();
  }
}
