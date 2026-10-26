import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { subscriptionEnvironment } from "../security/environment.mjs";

// Every process's parent, from the operating system's process table.
export function processParents() {
  const [command, args] =
    process.platform === "win32"
      ? [
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
          ],
        ]
      : ["ps", ["-A", "-o", "pid=,ppid="]];
  return new Promise((resolve, reject) =>
    execFile(
      command,
      args,
      { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) =>
        error
          ? reject(error)
          : resolve(
              stdout
                .trim()
                .split(/\r?\n/)
                .map((line) => line.trim().split(/\s+/).map(Number))
                .filter(([pid, ppid]) => pid > 0 && ppid > 0),
            ),
    ),
  );
}
export const SHELLS = {
  powershell: { label: "PowerShell", command: "powershell.exe" },
  cmd: { label: "Command Prompt", command: "cmd.exe" },
};
const MAX_SESSIONS = 16;
// A group is one terminal window; its sessions are that window's tabs.
export class Terminals {
  sessions = new Map();
  groups = new Map();
  opened = 0;
  listeners = new Map();
  // Shells that had a command running at the last check, and when it began.
  running = new Set();
  checkedAt = 0;
  constructor(
    onEvent,
    { parents = processParents, locked = () => false } = {},
  ) {
    this.onEvent = onEvent;
    this.parents = parents;
    // While Harness hands over to a new version, typing would start work that
    // the handover then ends.
    this.locked = locked;
  }
  // A shell is busy while a command it started is still running, which shows
  // as a child process. One sitting at its prompt has none.
  async checkRunning({ maxAge = 0 } = {}) {
    if (Date.now() - this.checkedAt < maxAge) return;
    const live = [...this.sessions.values()].filter(
      (s) => s.status === "running",
    );
    const started = Date.now();
    if (!live.length) {
      this.running = new Set();
      this.checkedAt = started;
      return;
    }
    let parents;
    try {
      parents = new Set((await this.parents()).map(([, ppid]) => ppid));
    } catch {
      // Without the process table, every live shell counts as busy.
      parents = new Set(live.map((s) => s.process.pid));
    }
    this.running = new Set(
      live.filter((s) => parents.has(s.process.pid)).map((s) => s.id),
    );
    this.checkedAt = started;
  }
  // Shells that may be running a command: busy at the last check, typed into
  // since, or never checked. An idle shell is left for the update to close.
  busy() {
    return [...this.sessions.values()].filter(
      (s) => s.status === "running" && this.mayBeBusy(s),
    );
  }
  // Live shells at their prompt, which an update closes.
  idle() {
    return [...this.sessions.values()].filter(
      (s) => s.status === "running" && !this.mayBeBusy(s),
    );
  }
  mayBeBusy(s) {
    return (
      this.running.has(s.id) ||
      s.inputAt >= this.checkedAt ||
      s.createdAt >= this.checkedAt
    );
  }
  subscribe(id, listener) {
    if (!this.sessions.has(id)) throw new Error("Terminal has ended");
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }
  publish(type, data) {
    for (const listener of this.listeners.get(data.id) ?? []) listener(type, data);
    this.onEvent(type, data);
  }
  list({ output = true } = {}) {
    return [...this.sessions.values()].map(
      ({ process, output: text, ...session }) =>
        output ? { ...session, output: text } : session,
    );
  }
  create(project, { shell = "powershell", groupId } = {}) {
    if (!Object.hasOwn(SHELLS, shell)) throw new Error("Unknown shell");
    if (process.platform !== "win32" && shell !== "powershell")
      throw new Error("Command Prompt is only available on Windows.");
    if (this.sessions.size >= MAX_SESSIONS)
      throw new Error(
        `Close a terminal tab before opening another (maximum ${MAX_SESSIONS}).`,
      );
    let group = groupId && this.groups.get(groupId);
    if (groupId && (!group || group.projectId !== project.id))
      throw new Error("Terminal not found");
    if (!group) {
      group = {
        id: randomUUID(),
        projectId: project.id,
        title: "Terminal " + ++this.opened,
        opened: {},
      };
      this.groups.set(group.id, group);
    }
    group.opened[shell] = (group.opened[shell] ?? 0) + 1;
    const id = randomUUID(),
      title = `${SHELLS[shell].label} ${group.opened[shell]}`,
      command =
        process.platform === "win32"
          ? SHELLS[shell].command
          : (process.env.SHELL ?? "/bin/sh");
    const child = pty.spawn(
      command,
      process.platform === "win32" && shell === "powershell"
        ? ["-NoLogo", "-NoProfile"]
        : [],
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
      groupId: group.id,
      groupTitle: group.title,
      shell,
      title,
      output: "",
      status: "running",
      // Set once a line has been submitted, so an untouched terminal can be dropped.
      used: false,
      createdAt: Date.now(),
      inputAt: 0,
      process: child,
    };
    this.sessions.set(id, session);
    child.onData((data) => {
      session.output = (session.output + data).slice(-200000);
      this.publish("terminal-output", { id, data });
    });
    child.onExit(({ exitCode }) => {
      session.status = "exited";
      this.publish("terminal-exit", { id, exitCode });
      this.onEvent("terminals", {});
    });
    this.onEvent("terminals", {});
    return {
      id,
      projectId: project.id,
      groupId: group.id,
      groupTitle: group.title,
      shell,
      title,
      status: "running",
      output: "",
    };
  }
  write(id, data) {
    const s = this.sessions.get(id);
    if (!s || s.status !== "running") throw new Error("Terminal has ended");
    if (typeof data !== "string" || data.length > 10000)
      throw new Error("Invalid terminal input");
    if (this.locked())
      throw new Error("Harness is updating. Type again once it is back.");
    s.inputAt = Date.now();
    if (/[\r\n]/.test(data)) s.used = true;
    s.process.write(data);
  }
  // A terminal nobody has typed a command into is removed when it is left.
  async discardUnused(groupId) {
    const tabs = [...this.sessions.values()].filter(
      (s) => s.groupId === groupId,
    );
    if (!tabs.length || tabs.some((s) => s.used)) return false;
    await Promise.all(tabs.map((s) => this.close(s.id)));
    return true;
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
      this.publish("terminal-closed", { id });
      if (![...this.sessions.values()].some((o) => o.groupId === s.groupId))
        this.groups.delete(s.groupId);
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
