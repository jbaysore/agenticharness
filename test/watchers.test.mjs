import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { blockingGoals } from "../src/core/goals.mjs";
import { claudeContent, claudeGoalContext } from "../src/providers/attachments.mjs";
import { killIfMatched } from "../src/core/process-identity.mjs";

const sha = "a".repeat(40);
function fixture({ path = ":memory:", mode = "default", provider = "codex", projectPath = process.cwd(), commands } = {}) {
  let now = Date.now() + 1000,
    reads = 0;
  let result = {
    status: "pending",
    identity: sha,
    sha,
    items: [],
    url: "https://github.com/owner/repo/commit/" + sha,
  };
  let pull = {
    status: "pending",
    reason: null,
    cursor: { commentId: 1, reviewCommentId: 0, reviews: {}, head: sha, state: "open", merged: false },
    items: [],
    sha,
    url: "https://github.com/owner/repo/pull/4",
  };
  const store = new Store(path),
    controller = new Controller(store, {
      watcherOptions: {
        now: () => now,
        github: {
          read: async () => {
            reads++;
            if (result instanceof Error) throw result;
            return structuredClone(result);
          },
          readPull: async () => {
            reads++;
            if (pull instanceof Error) throw pull;
            return structuredClone(pull);
          },
        },
        ...(commands ? { commands } : {}),
      },
    });
  const project = store.addProject("Watch fixture", projectPath, {
    scratch: true,
  });
  const chat = store.createConversation({
    projectId: project.id,
    mode,
    provider,
    model: "fixture",
  });
  controller.providers = ["codex", "claude", "cursor"].map((id) => ({
    id,
    connected: true,
    models: [{ id: "fixture", efforts: [] }],
  }));
  const register = (input = {}, target = chat) => {
    let active = controller.active.get(target.id);
    if (!active) {
      const run = store.createRun({
        conversationId: target.id,
        actionId: randomUUID(),
        provider: "codex",
        model: "fixture",
        text: "Watch CI",
      });
      active = { run, abort: new AbortController() };
      controller.active.set(target.id, active);
    }
    return controller.watchers.create(target.id, {
      repository: "owner/repo",
      commit: sha,
      ...input,
    });
  };
  const end = (target = chat) => {
    const active = controller.active.get(target.id);
    if (active) {
      store.setRun(active.run.id, "completed");
      controller.active.delete(target.id);
    }
  };
  const arm = (watch) => {
    const saved = store.watchStore.get(watch.id);
    saved.armed = true;
    saved.parked = true;
    saved.checkpoint = "The change was pushed; fix CI failures.";
    store.watchStore.save(saved);
    end(store.conversation(saved.chatId));
  };
  return {
    store,
    controller,
    chat,
    register,
    end,
    arm,
    set result(value) {
      result = value;
    },
    get result() {
      return result;
    },
    set pull(value) {
      pull = value;
    },
    get pull() {
      return pull;
    },
    get reads() {
      return reads;
    },
    advance(ms = 60_000) {
      now += ms;
    },
    get now() {
      return now;
    },
    async close() {
      for (const [id, active] of controller.active)
        if (!active.task) end(store.conversation(id));
      await controller.close();
      store.close();
    },
  };
}
const finishRuns = async (controller) => {
  await Promise.all(
    [...controller.active.values()].map((a) => a.task).filter(Boolean),
  );
};
const terminal = (status = "success", extra = {}) => ({
  status,
  identity: sha,
  sha,
  url: "https://github.com/owner/repo/commit/" + sha,
  items: [{ id: "test", name: "tests", state: status, url: null }],
  ...extra,
});

