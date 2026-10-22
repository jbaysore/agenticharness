import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  cp,
  rename,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { setImmediate as nextTick } from "node:timers/promises";
import { runCodex } from "../src/providers/codex.mjs";
import { backup } from "node:sqlite";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import {
  SelfRestart,
  prepareRuntime,
  restartTool,
  startRestartHelper,
} from "../src/core/self-restart.mjs";
import {
  atomicJson,
  readRestartState,
  writeRestartState,
  runtimeHealth,
  acquireHostLock,
  pause,
  processAlive,
} from "../src/core/restart-state.mjs";
import {
  performRestart,
  recoverAbandonedRestart,
  launchRuntime,
} from "../scripts/restart-host.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
async function fixture(options = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harness-self-restart-")),
  );
  const source = join(root, "source"),
    dataDir = join(root, "data");
  await mkdir(source);
  await mkdir(dataDir);
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.email", "test@example.com");
  git(source, "config", "user.name", "Test");
  git(source, "config", "core.autocrlf", "false");
  const bump = async (text = randomUUID()) => {
    await writeFile(join(source, "change.txt"), text);
    git(source, "add", ".");
    git(source, "commit", "-qm", "Fixture revision");
    return git(source, "rev-parse", "HEAD");
  };
  await bump();
  const store = new Store(join(dataDir, "workspace.sqlite")),
    controller = new Controller(store, {});
  const tabs = [],
    prepared = [],
    handoffs = [];
  let jobs = 0,
    stopped = false;
  const coordinator = await new SelfRestart({
    root: source,
    dataDir,
    store,
    controller,
    terminals: { list: () => tabs },
    runtime: { pid: process.pid },
    jobs: () => jobs,
    idleMs: 0,
    prepare: async ({ revision }) => {
      prepared.push(revision);
      return { root: join(dataDir, "self-runtimes", revision), revision };
    },
    handoff: async (spec) => {
      handoffs.push(spec);
      return { pid: process.pid, go() {} };
    },
    shutdown: async () => {
      stopped = true;
    },
    ...options,
  }).init();
  clearInterval(coordinator.timer);
  controller.selfRestart = coordinator;
  const project = store.addProject("Harness fixture", source),
    chat = store.createConversation({ projectId: project.id });
  const f = {
    root,
    source,
    dataDir,
    store,
    controller,
    coordinator,
    project,
    chat,
    tabs,
    prepared,
    handoffs,
    bump,
    get stopped() {
      return stopped;
    },
    set jobs(value) {
      jobs = value;
    },
    async close() {
      await coordinator.close();
      if (f.store) f.store.close();
      const current = await runtimeHealth(dataDir);
      if (current && current.runtime.pid !== process.pid) {
        await fetch(current.runtime.origin + "/internal/shutdown", {
          method: "POST",
          headers: { Authorization: "Bearer " + current.runtime.controlToken },
        });
        for (let i = 0; i < 50 && processAlive(current.runtime.pid); i++)
          await pause(100);
        if (processAlive(current.runtime.pid))
          process.kill(current.runtime.pid);
      }
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}

test("restart requests are scoped to the source, modes are enforced at the controller, and duplicates coalesce", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.coordinator.eligible(f.root, "default"), false);
    for (const mode of ["ask", "plan"]) {
      f.store.updateConversation(f.chat.id, { mode });
      await assert.rejects(
        f.controller.requestSelfRestart(f.chat.id),
        /Default or Goal/,
      );
    }
    f.store.updateConversation(f.chat.id, { mode: "goal" });
    const first = await f.controller.requestSelfRestart(f.chat.id);
    assert.equal(first.queued, true);
    assert.equal(
      (await f.controller.requestSelfRestart(f.chat.id)).id,
      first.id,
    );
    const next = await f.bump();
    assert.equal(
      (
        await f.coordinator.request(f.source, "default", {
          automatic: true,
          commit: next,
        })
      ).id,
      first.id,
    );
    assert.equal(f.coordinator.status().target, next);
    await assert.rejects(
      f.coordinator.request(f.source, "default", {
        automatic: true,
        commit: "a".repeat(40),
      }),
      /moved after delivery/,
    );
  } finally {
    await f.close();
  }
});

