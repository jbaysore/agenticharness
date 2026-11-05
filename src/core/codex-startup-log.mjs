import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { DatabaseSync } from "node:sqlite";

const writes = new Map();
const MAX_LINE = 16_384;
const MAX_LINES = 32;

// Local startup diagnostics only: never copy RPC params/results or the child env.
export function startupDiagnostic(text) {
  if (text.length > MAX_LINE) return "[overlong diagnostic omitted]";
  let line = stripVTControlCharacters(text)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim()
    .replace(/\\+(?=["'])/g, "")
    .replace(
      /\b(?:headers|request_headers|response_headers)\s*["']?\s*[:=].*/i,
      "headers=[omitted]",
    );
  if (
    /\b(?:authorization|cookie|set-cookie|password|secret|api[_-]?key|\w*token|email|account[_-]?id|user[_-]?id|installation[_-]?id)\b\s*["']?\s*[:=]/i.test(
      line,
    )
  )
    return "[credential diagnostic omitted]";
  if (
    /\b(?:prompt|input|messages?|content|body|payload|params|result)\b\s*["']?\s*[:=]/i.test(
      line,
    )
  )
    return "[payload diagnostic omitted]";
  line = line
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url omitted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[\w-]+/g, "[redacted]")
    .replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g, "[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email omitted]");
  return line.slice(0, 1000);
}

function errorCode(error) {
  return typeof error?.code === "number" ||
    /^(?:E[A-Z0-9_]{1,40}|AGENT_RPC_TIMEOUT)$/.test(error?.code ?? "")
    ? error.code
    : null;
}

// Serialize writes/rotation across concurrent chats and connection checks.
export function appendStartupRecord(
  path,
  record,
  { maxBytes = 2 * 1024 * 1024 } = {},
) {
  const previous = writes.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const line = JSON.stringify(record) + "\n";
      const size = await stat(path).then(
        (s) => s.size,
        (e) => {
          if (e.code !== "ENOENT") throw e;
          return 0;
        },
      );
      if (size && size + Buffer.byteLength(line) > maxBytes) {
        await rm(path + ".3", { force: true });
        for (let n = 2; n >= 0; n--)
          await rename(n ? path + "." + n : path, path + "." + (n + 1)).catch(
            (e) => {
              if (e.code !== "ENOENT") throw e;
            },
          );
      }
      await appendFile(path, line, { mode: 0o600 });
    });
  writes.set(path, next);
  next
    .finally(() => {
      if (writes.get(path) === next) writes.delete(path);
    })
    .catch(() => {});
  return next;
}

// A quiet child may still have native records. Read only its startup window.
export function codexNativeStartup(path, pid, startedAt, endedAt) {
  if (!pid) return { status: "no-process", records: [] };
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout=20");
    const records = db
      .prepare(
        `SELECT ts,level,target,process_uuid,
      substr(feedback_log_body,1,16385) AS body FROM logs
      WHERE id > (SELECT COALESCE(MAX(id),0)-20000 FROM logs)
      AND ts BETWEEN ? AND ? AND process_uuid LIKE ?
      ORDER BY id DESC LIMIT 40`,
      )
      .all(
        Math.floor(startedAt / 1000) - 1,
        Math.ceil(endedAt / 1000),
        `pid:${pid}:%`,
      )
      .reverse()
      .map((row) => ({
        at: new Date(row.ts * 1000).toISOString(),
        level: startupDiagnostic(row.level),
        target: startupDiagnostic(row.target),
        process: row.process_uuid,
        message: startupDiagnostic(row.body ?? ""),
      }));
    return {
      status: records.length ? "captured" : "no-matching-records",
      scanLimit: 20000,
      records,
    };
  } catch (error) {
    return { status: "unavailable", code: errorCode(error), records: [] };
  } finally {
    try {
      db?.close();
    } catch {
      /* Diagnostics must not stop startup. */
    }
  }
}

