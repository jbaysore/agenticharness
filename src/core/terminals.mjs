import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import { subscriptionEnvironment } from "../security/environment.mjs";
export class Terminals {
  sessions = new Map();
  opened = 0;
  constructor(onEvent) {
    this.onEvent = onEvent;
  }
  list() {
    return [...this.sessions.values()].map(
      ({ process, ...session }) => session,
    );
  }
  create(project) {
    if (this.sessions.size >= 8)
      throw new Error(
        "Close a terminal before opening another (maximum eight).",
      );
    const id = randomUUID(),
      shell =
        process.platform === "win32"
          ? "powershell.exe"
          : (process.env.SHELL ?? "/bin/sh");
    const child = pty.spawn(
      shell,
      process.platform === "win32" ? ["-NoLogo", "-NoProfile"] : [],
      {
        cwd: project.path,
        env: subscriptionEnvironment(),
        cols: 100,
        rows: 24,
        name: "xterm-256color",
        useConpty: true,
        useConptyDll: false,
      },
    );
    const session = {
      id,
      projectId: project.id,
      title: "Terminal " + ++this.opened,
      output: "",
      status: "running",
      process: child,
    };
    this.sessions.set(id, session);
    child.onData((data) => {
      session.output = (session.output + data).slice(-200000);
      this.onEvent("terminal-output", { id, data });
    });
    child.onExit(({ exitCode }) => {
      session.status = "exited";
      this.onEvent("terminal-exit", { id, exitCode });
      this.onEvent("terminals", {});
    });
    this.onEvent("terminals", {});
    return {
      id,
      projectId: project.id,
      title: session.title,
      status: "running",
      output: "",
    };
  }
  write(id, data) {
    const s = this.sessions.get(id);
    if (!s || s.status !== "running") throw new Error("Terminal has ended");
    if (typeof data !== "string" || data.length > 10000)
      throw new Error("Invalid terminal input");
    s.process.write(data);
  }
  resize(id, cols, rows) {
    if (
      Number.isInteger(cols) &&
      Number.isInteger(rows) &&
      cols >= 10 &&
      cols <= 500 &&
      rows >= 2 &&
      rows <= 200
    )
      this.sessions.get(id)?.process.resize(cols, rows);
  }
  async close(id) {
    const s = this.sessions.get(id);
    if (s) {
      this.sessions.delete(id);
      // Use the library's full cleanup, which disposes its output worker and
      // terminates console descendants. The Windows helper may log a benign
      // AttachConsole race; its bounded fallback still completes shutdown.
      try {
        s.process.kill();
      } catch {
        // Already exited; there is nothing left to stop.
      }
      this.onEvent("terminals", {});
    }
  }
  async closeAll() {
    this.onEvent = () => {};
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