test("all chats, durable queues, approvals, terminals and host jobs block switching without interruption", async () => {
  const f = await fixture();
  try {
    const run = f.store.createRun({
      conversationId: f.chat.id,
      actionId: randomUUID(),
      provider: "codex",
      model: "fixture",
      text: "work",
    });
    f.store.setRun(run.id, "completed");
    const approval = f.store.addApproval(f.chat.id, run.id, "codex", {
      title: "Pending",
    });
    const queued = f.store.enqueueInput({
      conversationId: f.chat.id,
      actionId: randomUUID(),
      text: "Next",
      provider: "codex",
      model: "fixture",
    });
    f.controller.active.set("another-project", {});
    f.tabs.push({ status: "running" });
    f.jobs = 1;
    f.controller.tidying.set("cleanup", Promise.resolve());
    await f.coordinator.request(f.source, "default");
    await f.coordinator.tick();
    assert.deepEqual(f.coordinator.status().blockers, [
      "Active chats",
      "Queued messages",
      "Pending approvals",
      "Open terminals",
      "Host work finishing",
    ]);
    assert.equal(f.handoffs.length, 0);
    f.controller.active.clear();
    f.store.deleteQueued(queued.id);
    f.store.resolveApproval(approval.id, { allow: false });
    f.tabs[0].status = "exited";
    f.jobs = 0;
    f.controller.tidying.clear();
    await f.coordinator.tick();
    assert.equal(f.handoffs.length, 1);
    assert.equal(f.handoffs[0].root, f.handoffs[0].fallback.root);
    assert.equal(f.stopped, true);
    assert.equal(f.coordinator.status().status, "restarting");
    assert.equal(
      f.store.conversationSnapshot(f.chat.id).runs[0].status,
      "completed",
    );
    assert.throws(() => f.coordinator.assertAdmission(), /same action ID/);
  } finally {
    await f.close();
  }
});

test("source changes postpone switching and an idle interval is reset by new work", async () => {
  const f = await fixture({ idleMs: 5000 });
  try {
    await f.coordinator.request(f.source, "default");
    await f.coordinator.tick();
    assert.equal(f.handoffs.length, 0);
    f.coordinator.idleSince = Date.now() - 6000;
    f.controller.active.set("new-turn", {});
    await f.coordinator.tick();
    assert.equal(f.coordinator.idleSince, null);
    f.controller.active.clear();
    await writeFile(join(f.source, "change.txt"), "unfinished");
    await f.coordinator.tick();
    assert.match(f.coordinator.status().blockers[0], /Uncommitted/);
    git(f.source, "restore", "change.txt");
    git(f.source, "switch", "-qc", "other");
    await f.coordinator.tick();
    assert.match(f.coordinator.status().blockers[0], /branch/);
  } finally {
    await f.close();
  }
});

test("delivered steer receipts do not block a later safe restart", async () => {
  const f = await fixture();
  try {
    f.store.enqueueInput({
      conversationId: f.chat.id,
      actionId: randomUUID(),
      text: "already delivered",
      provider: "codex",
      model: "fixture",
      status: "steered",
    });
    await f.coordinator.request(f.source, "default");
    await f.coordinator.tick();
    assert.equal(f.stopped, true);
  } finally {
    await f.close();
  }
});

