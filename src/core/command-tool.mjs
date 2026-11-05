import { randomUUID } from "node:crypto";
import { realpath, lstat, unlink } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep, join, dirname } from "node:path";
import { commandShell } from "./command-shells.mjs";
import { workspaceFingerprint } from "./repository.mjs";

export const commandTool = {
  name: "run_command",
  description:
    "Run a foreground command in this chat's worktree through Harness's permission review. Choose powershell, cmd or bash explicitly when syntax matters. Supports builds, tests, Git, linked dependencies and localhost tools without relying on the agent's sandbox runner. Direct npm/pnpm/yarn installation commands detach a shared node_modules link first; use isolateDependencies for installations inside compound scripts. Returns actual output and exit code; a nonzero result is never automatically retried. Use native execution tools for interactive/background sessions, and explicitly wait or poll required results during the active turn. Background process completion does not resume the agent after the turn ends.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", minLength: 1, maxLength: 8000 },
      shell: { type: "string", enum: ["powershell", "cmd", "bash"] },
      cwd: {
        type: "string",
        description: "Optional subdirectory inside the worktree.",
      },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 600 },
      isolateDependencies: {
        type: "boolean",
        description:
          "Detach a shared node_modules link before a package installation; its target is never deleted.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

export async function executeCommand(
  input,
  { project, approve, run, signal, emit },
) {
  if (
    !input ||
    typeof input.command !== "string" ||
    !input.command.trim() ||
    input.command.length > 8000 ||
    input.command.includes("\0")
  )
    throw new Error("Give a command between 1 and 8000 characters.");
  if (input.cwd !== undefined && typeof input.cwd !== "string")
    throw new Error("Give a worktree subdirectory.");
  if (
    input.isolateDependencies !== undefined &&
    typeof input.isolateDependencies !== "boolean"
  )
    throw new Error("isolateDependencies must be a boolean.");
  const shell =
      input.shell ?? (process.platform === "win32" ? "powershell" : "bash"),
    selected = commandShell(shell),
    seconds = input.timeoutSeconds ?? 600;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600)
    throw new Error("Command timeout must be between 1 and 600 seconds.");
  const root = await realpath(project.path),
    cwd = await realpath(resolve(root, input.cwd ?? ".")),
    subdirectory = relative(root, cwd);
  if (
    isAbsolute(subdirectory) ||
    subdirectory === ".." ||
    subdirectory.startsWith(".." + sep)
  )
    throw new Error("Run commands inside this chat's worktree.");
  if (signal.aborted) return { cancelled: true };
  const isolate =
    input.isolateDependencies === true ||
    /^\s*(?:&\s+)?(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:ci|install|add|remove|uninstall|update|upgrade)\b/i.test(
      input.command,
    );
  const answer = await approve({
    kind: "permission",
    title: input.command,
    details: {
      command: input.command,
      cwd,
      shell: selected.name,
      requestedThrough: "run_command",
      execution: "Harness host process",
      isolateDependencies: isolate,
    },
  });
  if (!answer.allow)
    return {
      declined: true,
      reason: answer.reason ?? "The command was declined. Do not retry it.",
    };
  if (signal.aborted) return { cancelled: true };
  if (isolate) {
    // npm/workspace installers can use a parent package. Detach links only
    // within this worktree, including ancestors of the chosen subdirectory.
    for (let directory = cwd; ; directory = dirname(directory)) {
      const modules = join(directory, "node_modules");
      if (
        await lstat(modules).then(
          (s) => s.isSymbolicLink(),
          () => false,
        )
      )
        await unlink(modules);
      if (relative(root, directory) === "") break;
    }
  }
  const id = randomUUID(),
    started = Date.now();
  const trackedCheck =
    input.command.trim() === project.check_command?.trim() && cwd === root;
  const before = trackedCheck ? await workspaceFingerprint(root) : null;
  const step = (status, extra = {}) =>
    emit("work", {
      kind: "host-command",
      id,
      command: input.command,
      shell: selected.name,
      cwd,
      startedAt: new Date(started).toISOString(),
      trackedCheck,
      status,
      ...extra,
    });
  step("running");
  let streamed = 0;
  try {
    const result = await run({
      command: input.command,
      cwd,
      shell,
      signal,
      timeoutMs: seconds * 1000,
      limit: 200000,
      onOutput: (text) => {
        const delta = text.slice(0, Math.max(0, 200000 - streamed));
        streamed += delta.length;
        if (delta) emit("work", { kind: "command-output", itemId: id, delta });
      },
    });
    step(result.exitCode === 0 && !result.timedOut ? "ok" : "failed", {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      ms: Date.now() - started,
      endedAt: new Date().toISOString(),
      ...(trackedCheck && {
        workspaceBefore: before,
        workspaceAfter: await workspaceFingerprint(root),
      }),
    });
    return result;
  } catch (error) {
    step("failed", {
      error: error.message,
      cancelled: signal.aborted,
      ms: Date.now() - started,
      endedAt: new Date().toISOString(),
    });
    throw error;
  }
}