test("host polling uses no model; missing checks stay pending and terminal results need two observations", async () => {
  const f = fixture();
  try {
    let modelCalls = 0;
    f.controller.runners.codex = async () => {
      modelCalls++;
      return { status: "completed" };
    };
    const watch = f.register();
    f.end();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "pending");
    assert.equal(f.store.conversation(f.chat.id).watching, true);
    f.advance();
    f.result = terminal();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "settling");
    f.advance(59_999);
    await f.controller.watchers.tick();
    assert.equal(f.reads, 2);
    f.advance(1);
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "success");
    assert.equal(f.store.conversation(f.chat.id).watching, false);
    assert.equal(modelCalls, 0);
    assert.equal(f.store.conversation(f.chat.id).unread, true);
    f.store.markRead(f.chat.id);
    // Use the simulated clock for the read receipt as well.
    f.store.db
      .prepare("UPDATE conversations SET read_at=? WHERE id=?")
      .run(new Date(f.now + 1).toISOString(), f.chat.id);
    assert.equal(f.store.conversation(f.chat.id).unread, false);
    assert.equal(f.store.conversationSnapshot(f.chat.id).watches.length, 1);
  } finally {
    await f.close();
  }
});

test("identical targets share polling across chats; duplicate registration returns the same ID", async () => {
  const f = fixture();
  try {
    const watch = f.register();
    assert.equal(f.register().id, watch.id);
    const chat2 = f.store.createConversation({
      projectId: f.chat.project_id,
      provider: "codex",
      model: "fixture",
    });
    f.register({}, chat2);
    f.end();
    f.end(chat2);
    await f.controller.watchers.tick();
    assert.equal(f.reads, 1);
    f.advance(10 * 60_000);
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).nextCheckAt, f.now + 120_000);
    f.advance(60 * 60_000);
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).nextCheckAt, f.now + 300_000);
  } finally {
    await f.close();
  }
});

test("late CI changes reset settling; a PR revision change supersedes the saved snapshot", async () => {
  const f = fixture();
  try {
    const w = f.register({ commit: undefined, pr: 12 });
    f.end();
    f.result = terminal();
    await f.controller.watchers.tick();
    f.advance();
    f.result = { ...terminal(), status: "pending" };
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(w.id).status, "pending");
    f.advance();
    f.result = terminal();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(w.id).status, "settling");
    f.advance();
    f.result = terminal("success", { identity: "b".repeat(40) });
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(w.id).status, "superseded");
    assert.equal(f.store.watchStore.get(w.id).delivery, "none");
  } finally {
    await f.close();
  }
});

test("offline retries back off, access errors stop, and expiry never means success", async () => {
  const f = fixture();
  try {
    const w = f.register({ expiryHours: 0.25 });
    f.end();
    f.result = Object.assign(new Error("Offline"), { retryable: true });
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(w.id).nextCheckAt, f.now + 60_000);
    f.advance();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(w.id).nextCheckAt, f.now + 120_000);
    f.advance(15 * 60_000);
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(w.id).status, "expired");
    const w2 = f.register();
    f.end();
    f.advance(10 * 60_000);
    f.result = new Error("Sign in to GitHub CLI");
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(w2.id).status, "error");
    assert.equal(f.store.watchStore.get(w2.id).delivery, "none");
  } finally {
    await f.close();
  }
});

test("cancel and new instructions during an outstanding poll cannot be overwritten", async () => {
  for (const cancel of [true, false]) {
    const f = fixture();
    try {
      const w = f.register({
        resumeOn: ["failure"],
        continuation: "Fix failed CI.",
      });
      f.arm(w);
      const pending = Promise.withResolvers();
      f.controller.watchers.github.read = () => pending.promise;
      const tick = f.controller.watchers.tick();
      if (cancel) f.controller.watchers.cancel(f.chat.id, w.id);
      else f.controller.watchers.invalidate(f.chat.id, "New instruction");
      pending.resolve(terminal("failure"));
      await tick;
      const saved = f.store.watchStore.get(w.id);
      assert.equal(saved.armed, false);
      assert.equal(saved.delivery === "pending", false);
      if (cancel) assert.equal(saved.status, "stopped");
    } finally {
      await f.close();
    }
  }
});