test("Goals block automatic updates without an active run, across projects and mode changes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const f = await fixture({ idleMs: 5000 });
  try {
    const other = f.store.addProject("Other project", f.root);
    const chat = f.store.createConversation({
      projectId: other.id,
      mode: "goal",
    });
    const unused = f.store.createConversation({
      projectId: other.id,
      mode: "goal",
    });
    assert.equal(f.store.restartBlockingGoals().length, 0);
    f.store.setGoalState(chat.id, "codex", "goal-run", "active");
    f.store.updateConversation(chat.id, { mode: "plan", provider: "claude" });
    f.store.setArchived(chat.id, true);
    const commit = await f.bump();
    await f.coordinator.request(f.source, "default", {
      automatic: true,
      commit,
    });
    await f.coordinator.tick();
    t.mock.timers.tick(15000);
    await f.coordinator.tick();
    assert.equal(f.controller.active.size, 0);
    assert.equal(f.store.activeRuns().length, 0);
    assert.equal(f.handoffs.length, 0);
    assert.equal(f.stopped, false);
    assert.deepEqual(f.coordinator.status().blockers, [
      "Unfinished or unconfirmed Goal sessions",
    ]);
    assert.equal(f.store.conversation(unused.id).mode, "goal");
    f.store.setGoalState(chat.id, "codex", "goal-run", "unknown");
    await f.coordinator.tick();
    assert.equal(f.coordinator.idleSince, null);
    f.store.setGoalState(chat.id, "codex", "goal-run", "complete");
    await f.coordinator.tick();
    assert.equal(f.handoffs.length, 0);
    t.mock.timers.tick(4999);
    await f.coordinator.tick();
    assert.equal(f.handoffs.length, 0);
    t.mock.timers.tick(1);
    await f.coordinator.tick();
    assert.equal(f.stopped, true);
  } finally {
    await f.close();
  }
});

test("every Goal must stop and native work must settle before switching", async () => {
  const f = await fixture();
  try {
    const second = f.store.createConversation({
      projectId: f.project.id,
      mode: "goal",
    });
    const run = f.store.createRun({
      conversationId: f.chat.id,
      actionId: randomUUID(),
      provider: "codex",
      model: "fixture",
      text: "Goal",
    });
    f.store.setGoalState(f.chat.id, "codex", run.id, "active");
    f.store.setGoalState(second.id, "claude", "other-goal", "active");
    await f.coordinator.request(f.source, "goal");
    for (const status of [
      "complete",
      "paused",
      "blocked",
      "usageLimited",
      "budgetLimited",
      "cleared",
    ]) {
      f.store.setGoalState(f.chat.id, "codex", run.id, status);
      await f.coordinator.tick();
      assert.equal(f.handoffs.length, 0);
    }
    f.store.setGoalState(second.id, "claude", "other-goal", "complete");
    await f.coordinator.tick();
    assert.deepEqual(f.coordinator.status().blockers, ["Active chats"]);
    assert.equal(f.handoffs.length, 0);
    f.store.setRun(run.id, "completed");
    await f.coordinator.tick();
    assert.equal(f.stopped, true);
  } finally {
    await f.close();
  }
});