export class CodexStartupLog {
  constructor({
    dataDir,
    cwd,
    chatId,
    runId,
    purpose = "connection",
    nativeLogPath,
  } = {}) {
    const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const data =
      dataDir ??
      process.env.HARNESS_DATA_DIR ??
      join(process.env.LOCALAPPDATA ?? homedir(), "AgenticHarness");
    this.path = join(data, "diagnostics", "codex-startup.jsonl");
    this.nativeLogPath = nativeLogPath ?? join(home, "logs_2.sqlite");
    this.startedAt = Date.now();
    this.clock = performance.now();
    this.base = {
      attempt: randomUUID(),
      hostPid: process.pid,
      cwd,
      chatId,
      runId,
      purpose,
    };
    this.listeners = [];
    this.stderr = [];
    this.stderrBuffer = "";
    this.droppingLine = false;
    this.protocol = [];
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.protocolWarnings = 0;
    this.overlongLines = 0;
    this.queue = Promise.resolve();
  }

  record(phase, details = {}) {
    const record = {
      ...this.base,
      at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - this.clock),
      phase,
      ...details,
    };
    this.queue = this.queue
      .then(() => appendStartupRecord(this.path, record))
      .then(
        () => true,
        (error) => {
          console.error(
            "Codex startup diagnostics could not be saved",
            errorCode(error),
          );
          return false;
        },
      );
    return this.queue;
  }

  listen(target, name, callback) {
    target.on(name, callback);
    this.listeners.push(() => target.removeListener(name, callback));
  }

  attach(rpc, command) {
    this.rpc = rpc;
    this.base.pid = rpc.child.pid ?? null;
    this.record("spawn", {
      executable: command,
      nativeLogPath: this.nativeLogPath,
    });
    this.listen(rpc.child, "spawn", () => this.record("spawned"));
    this.listen(rpc.child.stdout, "data", (data) => {
      this.stdoutBytes += Buffer.byteLength(data);
      this.lastStdoutMs = Math.round(performance.now() - this.clock);
    });
    this.listen(rpc, "diagnostic", (data) => this.takeStderr(data));
    this.listen(rpc, "protocolWarning", () => this.protocolWarnings++);
    for (const kind of ["notification", "request"])
      this.listen(rpc, kind, (message) => {
        const method = /^[\w/.-]{1,120}$/.test(message.method)
          ? message.method
          : "[omitted]";
        this.protocol.push({
          elapsedMs: Math.round(performance.now() - this.clock),
          kind,
          method,
        });
        if (this.protocol.length > MAX_LINES) this.protocol.shift();
      });
    this.listen(rpc.child, "exit", (code, signal) => {
      this.exit = { code, signal };
    });
  }

  takeStderr(data) {
    this.stderrBytes += Buffer.byteLength(data);
    this.lastStderrMs = Math.round(performance.now() - this.clock);
    const parts = data.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (this.stderrBuffer.length + parts[i].length > MAX_LINE) {
        this.stderrBuffer = "";
        if (!this.droppingLine) this.overlongLines++;
        this.droppingLine = true;
      }
      if (!this.droppingLine) this.stderrBuffer += parts[i];
      if (i < parts.length - 1) {
        this.flushStderr();
        this.droppingLine = false;
      }
    }
  }

  flushStderr() {
    const message = this.droppingLine
      ? "[overlong diagnostic omitted]"
      : startupDiagnostic(this.stderrBuffer);
    if (message) {
      this.stderr.push({
        elapsedMs: Math.round(performance.now() - this.clock),
        message,
      });
      if (this.stderr.length > MAX_LINES) this.stderr.shift();
    }
    this.stderrBuffer = "";
  }

  async finish(phase, error) {
    for (const remove of this.listeners.splice(0)) remove();
    this.flushStderr();
    const endedAt = Date.now();
    return this.record(phase, {
      code: errorCode(error),
      timeoutMs: error?.timeoutMs ?? null,
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes,
      lastStdoutMs: this.lastStdoutMs ?? null,
      lastStderrMs: this.lastStderrMs ?? null,
      protocolWarnings: this.protocolWarnings,
      overlongLines: this.overlongLines,
      exit: this.exit ?? {
        code: this.rpc?.child.exitCode ?? null,
        signal: this.rpc?.child.signalCode ?? null,
      },
      protocol: this.protocol,
      stderr: this.stderr,
      ...(phase === "failed" && {
        native: codexNativeStartup(
          this.nativeLogPath,
          this.base.pid,
          this.startedAt,
          endedAt,
        ),
      }),
    });
  }
}