for (const provider of ["codex", "claude"])
  test(`${provider}: yield closes a Goal before parking, preserves its objective and resumes once`, async () => {
    const f = fixture({ mode: "goal", provider });
    try {
      let calls = 0,
        watch,
        followup;
      f.controller.runners[provider] = async (ctx) => {
        calls++;
        if (calls > 1) {
          followup = ctx;
          ctx.goalState("complete");
          return { status: "completed" };
        }
        ctx.goalState("active", "Ship passing CI");
        watch = await ctx.history("watch_github_ci", {
          repository: "owner/repo",
          commit: sha,
          resumeOn: ["complete"],
          continuation: "Fix CI if needed and assess the saved goal.",
        });
        assert.equal(
          (
            await ctx.history("yield_to_watch", {
              ids: [watch.id],
              checkpoint: "Pushed the tested change.",
            })
          ).parked,
          true,
        );
        assert.equal(
          f.store.conversation(f.chat.id).sessions[provider].goal.status,
          "active",
        );
        await new Promise((resolve) =>
          ctx.signal.addEventListener("abort", resolve, { once: true }),
        );
        ctx.watchParked();
        return { status: "cancelled" };
      };
      f.controller.send(f.chat.id, {
        actionId: randomUUID(),
        text: "Ship passing CI",
        provider,
        model: "fixture",
        mode: "goal",
      });
      await finishRuns(f.controller);
      assert.equal(
        f.store.conversation(f.chat.id).sessions[provider].goal.status,
        "waiting",
      );
      assert.equal(
        f.store.conversation(f.chat.id).sessions[provider].goal.objective,
        "Ship passing CI",
      );
      assert.equal(blockingGoals(f.store.conversation(f.chat.id)).length, 0);
      assert.equal(f.controller.active.size, 0);
      f.result = terminal("failure");
      await f.controller.watchers.tick();
      f.advance();
      await f.controller.watchers.tick();
      await finishRuns(f.controller);
      assert.equal(calls, 2);
      assert.equal(followup.resumeGoal, true);
      assert.equal(followup.goalObjective, "Ship passing CI");
      assert.match(followup.text, /Pushed the tested change/);
      if (provider === "claude") {
        const prompt = await claudeContent(followup);
        assert.equal(prompt.split(followup.text).length - 1, 1);
        assert.match(prompt, /Outcome: failure/);
        assert.match(prompt, /Fix CI if needed and assess the saved goal/);
        assert.match(claudeGoalContext(followup), /Full Harness Goal \(binding objective\):\nShip passing CI/);
      }
      const trigger = f.store
        .messages(f.chat.id)
        .findLast((m) => m.role === "user");
      assert.equal(trigger.source, "watcher");
      assert.doesNotMatch(trigger.content, /Checkpoint|untrusted evidence/);
      assert.equal(
        f.store.conversation(f.chat.id).sessions[provider].goal.status,
        "complete",
      );
      await f.controller.watchers.tick();
      assert.equal(calls, 2);
    } finally {
      await f.close();
    }
  });

test("an unconfirmed suspension never releases a Goal or arms a wake", async () => {
  const f = fixture({ mode: "goal" });
  try {
    let watch;
    f.controller.runners.codex = async (ctx) => {
      ctx.goalState("active", "Keep working");
      watch = await ctx.history("watch_github_ci", {
        repository: "owner/repo",
        commit: sha,
        resumeOn: ["complete"],
        continuation: "Assess goal.",
      });
      await ctx.history("yield_to_watch", {
        ids: [watch.id],
        checkpoint: "Waiting",
      });
      throw new Error("Runner connection lost before acknowledgement");
    };
    const run = f.controller.send(f.chat.id, {
      actionId: randomUUID(),
      text: "Keep working",
      provider: "codex",
      model: "fixture",
      mode: "goal",
    });
    await finishRuns(f.controller);
    assert.equal(f.store.run(run.id).status, "failed");
    assert.equal(blockingGoals(f.store.conversation(f.chat.id)).length, 1);
    assert.equal(f.store.watchStore.get(watch.id).armed, false);
  } finally {
    await f.close();
  }
});