test("automatic restart leaves a real Codex runner alive between Goal turns", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const f = await fixture({ idleMs: 5000 });
  const rpc = new EventEmitter(),
    started = Promise.withResolvers(),
    calls = [];
  let closed = false;
  const notify = (method, params) =>
    rpc.emit("notification", {
      method,
      params: { threadId: "goal-session", ...params },
    });
  rpc.close = () => {
    if (closed) return;
    closed = rpc.closed = true;
    rpc.emit("closed", new Error("Fixture closed"));
  };
  rpc.call = async (method, params) => {
    calls.push(method);
    if (method === "account/read")
      return { account: { type: "chatgpt", planType: "pro" } };
    if (method === "account/rateLimits/read")
      return {
        ordinaryUsageAllowed: true,
        rateLimits: {
          primary: { usedPercent: 1 },
          credits: { hasCredits: false, unlimited: false, balance: "0" },
        },
      };
    if (method === "config/read")
      return { config: { model_provider: "openai" } };
    if (method === "thread/start") return { thread: { id: "goal-session" } };
    if (method === "thread/goal/set") {
      setImmediate(() => {
        notify("turn/started", { turn: { id: "goal-turn" } });
        started.resolve();
      });
      return { goal: { status: params.status } };
    }
    assert.fail("Unexpected RPC: " + method);
  };
  try {
    f.controller.providers = [
      {
        id: "codex",
        connected: true,
        models: [{ id: "fixture", efforts: [] }],
      },
    ];
    f.controller.runners.codex = (ctx) =>
      runCodex(ctx, { open: async () => rpc });
    f.store.updateConversation(f.chat.id, { mode: "goal" });
    f.controller.send(f.chat.id, {
      actionId: "goal-restart-end-to-end",
      text: "Finish the goal",
      provider: "codex",
      model: "fixture",
    });
    const work = f.controller.active.get(f.chat.id);
    await started.promise;
    await nextTick();
    notify("turn/completed", {
      turn: { id: "goal-turn", status: "completed" },
    });
    const commit = await f.bump();
    await f.coordinator.request(f.source, "default", {
      automatic: true,
      commit,
    });
    await f.coordinator.tick();
    t.mock.timers.tick(15000);
    await nextTick();
    await f.coordinator.tick();
    assert.equal(f.stopped, false);
    assert.equal(f.handoffs.length, 0);
    assert.equal(work.abort.signal.aborted, false);
    assert.equal(closed, false);
    assert.equal(f.controller.active.get(f.chat.id), work);
    assert.equal(calls.includes("turn/interrupt"), false);
    assert.equal(calls.filter((m) => m === "thread/goal/set").length, 1);
    notify("thread/goal/updated", { goal: { status: "complete" } });
    await work.task;
    assert.equal(f.store.restartBlockingGoals().length, 0);
    await f.coordinator.tick();
    t.mock.timers.tick(5000);
    await f.coordinator.tick();
    assert.equal(f.stopped, true);
  } finally {
    rpc.close();
    await f.controller.close();
    await f.close();
  }
});

