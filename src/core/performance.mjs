import { monitorEventLoopDelay } from "node:perf_hooks";
import { join } from "node:path";
import { appendDiagnosticRecord } from "./diagnostic-writes.mjs";

// Paths are templates: never persist query strings, filenames, or arbitrary URLs.
export function timingRoute(path) {
  if (path === "/health") return path;
  if (/^\/api\/chats\/[^/]+\/status$/.test(path))
    return "/api/chats/:id/status";
  if (/^\/api\/chats\/[^/]+$/.test(path)) return "/api/chats/:id";
  if (/^\/api\/chats\/[^/]+\/cancel$/.test(path))
    return "/api/chats/:id/cancel";
  if (
    ["/api/state", "/api/directories", "/api/chats", "/api/projects"].includes(
      path,
    )
  )
    return path;
  return path.startsWith("/api/") ? "/api/other" : "/other";
}

export class PerformanceDiagnostics {
  constructor(
    dataDir,
    {
      write = appendDiagnosticRecord,
      now = () => performance.now(),
      intervalMs = 60_000,
      histogram = monitorEventLoopDelay({ resolution: 20 }),
    } = {},
  ) {
    this.path = join(dataDir, "diagnostics", "performance.jsonl");
    this.write = write;
    this.now = now;
    this.histogram = histogram;
    histogram.enable();
    this.timer = setInterval(() => {
      if (histogram.count)
        this.record({
          type: "event-loop",
          p95Ms: Math.round(histogram.percentile(95) / 1e6),
          maxMs: Math.round(histogram.max / 1e6),
        });
      histogram.reset();
    }, intervalMs);
    this.timer.unref();
  }

  record(value) {
    if (this.closed) return;
    // Diagnostics are best effort, including a full queue or unavailable disk.
    try {
      void this.write(this.path, {
        at: new Date().toISOString(),
        ...value,
      }).catch(() => {});
    } catch {
      /* Never interrupt a request or provider for diagnostic failures. */
    }
  }

  start(phase, metadata = {}) {
    const started = this.now();
    const ids = Object.fromEntries(
      ["chatId", "runId", "provider"].flatMap((key) =>
        /^[\w-]{1,100}$/.test(metadata[key] ?? "")
          ? [[key, metadata[key]]]
          : [],
      ),
    );
    let done = false;
    return (outcome = "ready") => {
      if (done) return;
      done = true;
      this.record({
        type: "phase",
        phase,
        ...ids,
        outcome,
        elapsedMs: Math.round(this.now() - started),
      });
    };
  }

  async measure(phase, run, metadata) {
    const done = this.start(phase, metadata);
    try {
      const value = await run();
      done();
      return value;
    } catch (error) {
      done("failed");
      throw error;
    }
  }

  request(req, res) {
    const started = this.now();
    let path = "/other";
    try {
      path = new URL(req.url, "http://localhost").pathname;
    } catch {
      /* Invalid request. */
    }
    const route = timingRoute(path);
    const writeHead = res.writeHead;
    const diagnostics = this;
    res.writeHead = function (...args) {
      this.setHeader(
        "Server-Timing",
        `harness;dur=${(diagnostics.now() - started).toFixed(1)}`,
      );
      return writeHead.apply(this, args);
    };
    res.once("finish", () => {
      const elapsedMs = Math.round(this.now() - started);
      if (elapsedMs >= 250 && path !== "/api/events")
        this.record({
          type: "http",
          route,
          method: req.method,
          status: res.statusCode,
          elapsedMs,
        });
    });
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.histogram.disable();
  }
}
