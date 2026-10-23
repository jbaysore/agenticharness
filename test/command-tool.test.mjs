import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  lstat,
  writeFile,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeCommand } from "../src/core/command-tool.mjs";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { buildSteps } from "../src/core/steps.mjs";
import { createHarness } from "../src/server.mjs";
import { dependencyInstructions } from "../src/core/command-shells.mjs";
import { runCommand } from "../src/core/commands.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("host commands can read linked dependencies and update Git metadata outside the worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-command-git-")),
    primary = join(root, "primary"),
    worktree = join(root, "worktree"),
    shared = join(primary, "node_modules"),
    exec = promisify(execFile);
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, "fixture.txt"), "linked dependency");
  const git = (...args) =>
    exec("git", args, { cwd: primary, windowsHide: true });
  try {
    await git("init", "-q");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    );
    await git("worktree", "add", "-qb", "host-command", worktree);
    await symlink(
      shared,
      join(worktree, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      join(worktree, "check.cjs"),
      "const fs = require('node:fs'); const text = fs.readFileSync('node_modules/fixture.txt', 'utf8'); console.log(text); fs.writeFileSync('result.txt', text);",
    );
    const result = await executeCommand(
      {
        command: "node check.cjs && git add result.txt",
        shell: process.platform === "win32" ? "cmd" : "bash",
      },
      {
        project: { path: worktree },
        signal: new AbortController().signal,
        approve: async () => ({ allow: true }),
        run: runCommand,
        emit() {},
      },
    );
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /linked dependency/);
    assert.equal(
      (
        await exec("git", ["diff", "--cached", "--name-only"], {
          cwd: worktree,
          windowsHide: true,
        })
      ).stdout.trim(),
      "result.txt",
    );
    assert.equal(
      await readFile(join(shared, "fixture.txt"), "utf8"),
      "linked dependency",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command validation and permission review happen before any execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-command-scope-")),
    project = { path: join(root, "project") },
    outside = join(root, "outside"),
    signal = new AbortController().signal;
  await mkdir(project.path);
  await mkdir(outside);
  await symlink(
    outside,
    join(project.path, "outside-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  let ran = 0,
    approvals = 0;
  const context = {
    project,
    signal,
    emit() {},
    run: async () => {
      ran++;
    },
    approve: async () => {
      approvals++;
      return { allow: false, reason: "Not authorized" };
    },
  };
  try {
    for (const input of [
      { command: "" },
      { command: "ok", shell: "unknown" },
      { command: "ok", timeoutSeconds: 0 },
      { command: "ok", cwd: "../outside" },
      { command: "ok", cwd: "outside-link" },
    ])
      await assert.rejects(executeCommand(input, context));
    assert.equal(approvals, 0);
    const declined = await executeCommand({ command: "echo not-run" }, context);
    assert.equal(declined.declined, true);
    assert.equal(approvals, 1);
    assert.equal(ran, 0);
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(
      await executeCommand(
        { command: "echo not-run" },
        { ...context, signal: aborted.signal },
      ),
      { cancelled: true },
    );
    assert.equal(approvals, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const provider of ["codex", "claude", "cursor"])
  test(`${provider}: foreground commands use the reviewed host runner and retain the actual failure status`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-host-command-")),
      store = new Store(":memory:"),
      controller = new Controller(store, { bridgeUrl: "http://fixture" }),
      chat = store.createConversation({
        projectId: store.addProject("Commands", dir).id,
        provider,
        permissions: "manual",
      });
    let context, release;
    const ready = Promise.withResolvers();
    let executions = 0;
    controller.providers = [
      { id: provider, models: [{ id: "fixture", efforts: [] }] },
    ];
    controller.runners[provider] = async (ctx) => {
      context = ctx;
      ready.resolve();
      await new Promise((r) => (release = r));
      return { status: "completed" };
    };
    controller.runCommand = async (options) => {
      executions++;
      options.onOutput("command diagnostic");
      assert.equal(options.cwd, dir);
      assert.equal(options.timeoutMs, 2000);
      return {
        exitCode: 7,
        output: "command diagnostic",
        timedOut: false,
        truncated: false,
      };
    };
    controller.on("event", (event) => {
      if (event.type === "approval")
        controller.answer(event.payload.id, { allow: true });
    });
    try {
      const run = controller.send(chat.id, {
        actionId: "host-command-" + provider,
        text: "Run a foreground check",
        provider,
        model: "fixture",
      });
      await ready.promise;
      assert.ok(context.tools.some((tool) => tool.name === "run_command"));
      assert.match(context.instructions, /run_command/);
      const result = await context.history("run_command", {
        command: "echo diagnostic",
        timeoutSeconds: 2,
      });
      assert.equal(result.exitCode, 7);
      assert.equal(executions, 1);
      const events = store.db
        .prepare("SELECT type,payload FROM events WHERE run_id=? ORDER BY id")
        .all(run.id)
        .map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
      const approval = store.approval(
        events.find((event) => event.type === "approval").payload.id,
      );
      assert.equal(approval.request.details.requestedThrough, "run_command");
      assert.equal(approval.request.details.execution, "Harness host process");
      assert.equal(
        buildSteps(events).find((step) => step.verb === "run").status,
        "failed",
      );
      release();
      await controller.active.get(chat.id).task;
      assert.equal(controller.bridgeCommands.size, 0);
    } finally {
      release?.();
      await controller.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

test("Ask mode neither offers nor executes a host command", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {}),
    chat = store.createConversation({
      projectId: store.addProject("Ask", process.cwd()).id,
      mode: "ask",
      permissions: "override",
    });
  controller.providers = [
    { id: "codex", models: [{ id: "fixture", efforts: [] }] },
  ];
  controller.runCommand = () => assert.fail("Ask mode ran a command");
  controller.runners.codex = async (ctx) => {
    assert.equal(
      ctx.tools.some((tool) => tool.name === "run_command"),
      false,
    );
    assert.equal(controller.bridgeCommands.size, 0);
    assert.match(
      (await ctx.history("run_command", { command: "echo forbidden" })).error,
      /read-only/,
    );
    return { status: "completed" };
  };
  try {
    controller.send(chat.id, {
      actionId: "ask-host-command",
      text: "Inspect",
      provider: "codex",
      model: "fixture",
    });
    await controller.active.get(chat.id).task;
  } finally {
    await controller.close();
    store.close();
  }
});

test("the MCP HTTP bridge offers the command tool, returns a real exit code, and expires after the turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-command-bridge-")),
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false }),
    chat = app.store.createConversation({
      projectId: app.store.addProject("Commands", dir).id,
      provider: "cursor",
      permissions: "override",
    }),
    ready = Promise.withResolvers();
  let context, release;
  app.controller.providers = [
    { id: "cursor", models: [{ id: "fixture", efforts: [] }] },
  ];
  app.controller.runners.cursor = async (ctx) => {
    context = ctx;
    ready.resolve();
    await new Promise((r) => (release = r));
    return { status: "completed" };
  };
  try {
    app.controller.send(chat.id, {
      actionId: "command-bridge-fixture",
      text: "Run the check",
      provider: "cursor",
      model: "fixture",
    });
    const task = app.controller.active.get(chat.id).task;
    await ready.promise;
    const token = context.mcpServers[0].env.find(
        (v) => v.name === "HARNESS_BRIDGE_TOKEN",
      ).value,
      headers = {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      };
    const tools = await fetch(app.runtime.origin + "/internal/tools", {
      headers,
    }).then((r) => r.json());
    assert.ok(tools.tools.some((tool) => tool.name === "run_command"));
    const response = await fetch(app.runtime.origin + "/internal/history", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "run_command",
        arguments: {
          command: 'node -e "console.log(123);process.exit(3)"',
          shell: process.platform === "win32" ? "cmd" : "bash",
        },
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.exitCode, 3);
    assert.match(result.output, /123/);
    release();
    await task;
    assert.equal(
      (await fetch(app.runtime.origin + "/internal/tools", { headers })).status,
      401,
    );
  } finally {
    release?.();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("package installation detaches only an approved worktree dependency link and detects stale dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-private-deps-")),
    project = { path: join(root, "worktree") },
    shared = join(root, "shared-modules"),
    modules = join(project.path, "node_modules");
  await mkdir(project.path);
  await mkdir(shared);
  await writeFile(join(shared, "keep.txt"), "another chat's dependencies");
  await writeFile(
    join(project.path, "package-lock.json"),
    JSON.stringify({
      packages: {
        "": { dependencies: { example: "1.0.0" } },
        "node_modules/example": { version: "1.0.0" },
      },
    }),
  );
  await writeFile(
    join(shared, ".package-lock.json"),
    JSON.stringify({ packages: {} }),
  );
  await symlink(
    shared,
    modules,
    process.platform === "win32" ? "junction" : "dir",
  );
  const context = {
    project,
    signal: new AbortController().signal,
    emit() {},
    approve: async () => ({ allow: false }),
    run: () => assert.fail("Declined installation ran"),
  };
  try {
    assert.match(dependencyInstructions(project.path), /do not match/);
    assert.match(dependencyInstructions(project.path), /shared/);
    await executeCommand({ command: "npm.cmd ci --include=dev" }, context);
    assert.equal((await lstat(modules)).isSymbolicLink(), true);
    await executeCommand(
      { command: "npm.cmd ci --include=dev" },
      {
        ...context,
        approve: async (request) => {
          assert.equal(request.details.isolateDependencies, true);
          return { allow: true };
        },
        run: async () => {
          await assert.rejects(lstat(modules), { code: "ENOENT" });
          assert.equal(
            await readFile(join(shared, "keep.txt"), "utf8"),
            "another chat's dependencies",
          );
          await mkdir(modules);
          await writeFile(
            join(modules, ".package-lock.json"),
            JSON.stringify({
              packages: { "node_modules/example": { version: "1.0.0" } },
            }),
          );
          return { exitCode: 0 };
        },
      },
    );
    assert.equal(dependencyInstructions(project.path), "");
    await rm(modules, { recursive: true });
    await symlink(
      shared,
      modules,
      process.platform === "win32" ? "junction" : "dir",
    );
    await mkdir(join(project.path, "nested"));
    await executeCommand(
      {
        command: "echo prepare && npm.cmd ci",
        shell: process.platform === "win32" ? "cmd" : "bash",
        cwd: "nested",
        isolateDependencies: true,
      },
      {
        ...context,
        approve: async () => ({ allow: true }),
        run: async () => {
          await assert.rejects(lstat(modules), { code: "ENOENT" });
          assert.equal(
            await readFile(join(shared, "keep.txt"), "utf8"),
            "another chat's dependencies",
          );
          return { exitCode: 0 };
        },
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