test("a Goal appearing during either final restart check cancels the switch", async () => {
  for (const phase of ["source", "helper"]) {
    const f = await fixture();
    let cancelled = false;
    try {
      await f.coordinator.request(f.source, "default");
      const start = () =>
        f.store.setGoalState(f.chat.id, "codex", "late-goal", "active");
      if (phase === "source") {
        let checked = 0;
        const ready = f.coordinator.sourceReady.bind(f.coordinator);
        f.coordinator.sourceReady = async (revision) => {
          const result = await ready(revision);
          if (++checked === 2) start();
          return result;
        };
      } else {
        const handoff = f.coordinator.handoff;
        f.coordinator.handoff = async (spec) => {
          const helper = await handoff(spec);
          start();
          return {
            ...helper,
            cancel() {
              cancelled = true;
            },
          };
        };
      }
      await f.coordinator.tick();
      assert.equal(f.stopped, false);
      assert.equal(f.coordinator.gated, false);
      assert.deepEqual(f.coordinator.status().blockers, [
        "Unfinished or unconfirmed Goal sessions",
      ]);
      if (phase === "helper") assert.equal(cancelled, true);
      else assert.equal(f.handoffs.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("a newer delivery during preparation supersedes the old candidate", async () => {
  const f = await fixture();
  try {
    const first = await f.bump("first");
    let release;
    const normal = f.coordinator.prepare;
    f.coordinator.prepare = async (input) => {
      if (input.revision === first)
        await new Promise((r) => {
          release = r;
        });
      return normal(input);
    };
    await f.coordinator.request(f.source, "default", {
      automatic: true,
      commit: first,
    });
    const preparing = f.coordinator.tick();
    while (!release) await pause(5);
    const newest = await f.bump("second");
    await f.coordinator.request(f.source, "default", {
      automatic: true,
      commit: newest,
    });
    release();
    await preparing;
    assert.equal(f.handoffs.length, 0);
    await f.coordinator.tick();
    assert.equal(f.handoffs[0].candidate.revision, newest);
    assert.equal(f.handoffs[0].fallback.revision, f.coordinator.revision);
  } finally {
    await f.close();
  }
});

test("work admitted during the last source check prevents the handoff", async () => {
  const f = await fixture();
  try {
    await f.coordinator.request(f.source, "default");
    let checked = 0;
    const ready = f.coordinator.sourceReady.bind(f.coordinator);
    f.coordinator.sourceReady = async (revision) => {
      const result = await ready(revision);
      if (++checked === 2) f.jobs = 1;
      return result;
    };
    await f.coordinator.tick();
    assert.equal(f.handoffs.length, 0);
    assert.equal(f.coordinator.gated, false);
    assert.deepEqual(f.coordinator.status().blockers, ["Host work finishing"]);
  } finally {
    await f.close();
  }
});

test("preparation and helper failures retain admission and do not automatically retry the failed revision", async () => {
  for (const failing of ["prepare", "handoff"]) {
    const f = await fixture({
      [failing]: async () => {
        throw new Error("fixture " + failing + " failed");
      },
    });
    try {
      const commit = await f.bump();
      await f.coordinator.request(f.source, "default", {
        automatic: true,
        commit,
      });
      await f.coordinator.tick();
      assert.equal(f.coordinator.status().status, "failed");
      assert.equal(f.coordinator.gated, false);
      assert.equal(f.stopped, false);
      const failedId = f.coordinator.status().id;
      await f.coordinator.request(f.source, "default", {
        automatic: true,
        commit,
      });
      assert.equal(f.coordinator.status().id, failedId);
      assert.equal(f.coordinator.status().status, "failed");
      await f.coordinator.request(f.source, "default");
      assert.notEqual(f.coordinator.status().id, failedId);
    } finally {
      await f.close();
    }
  }
});

test("controller offers the explicit restart tool to a self-editing turn", async () => {
  const f = await fixture();
  try {
    // A legacy shared-folder chat exercises the explicit tool as well.
    f.store.updateConversation(f.chat.id, {
      sessions: { codex: { id: "native" } },
    });
    f.controller.providers = [
      { id: "codex", models: [{ id: "m", efforts: [] }] },
    ];
    let seen;
    f.controller.runners.codex = async (ctx) => {
      seen = ctx;
      assert.ok(ctx.tools.some((t) => t.name === restartTool.name));
      const queued = await ctx.history("restart_harness", {});
      assert.equal(queued.queued, true);
      assert.equal(f.stopped, false);
      return { status: "completed" };
    };
    f.controller.send(f.chat.id, {
      actionId: randomUUID(),
      provider: "codex",
      model: "m",
      text: "Restart when safe",
    });
    await f.controller.active.get(f.chat.id).task;
    assert.ok(seen);
    assert.equal(f.controller.active.size, 0);
  } finally {
    await f.close();
  }
});

test("artifact preparation exports and checks the exact commit without touching live source files", async () => {
  const f = await fixture();
  try {
    const pkg = {
      name: "restart-fixture",
      version: "1.0.0",
      scripts: {
        build: "node -e \"require('fs').mkdirSync('dist')\"",
        test: 'node -e "process.exit(0)"',
      },
    };
    await writeFile(join(f.source, "package.json"), JSON.stringify(pkg));
    await writeFile(
      join(f.source, "package-lock.json"),
      JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        lockfileVersion: 3,
        packages: { "": { name: pkg.name, version: pkg.version } },
      }),
    );
    const revision = await f.bump("checked");
    await writeFile(join(f.source, "change.txt"), "uncommitted must not ship");
    const artifact = await prepareRuntime({
      source: f.coordinator.source,
      revision,
      dataDir: f.dataDir,
    });
    assert.equal(
      await readFile(join(artifact.root, "change.txt"), "utf8"),
      "checked",
    );
    assert.equal(
      await readFile(join(f.source, "change.txt"), "utf8"),
      "uncommitted must not ship",
    );
    assert.equal(
      JSON.parse(await readFile(join(artifact.root, "HARNESS-RUNTIME.json")))
        .checked,
      true,
    );
  } finally {
    await f.close();
  }
});

test("delivering a self-editing worktree automatically queues its landed revision", async () => {
  const f = await fixture();
  try {
    f.controller.worktreeRoot = join(f.root, "worktrees");
    f.controller.providers = [
      { id: "codex", models: [{ id: "m", efforts: [] }] },
    ];
    let landed;
    f.controller.runners.codex = async (ctx) => {
      await writeFile(join(ctx.project.path, "delivered.txt"), "self delivery");
      git(ctx.project.path, "add", ".");
      git(ctx.project.path, "commit", "-qm", "Deliver self change");
      landed = await ctx.history("land_changes", {});
      return { status: "completed" };
    };
    f.controller.send(f.chat.id, {
      actionId: randomUUID(),
      provider: "codex",
      model: "m",
      text: "Ship this change",
    });
    await f.controller.active.get(f.chat.id).task;
    await Promise.all(f.controller.tidying.values());
    assert.equal(landed.landed, true);
    assert.equal(landed.selfRestart.queued, true);
    assert.equal(f.coordinator.status().target, landed.commit);
    assert.equal(f.stopped, false);
  } finally {
    await f.close();
  }
});

async function runtimeFixture(f, revision, kind = "good") {
  const root = join(f.dataDir, "self-runtimes", revision);
  await mkdir(join(root, "src"), { recursive: true });
  await atomicJson(join(root, "HARNESS-RUNTIME.json"), {
    revision,
    source: f.coordinator.source,
    checked: true,
  });
  const stateModule = pathToFileURL(resolve("src/core/restart-state.mjs")).href;
  await writeFile(
    join(root, "src", "server.mjs"),
    `
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readRestartState, writeRestartState } from ${JSON.stringify(stateModule)};
const data = process.env.HARNESS_DATA_DIR, revision = ${JSON.stringify(revision)};
const db = new DatabaseSync(join(data, 'workspace.sqlite'));
if (${JSON.stringify(kind)} === 'bad') {
 db.prepare("UPDATE settings SET value=? WHERE key='sentinel'").run(JSON.stringify('candidate mutation'));
 db.close(); process.exit(23);
}
let gated = !!process.env.HARNESS_RESTART_REQUEST;
const instanceId = randomUUID(), controlToken = randomUUID();
const server = createServer(async (req, res) => {
 res.setHeader('Content-Type', 'application/json');
 if (req.url === '/health') return res.end(JSON.stringify({ app:'Agentic Harness', instanceId, revision, ready:${kind !== "hang"}, acceptingWork:!gated }));
 if (req.headers.authorization !== 'Bearer ' + controlToken) { res.statusCode=401; return res.end('{}'); }
 if (req.url === '/internal/restart/activate') {
  const state = await readRestartState(data); state.active={root:${JSON.stringify(root)},revision}; state.request.status='updated'; delete state.handoff;
  await writeRestartState(data,state); gated=false; return res.end('{}');
 }
 res.end('{}'); if (${JSON.stringify(kind)} !== 'hang') server.close(()=>{db.close();process.exit(0);});
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
await writeFile(join(data,'runtime.json'), JSON.stringify({pid:process.pid,origin:'http://127.0.0.1:'+server.address().port,instanceId,controlToken}));
`,
  );
  return { root, revision };
}
async function handoffFixture(f, kind) {
  const candidate = await runtimeFixture(f, "b".repeat(40), kind),
    fallback = await runtimeFixture(f, "a".repeat(40));
  const requestId = randomUUID(),
    snapshot = join(f.dataDir, "self-restart-" + requestId + ".sqlite");
  f.store.setting("sentinel", "saved");
  f.store.setting("browser-sessions", {
    paired: { expiresAt: Date.now() + 10000 },
  });
  f.store.updateConversation(f.chat.id, {
    sessions: { codex: { id: "keep-native" } },
  });
  await backup(f.store.db, snapshot);
  const state = {
    version: 1,
    source: f.coordinator.source,
    active: fallback,
    previous: fallback,
    request: {
      id: requestId,
      target: candidate.revision,
      status: "restarting",
      blockers: [],
    },
    handoff: {
      pid: process.pid,
      oldPid: 2147483000,
      requestId,
      snapshot,
      candidate,
    },
  };
  await writeRestartState(f.dataDir, state);
  f.store.close();
  f.store = null;
  return {
    dataDir: f.dataDir,
    runtime: { pid: 2147483000 },
    candidate,
    fallback,
    snapshot,
    requestId,
  };
}

test("replacement activates only after readiness and persists the selected runtime", async () => {
  const f = await fixture();
  try {
    const spec = await handoffFixture(f, "good");
    await performRestart(spec, { startupMs: 5000 });
    const state = await readRestartState(f.dataDir),
      current = await runtimeHealth(f.dataDir);
    assert.equal(state.request.status, "updated");
    assert.equal(state.active.root, spec.candidate.root);
    assert.equal(current.health.acceptingWork, true);
    assert.equal(state.handoff, undefined);
    const saved = new Store(join(f.dataDir, "workspace.sqlite"));
    assert.equal(
      saved.conversation(f.chat.id).sessions.codex.id,
      "keep-native",
    );
    saved.close();
  } finally {
    await f.close();
  }
});

test("failed candidate startup restores the private database snapshot and previous runtime", async () => {
  const f = await fixture();
  try {
    const spec = await handoffFixture(f, "bad");
    await performRestart(spec, { startupMs: 5000 });
    const state = await readRestartState(f.dataDir),
      current = await runtimeHealth(f.dataDir);
    assert.equal(state.request.status, "failed");
    assert.equal(state.active.root, spec.fallback.root);
    assert.equal(current.health.revision, spec.fallback.revision);
    const saved = new Store(join(f.dataDir, "workspace.sqlite"));
    assert.equal(saved.setting("sentinel"), "saved");
    assert.ok(saved.setting("browser-sessions").paired);
    assert.equal(
      saved.conversation(f.chat.id).sessions.codex.id,
      "keep-native",
    );
    saved.close();
  } finally {
    await f.close();
  }
});

test("an unready candidate that ignores shutdown is stopped before fallback", async () => {
  const f = await fixture();
  let candidatePid;
  try {
    const spec = await handoffFixture(f, "hang");
    const switching = performRestart(spec, { startupMs: 1000 });
    const deadline = Date.now() + 5000;
    while (!candidatePid && Date.now() < deadline) {
      const current = await runtimeHealth(f.dataDir);
      if (current?.health.revision === spec.candidate.revision)
        candidatePid = current.runtime.pid;
      else await pause(50);
    }
    await switching;
    assert.ok(candidatePid);
    assert.equal(processAlive(candidatePid), false);
    assert.equal((await readRestartState(f.dataDir)).request.status, "failed");
    assert.equal(
      (await runtimeHealth(f.dataDir)).health.revision,
      spec.fallback.revision,
    );
  } finally {
    if (candidatePid && processAlive(candidatePid)) process.kill(candidatePid);
    await f.close();
  }
});

test("a live original process prevents replacement or database restoration", async () => {
  const f = await fixture();
  try {
    const spec = await handoffFixture(f, "good");
    spec.runtime.pid = process.pid;
    await assert.rejects(
      performRestart(spec, { exitMs: 100 }),
      /Original host is still stopping/,
    );
    assert.equal(await runtimeHealth(f.dataDir), null);
  } finally {
    await f.close();
  }
});

test("the detached helper acknowledges readiness and completes a real IPC handoff", async () => {
  const f = await fixture();
  let helper;
  try {
    const spec = await handoffFixture(f, "good");
    spec.root = resolve(".");
    helper = await startRestartHelper(spec);
    const state = await readRestartState(f.dataDir);
    state.handoff.pid = helper.pid;
    await writeRestartState(f.dataDir, state);
    await helper.go();
    const deadline = Date.now() + 10000;
    while ((await readRestartState(f.dataDir)).request.status !== "updated") {
      if (Date.now() > deadline)
        throw new Error(
          await readFile(join(f.dataDir, "self-restart.log"), "utf8"),
        );
      await pause(100);
    }
    while (processAlive(helper.pid) && Date.now() < deadline) await pause(100);
    assert.equal(processAlive(helper.pid), false);
  } finally {
    if (helper && processAlive(helper.pid)) helper.cancel();
    await f.close();
  }
});

test("the real server gates submissions until activation and preserves their action IDs", async () => {
  const f = await fixture();
  try {
    const spec = await handoffFixture(f, "good");
    const runtime = spec.candidate.root;
    await cp(resolve("src"), join(runtime, "src"), { recursive: true });
    await cp(resolve("package.json"), join(runtime, "package.json"));
    await symlink(
      await realpath(resolve("node_modules")),
      join(runtime, "node_modules"),
      "junction",
    );
    await rename(
      join(runtime, "src", "server.mjs"),
      join(runtime, "src", "application.mjs"),
    );
    await writeFile(
      join(runtime, "src", "server.mjs"),
      `
import { createHarness } from './application.mjs';
const app = await createHarness({ startProviders:false, selfRestart:true, exitOnRestart:true });
app.controller.providers=[{id:'codex',name:'Fixture',connected:true,models:[{id:'fixture',efforts:[]}]}];
app.controller.runners.codex=async()=>({status:'completed'});
`,
    );
    const started = await launchRuntime(
      spec.candidate,
      f.dataDir,
      { HARNESS_PORT: "0" },
      spec.requestId,
    );
    let current;
    const deadline = Date.now() + 10000;
    while (!current?.health.ready) {
      current = await runtimeHealth(f.dataDir);
      if (Date.now() > deadline || started.child.exitCode !== null)
        throw new Error(
          await readFile(join(f.dataDir, "host-errors.log"), "utf8"),
        );
      await pause(100);
    }
    assert.equal(current.health.acceptingWork, false);
    const body = {
      actionId: randomUUID(),
      provider: "codex",
      model: "fixture",
      text: "one submission",
    };
    const headers = {
      "Content-Type": "application/json",
      "X-Harness-Client": "1",
    };
    const post = () =>
      fetch(current.runtime.origin + "/api/chats/" + f.chat.id + "/messages", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    assert.equal((await post()).status, 503);
    assert.equal(
      (
        await fetch(current.runtime.origin + "/internal/restart/activate", {
          method: "POST",
          headers,
          body: JSON.stringify({ requestId: spec.requestId }),
        })
      ).status,
      401,
    );
    const activate = await fetch(
      current.runtime.origin + "/internal/restart/activate",
      {
        method: "POST",
        headers: {
          ...headers,
          Authorization: "Bearer " + current.runtime.controlToken,
        },
        body: JSON.stringify({ requestId: spec.requestId }),
      },
    );
    assert.equal(activate.status, 200);
    assert.equal((await post()).status, 202);
    const duplicate = await (await post()).json();
    assert.equal(duplicate.duplicate, true);
    const snapshot = await fetch(
      current.runtime.origin + "/api/chats/" + f.chat.id,
    ).then((r) => r.json());
    assert.equal(snapshot.messages.filter((m) => m.role === "user").length, 1);
    assert.equal(
      snapshot.runs.some((run) => run.status === "interrupted"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("an abandoned helper is recovered only after all known host processes have stopped", async () => {
  const f = await fixture();
  try {
    await handoffFixture(f, "good");
    const state = await readRestartState(f.dataDir);
    state.handoff.pid = 2147483000;
    state.handoff.candidatePid = process.pid;
    await writeRestartState(f.dataDir, state);
    await assert.rejects(recoverAbandonedRestart(f.dataDir), /still running/);
    delete state.handoff.candidatePid;
    await writeRestartState(f.dataDir, state);
    await recoverAbandonedRestart(f.dataDir);
    assert.equal((await readRestartState(f.dataDir)).request.status, "failed");
  } finally {
    await f.close();
  }
});

test("concurrent launchers serialize on the host lock and reclaim a dead owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-host-lock-"));
  try {
    await writeFile(
      join(root, "host-control.lock"),
      JSON.stringify({ pid: 2147483000, id: "dead" }),
    );
    const release = await acquireHostLock(root);
    let acquired = false;
    const second = acquireHostLock(root).then((unlock) => {
      acquired = true;
      return unlock;
    });
    await pause(150);
    assert.equal(acquired, false);
    await release();
    const unlock = await second;
    await unlock();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