test("a passing watch disarms failure-only follow-up and requires no model", async () => {
  const f = fixture();
  try {
    const w = f.register({
      resumeOn: ["failure"],
      continuation: "Fix failures.",
    });
    f.arm(w);
    f.result = terminal("success");
    await f.controller.watchers.tick();
    f.advance();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(w.id).status, "success");
    assert.equal(f.store.watchStore.get(w.id).armed, false);
    assert.equal(f.store.runForAction(`watch-${w.id}`), undefined);
  } finally {
    await f.close();
  }
});

test("Stop, mode changes, queued user instructions and usage exhaustion override automatic follow-up", async () => {
  for (const kind of ["stop", "mode", "user", "usage"]) {
    const f = fixture();
    try {
      let calls = 0;
      f.controller.runners.codex = async () => {
        calls++;
        return { status: "completed" };
      };
      const w = f.register({ resumeOn: ["failure"], continuation: "Fix CI" });
      f.arm(w);
      if (kind === "stop") f.controller.cancel(f.chat.id);
      if (kind === "mode") f.controller.setMode(f.chat.id, "plan");
      if (kind === "user") {
        f.controller.send(f.chat.id, {
          actionId: randomUUID(),
          text: "A newer task",
          provider: "codex",
          model: "fixture",
        });
        await finishRuns(f.controller);
      }
      if (kind === "usage")
        f.store.setUsageStop(f.chat.id, "Included usage ran out");
      f.result = terminal("failure");
      await f.controller.watchers.tick();
      f.advance();
      await f.controller.watchers.tick();
      assert.equal(calls, kind === "user" ? 1 : 0);
      assert.notEqual(f.store.watchStore.get(w.id).delivery, "delivered");
    } finally {
      await f.close();
    }
  }
});

test("only one watcher-triggered agent runs globally and each request can wake at most three times", async () => {
  const f = fixture();
  const stop = Promise.withResolvers(),
    started = Promise.withResolvers();
  try {
    let calls = 0;
    f.controller.runners.codex = async () => {
      calls++;
      started.resolve();
      await stop.promise;
      return { status: "completed" };
    };
    const first = f.register({ resumeOn: ["failure"], continuation: "Fix CI" });
    f.arm(first);
    const chat2 = f.store.createConversation({
      projectId: f.chat.project_id,
      provider: "codex",
      model: "fixture",
    });
    const second = f.register(
      { resumeOn: ["failure"], continuation: "Fix CI" },
      chat2,
    );
    f.arm(second);
    f.result = terminal("failure");
    await f.controller.watchers.tick();
    f.advance();
    await f.controller.watchers.tick();
    await started.promise;
    assert.equal(calls, 1);
    await f.controller.watchers.tick();
    assert.equal(calls, 1);
    stop.resolve();
    await finishRuns(f.controller);
    await f.controller.watchers.tick();
    await finishRuns(f.controller);
    assert.equal(calls, 2);
    const third = f.register({
      commit: "b".repeat(40),
      resumeOn: ["failure"],
      continuation: "Fix CI",
    });
    const saved = f.store.watchStore.get(third.id);
    for (let n = 0; n < 3; n++) {
      const dummy = { ...saved, id: randomUUID(), key: "budget:" + n };
      f.store.watchStore.save(dummy);
      f.store.watchStore.reserve(dummy);
      dummy.status = "stopped";
      f.store.watchStore.save(dummy);
    }
    f.arm(third);
    f.advance();
    await f.controller.watchers.tick();
    f.advance();
    await f.controller.watchers.tick();
    assert.equal(calls, 2);
    assert.match(
      f.store.watchStore.get(third.id).reason,
      /Three automatic continuations/,
    );
  } finally {
    stop.resolve();
    await f.close();
  }
});

test("durable results recover after restart and interrupted agent work is never replayed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-watch-")),
    path = join(directory, "workspace.sqlite");
  let f = fixture({ path });
  try {
    const w = f.register({ resumeOn: ["failure"], continuation: "Fix CI" });
    f.arm(w);
    f.result = terminal("failure");
    await f.controller.watchers.tick();
    const chatId = f.chat.id;
    await f.close();
    f = fixture({ path });
    f.advance();
    f.result = terminal("failure");
    const started = Promise.withResolvers();
    f.controller.runners.codex = async (ctx) => {
      started.resolve();
      await new Promise((resolve) =>
        ctx.signal.addEventListener("abort", resolve, { once: true }),
      );
      return { status: "cancelled" };
    };
    await f.controller.watchers.tick();
    await started.promise;
    const run = f.store.runForAction(`watch-${w.id}`);
    assert.ok(run);
    // Simulate the crash recovery path on saved state, including a delivery
    // receipt that was not persisted after createRun.
    const saved = f.store.watchStore.get(w.id);
    saved.delivery = "pending";
    saved.armed = true;
    f.store.watchStore.save(saved);
    f.controller.cancel(chatId);
    await finishRuns(f.controller);
    saved.delivery = "pending";
    saved.armed = true;
    f.store.watchStore.save(saved);
    await f.close();
    f = fixture({ path });
    let calls = 0;
    f.controller.runners.codex = async () => {
      calls++;
      return { status: "completed" };
    };
    await f.controller.watchers.tick();
    assert.equal(calls, 0);
    assert.equal(f.store.watchStore.get(w.id).delivery, "delivered");
    assert.equal(
      f.store.conversationSnapshot(chatId).watches[0].status,
      "failure",
    );
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Ask and Plan watches only notify, ownership is enforced, and current results do not spawn another turn", async () => {
  const f = fixture({ mode: "plan" });
  try {
    assert.throws(
      () => f.register({ resumeOn: ["failure"], continuation: "Fix CI" }),
      /notification only/,
    );
    const w = f.register();
    assert.throws(
      () =>
        f.controller.watchers.yield(f.chat.id, {
          ids: [w.id],
          checkpoint: "Waiting",
        }),
      /cannot yield/,
    );
    assert.throws(
      () => f.controller.watchers.cancel("other-chat", w.id),
      /not found/,
    );
    f.end();
    f.result = terminal();
    await f.controller.watchers.tick();
    f.advance();
    await f.controller.watchers.tick();
    const active = f.register({ commit: "b".repeat(40) });
    f.controller.setMode(f.chat.id, "default");
    const source = f.controller.active.get(f.chat.id);
    const done = f.store.watchStore.get(w.id);
    done.rootId = source.run.action_id;
    f.store.watchStore.save(done);
    assert.equal(
      f.controller.watchers.yield(f.chat.id, {
        ids: [w.id],
        checkpoint: "Already finished",
      }).parked,
      false,
    );
    assert.equal(f.store.watchStore.get(active.id).armed, false);
  } finally {
    await f.close();
  }
});

const recorded = {
  pid: 42,
  createdAt: "2020-01-01T00:00:00.000Z",
  statusDir: "unused",
};
function commandDouble(identity, read, kills) {
  return {
    start: async () => ({ ...recorded }),
    read,
    identity,
    killIfMatched: (runner) =>
      killIfMatched(runner, {
        identity,
        kill: async (pid) => kills.push(pid),
      }),
  };
}

test("command expiry stops a matching process and leaves a reused process id alone", async () => {
  const kills = [];
  let live = { ...recorded };
  const f = fixture({
    commands: commandDouble(async () => live, async () => ({ done: false }), kills),
  });
  try {
    f.register();
    const matched = await f.controller.watchers.startCommand(
      f.chat.id,
      { expiryHours: 0.25 },
      { command: "echo watched", shell: "cmd", shellName: "Command Prompt", cwd: process.cwd() },
    );
    f.advance(15 * 60_000);
    await f.controller.watchers.tick();
    assert.deepEqual(kills, [42]);
    assert.match(f.store.watchStore.get(matched.id).reason, /command was stopped/);
    kills.length = 0;
    live = { pid: 42, createdAt: "2020-01-01T00:00:05.000Z" };
    const reused = await f.controller.watchers.startCommand(
      f.chat.id,
      { expiryHours: 0.25 },
      { command: "echo again", shell: "cmd", shellName: "Command Prompt", cwd: process.cwd() },
    );
    f.controller.watchers.cancel(f.chat.id, reused.id);
    await Promise.all([...f.controller.watchers.pendingStops]);
    assert.deepEqual(kills, []);
    assert.match(f.store.watchStore.get(reused.id).reason, /not killed/);
  } finally {
    await f.close();
  }
});

test("a command with no exit code is unknown and does not count as success", async () => {
  const f = fixture({
    commands: commandDouble(
      async () => null,
      async () => ({ done: false }),
      [],
    ),
  });
  try {
    f.register();
    const watch = await f.controller.watchers.startCommand(
      f.chat.id,
      {},
      { command: "echo missing", shell: "cmd", shellName: "Command Prompt", cwd: process.cwd() },
    );
    f.end();
    await f.controller.watchers.tick();
    const saved = f.store.watchStore.get(watch.id);
    assert.equal(saved.status, "error");
    assert.match(saved.reason, /exit code is unknown/);
    assert.equal(saved.delivery, "none");
  } finally {
    await f.close();
  }
});

test("a file that does not exist yet can appear, and an escaping ancestor is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-file-")),
    outside = await mkdtemp(join(tmpdir(), "harness-outside-"));
  const f = fixture({ projectPath: root });
  try {
    f.register();
    const watch = await f.controller.watchers.handle(f.chat.id, "watch_file", {
      path: "nested/leaf.txt",
      until: "appears",
    });
    f.end();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "pending");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "leaf.txt"), "ready");
    f.advance(5_000);
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "pending");
    f.advance(5_000);
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "success");
    await symlink(outside, join(root, "link"), "junction");
    f.register();
    await assert.rejects(
      () =>
        f.controller.watchers.handle(f.chat.id, "watch_file", {
          path: "link/secret.txt",
          until: "appears",
        }),
      /escapes the worktree/,
    );
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("an already-merged pull request settles, and a new comment does not fire from the baseline", async () => {
  const f = fixture();
  try {
    f.register();
    const merged = await f.controller.watchers.handle(f.chat.id, "watch_pull_request", {
      repository: "owner/repo",
      pr: 4,
    });
    f.pull = {
      status: "success",
      reason: "Pull request merged.",
      cursor: { commentId: 1, reviewCommentId: 0, reviews: {}, head: sha },
      items: [],
      sha,
      url: "https://github.com/owner/repo/pull/4",
    };
    f.end();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(merged.id).status, "settling");
    f.advance();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(merged.id).status, "success");
    f.register();
    f.pull = {
      status: "pending",
      reason: null,
      cursor: { commentId: 9, reviewCommentId: 0, reviews: {}, head: sha, state: "open", merged: false },
      items: [],
      sha,
      url: "https://github.com/owner/repo/pull/4",
    };
    const quiet = await f.controller.watchers.handle(f.chat.id, "watch_pull_request", {
      repository: "owner/repo",
      pr: 8,
    });
    f.end();
    await f.controller.watchers.tick();
    f.advance();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(quiet.id).status, "pending");
    f.pull = {
      ...f.pull,
      status: "updated",
      reason: "Pull request activity changed.",
      items: [{ id: "comment:10", name: "Ada", state: "comment" }],
    };
    f.advance();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(quiet.id).status, "settling");
    f.advance();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(quiet.id).status, "updated");
  } finally {
    await f.close();
  }
});
