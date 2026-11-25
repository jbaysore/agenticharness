import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { prepareWatchedCommand } from "../src/core/command-tool.mjs";
import { blockingGoals } from "../src/core/goals.mjs";
import {
  quietReviewInterval,
  activeReviewInterval,
  Watchers,
} from "../src/core/watchers.mjs";
import {
  claudeContent,
  claudeGoalContext,
} from "../src/providers/attachments.mjs";
import { runClaude } from "../src/providers/claude.mjs";
import {
  killIfMatched,
  processIdentity,
} from "../src/core/process-identity.mjs";

const sha = "a".repeat(40);
function fixture({
  path = ":memory:",
  mode = "default",
  provider = "codex",
  projectPath = process.cwd(),
  commands,
} = {}) {
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
    cursor: {
      commentId: 1,
      reviewCommentId: 0,
      reviews: {},
      head: sha,
      state: "open",
      merged: false,
    },
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
const startLocalCommand = (f, input = {}) =>
  f.controller.watchers.startCommand(f.chat.id, input, {
    command: "fixture command",
    shell: "cmd",
    shellName: "Command Prompt",
    cwd: process.cwd(),
  });
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
  const f = fixture({ mode: "goal" });
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
    assert.equal(f.store.runForAction(`watch-${w.id}`), undefined);
  } finally {
    await f.close();
  }
});

test("a superseded PR CI watch resumes the waiting Goal once", async () => {
  const f = fixture({ mode: "goal" });
  try {
    let followup;
    f.controller.runners.codex = async (ctx) => {
      assert.equal(followup, undefined);
      followup = ctx;
      return { status: "completed" };
    };
    const w = f.register({
      commit: undefined,
      pr: 12,
      resumeOn: ["complete"],
      continuation: "Assess CI for the Goal.",
    });
    const origin = f.controller.active.get(f.chat.id).run;
    f.store.setGoalState(
      f.chat.id,
      "codex",
      origin.id,
      "waiting",
      "Ship passing CI",
    );
    f.arm(w);
    const url = "https://github.com/owner/repo/pull/12";
    f.result = terminal("failure", {
      url,
      items: [{ id: "stale", name: "Stale CI failure", state: "failure" }],
    });
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(w.id).status, "settling");
    f.advance();
    const nextSha = "b".repeat(40);
    f.result = terminal("pending", { identity: nextSha, sha: nextSha, url });
    await f.controller.watchers.tick();
    await finishRuns(f.controller);
    assert.equal(f.store.watchStore.get(w.id).status, "superseded");
    assert.equal(f.store.watchStore.get(w.id).delivery, "delivered");
    assert.equal(followup.resumeGoal, true);
    assert.equal(followup.goalObjective, "Ship passing CI");
    assert.match(followup.text, /https:\/\/github\.com\/owner\/repo\/pull\/12/);
    assert.match(followup.text, /Verify the intended PR revision/);
    assert.match(followup.text, /The change was pushed/);
    assert.doesNotMatch(followup.text, /Stale CI failure/);
    const run = f.store.runForAction(`watch-${w.id}`);
    assert.ok(run);
    await f.controller.watchers.tick();
    assert.equal(f.store.runForAction(`watch-${w.id}`).id, run.id);
  } finally {
    await f.close();
  }
});

test("PR CI supersession before Goal suspension waits for acknowledgment and survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-watch-"));
  const path = join(directory, "workspace.sqlite");
  let f = fixture({ path, mode: "goal" });
  try {
    const w = f.register({
      commit: undefined,
      pr: 12,
      resumeOn: ["complete"],
      continuation: "Assess CI for the Goal.",
    });
    const { id: chatId } = f.chat;
    const origin = f.controller.active.get(chatId).run;
    f.store.setGoalState(chatId, "codex", origin.id, "active", "Ship passing CI");
    await f.controller.watchers.tick();
    assert.equal(
      f.controller.watchers.yield(chatId, {
        ids: [w.id],
        checkpoint: "Waiting for CI.",
      }).parked,
      true,
    );
    f.advance();
    f.result = terminal("pending", { identity: "b".repeat(40) });
    await f.controller.watchers.tick();
    const superseded = f.store.watchStore.get(w.id);
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.armed, true);
    assert.equal(superseded.delivery, "none");
    assert.equal(f.store.runForAction(`watch-${w.id}`), undefined);
    f.store.setGoalState(chatId, "codex", origin.id, "waiting");
    f.end();
    f.controller.watchers.parked(chatId, [w.id]);
    assert.equal(f.store.watchStore.get(w.id).delivery, "pending");
    await f.close();
    f = fixture({ path });
    let calls = 0;
    f.controller.runners.codex = async () => {
      calls++;
      return { status: "completed" };
    };
    await f.controller.watchers.tick();
    await finishRuns(f.controller);
    await f.controller.watchers.tick();
    assert.equal(calls, 1);
    assert.equal(f.store.watchStore.get(w.id).delivery, "delivered");
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
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
        followup,
        closes = 0;
      f.controller.runners[provider] = async (ctx) => {
        calls++;
        if (calls > 1) {
          followup = ctx;
          ctx.goalState("complete");
          return { status: "completed" };
        }
        const yieldTurn = async () => {
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
        };
        if (provider === "claude")
          return runClaude(ctx, {
            baseOptions: () => ({}),
            readAuth: async () => ({
              loggedIn: true,
              authMethod: "claude.ai",
              apiProvider: "firstParty",
              subscriptionType: "pro",
            }),
            readUsage: async () => ({
              rate_limits_available: true,
              rate_limits: {
                extra_usage: { is_enabled: false, user_disabled: true },
                limits: [{ kind: "five_hour", percent: 1 }],
              },
            }),
            queryFn: ({ prompt }) => ({
              interrupt: async () => {},
              close() {
                closes++;
              },
              async *[Symbol.asyncIterator]() {
                await prompt.next();
                await yieldTurn();
                // The SDK acknowledges interruption but omits a final result.
              },
            }),
          });
        await yieldTurn();
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
      if (provider === "claude") assert.equal(closes, 1);
      assert.equal(f.store.watchStore.get(watch.id).armed, true);
      assert.equal(f.store.watchStore.get(watch.id).parked, true);
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
        assert.match(
          claudeGoalContext(followup),
          /Full Harness Goal \(binding objective\):\nShip passing CI/,
        );
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

for (const provider of ["codex", "claude"])
  test(`${provider}: an owner pause keeps this request's watchers armed, and the first result resumes the Goal`, async () => {
    const f = fixture({ mode: "goal", provider });
    try {
      let calls = 0,
        watch,
        paused,
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
          continuation: "Assess the saved goal.",
        });
        paused = await ctx.history("pause_for_owner", {
          statement: "Retry the six MLB rows in the wizard.",
        });
        // A late yield in the same turn keeps the owner pause.
        const late = await ctx.history("yield_to_watch", {
          ids: [watch.id],
          checkpoint: "Waiting",
        });
        assert.equal(late.parked, true);
        await new Promise((resolve) =>
          ctx.signal.addEventListener("abort", resolve, { once: true }),
        );
        ctx.ownerParked();
        return { status: "cancelled" };
      };
      const run = f.controller.send(f.chat.id, {
        actionId: randomUUID(),
        text: "Ship passing CI",
        provider,
        model: "fixture",
        mode: "goal",
      });
      await finishRuns(f.controller);
      assert.equal(f.store.run(run.id).status, "completed");
      assert.deepEqual(paused.watching, [watch.id]);
      const chat = f.store.conversation(f.chat.id);
      assert.equal(chat.sessions[provider].goal.status, "owner");
      assert.equal(chat.owner_pause, true);
      const saved = f.store.watchStore.get(watch.id);
      assert.equal(saved.armed, true);
      assert.equal(saved.parked, true);
      assert.match(saved.checkpoint, /Paused for the owner/);
      f.result = terminal("success");
      await f.controller.watchers.tick();
      f.advance();
      await f.controller.watchers.tick();
      await finishRuns(f.controller);
      assert.equal(calls, 2);
      assert.equal(followup.resumeGoal, true);
      assert.match(
        followup.text,
        /owner has not yet answered your pause request:\nRetry the six MLB rows/,
      );
    } finally {
      await f.close();
    }
  });

test("a Goal resumed by hand can re-arm its still-running watcher with a yield or an owner pause", async () => {
  for (const how of ["yield", "owner"]) {
    const f = fixture({ mode: "goal" });
    try {
      const watch = f.register({
        resumeOn: ["complete"],
        continuation: "Assess goal.",
      });
      f.end();
      f.controller.watchers.invalidate(
        f.chat.id,
        "New user instructions superseded automatic follow-up.",
      );
      const run = f.store.createRun({
        conversationId: f.chat.id,
        actionId: randomUUID(),
        provider: "codex",
        model: "fixture",
        text: "Resume the paused goal.",
      });
      f.controller.active.set(f.chat.id, { run, abort: new AbortController() });
      if (how === "yield")
        assert.equal(
          f.controller.watchers.yield(f.chat.id, {
            ids: [watch.id],
            checkpoint: "Still waiting",
          }).parked,
          true,
        );
      else
        assert.deepEqual(
          f.controller.watchers.armForOwner(
            f.chat.id,
            f.controller.active.get(f.chat.id),
            "Merge it.",
          ),
          [watch.id],
        );
      const saved = f.store.watchStore.get(watch.id);
      assert.equal(saved.armed, true);
      assert.equal(saved.rootId, run.action_id);
      assert.equal(saved.delivery, "none");
      assert.equal(saved.reason, null);
    } finally {
      await f.close();
    }
  }
});

test("pausing for the owner after yielding in the same turn is refused", async () => {
  const f = fixture({ mode: "goal" });
  try {
    let refused;
    f.controller.runners.codex = async (ctx) => {
      ctx.goalState("active", "Keep working");
      const watch = await ctx.history("watch_github_ci", {
        repository: "owner/repo",
        commit: sha,
        resumeOn: ["complete"],
        continuation: "Assess goal.",
      });
      await ctx.history("yield_to_watch", {
        ids: [watch.id],
        checkpoint: "Waiting",
      });
      refused = await ctx.history("pause_for_owner", {
        statement: "Merge it.",
      });
      await new Promise((resolve) =>
        ctx.signal.addEventListener("abort", resolve, { once: true }),
      );
      ctx.watchParked();
      return { status: "cancelled" };
    };
    f.controller.send(f.chat.id, {
      actionId: randomUUID(),
      text: "Keep working",
      provider: "codex",
      model: "fixture",
      mode: "goal",
    });
    await finishRuns(f.controller);
    assert.match(refused.error, /call only pause_for_owner/);
    assert.equal(
      f.store.conversation(f.chat.id).sessions.codex.goal.status,
      "waiting",
    );
  } finally {
    await f.close();
  }
});

test("an unconfirmed owner pause leaves its watchers notification-only", async () => {
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
      await ctx.history("pause_for_owner", { statement: "Merge it." });
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

test("watcher-triggered agents run independently across chats and each request can wake at most three times", async () => {
  const f = fixture();
  const stop = Promise.withResolvers(),
    started = Promise.withResolvers();
  try {
    let calls = 0;
    f.controller.runners.codex = async () => {
      calls++;
      if (calls === 2) started.resolve();
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
    assert.equal(calls, 2);
    await f.controller.watchers.tick();
    assert.equal(calls, 2);
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

test("command polling recognizes a live process using the real OS identity lookup", async () => {
  const self = await processIdentity(process.pid);
  assert.ok(self);
  const f = fixture({
    commands: {
      start: async () => ({ ...self, statusDir: "unused" }),
      read: async () => ({ done: false }),
      identity: processIdentity,
      killIfMatched: async () =>
        assert.fail("This identity-only test must never kill a process"),
    },
  });
  try {
    f.register();
    const watch = await f.controller.watchers.startCommand(
      f.chat.id,
      {},
      {
        command: "identity-only fixture",
        shell: "cmd",
        shellName: "Command Prompt",
        cwd: process.cwd(),
      },
    );
    f.end();
    await f.controller.watchers.tick();
    const saved = f.store.watchStore.get(watch.id);
    assert.equal(saved.status, "pending");
    assert.equal(saved.runner.released, undefined);
    assert.ok(Number.isFinite(saved.lastCheckedAt));
  } finally {
    await f.close();
  }
});

test("command expiry stops a matching process and leaves a reused process id alone", async () => {
  const kills = [];
  let live = { ...recorded };
  const f = fixture({
    commands: commandDouble(
      async () => live,
      async () => ({ done: false }),
      kills,
    ),
  });
  try {
    f.register();
    const matched = await f.controller.watchers.startCommand(
      f.chat.id,
      { expiryHours: 0.25 },
      {
        command: "echo watched",
        shell: "cmd",
        shellName: "Command Prompt",
        cwd: process.cwd(),
      },
    );
    f.advance(15 * 60_000);
    await f.controller.watchers.tick();
    assert.deepEqual(kills, [42]);
    assert.match(
      f.store.watchStore.get(matched.id).reason,
      /command was stopped/,
    );
    kills.length = 0;
    live = { pid: 42, createdAt: "2020-01-01T00:00:05.000Z" };
    const reused = await f.controller.watchers.startCommand(
      f.chat.id,
      { expiryHours: 0.25 },
      {
        command: "echo again",
        shell: "cmd",
        shellName: "Command Prompt",
        cwd: process.cwd(),
      },
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
      {
        command: "echo missing",
        shell: "cmd",
        shellName: "Command Prompt",
        cwd: process.cwd(),
      },
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

test("a failed process lookup keeps a command watched while its runner heartbeat is fresh", async () => {
  let beat = Date.now();
  const f = fixture({
    commands: {
      ...commandDouble(
        async () => null,
        async () => ({ done: false }),
        [],
      ),
      heartbeat: async () => beat,
    },
  });
  try {
    f.register();
    const watch = await f.controller.watchers.startCommand(
      f.chat.id,
      {},
      {
        command: "echo slow lookup",
        shell: "cmd",
        shellName: "Command Prompt",
        cwd: process.cwd(),
      },
    );
    f.end();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "pending");
    beat = Date.now() - 60_000;
    f.advance();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "error");
  } finally {
    await f.close();
  }
});

test("quiet command watches investigate after ten minutes, using heartbeat without process queries", async () => {
  let f,
    lookups = 0;
  const texts = [];
  f = fixture({
    commands: {
      ...commandDouble(
        async () => {
          lookups++;
          return recorded;
        },
        async () => ({
          done: false,
          heartbeatAt: f.now,
          output: "still waiting",
          outputBytes: 13,
          lastOutputAt: f.now - quietReviewInterval,
        }),
        [],
      ),
    },
  });
  try {
    f.controller.runners.codex = async (ctx) => {
      texts.push(ctx.text);
      return { status: "completed" };
    };
    f.register();
    const watch = await startLocalCommand(f, {
      resumeOn: ["complete"],
      continuation: "Inspect the actual job.",
    });
    f.arm(watch);
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).excerpt, "still waiting");
    f.advance(quietReviewInterval - 1);
    await f.controller.watchers.tick();
    assert.equal(texts.length, 0);
    f.advance(5_000);
    await f.controller.watchers.tick();
    await finishRuns(f.controller);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /Scheduled progress review/);
    assert.match(texts[0], /Inspect the actual job/);
    assert.equal(lookups, 0);
    f.advance(quietReviewInterval);
    await f.controller.watchers.tick();
    assert.equal(
      texts.length,
      1,
      "a review must yield again to authorize more reviews",
    );
  } finally {
    await f.close();
  }
});

test("active command and log watches postpone quiet reviews but still investigate hourly", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-active-watch-"));
  let f,
    outputBytes = 0;
  f = fixture({
    projectPath: root,
    commands: commandDouble(
      async () => recorded,
      async () => ({
        done: false,
        output: "working",
        outputBytes,
        lastOutputAt: f.now,
        heartbeatAt: f.now,
      }),
      [],
    ),
  });
  try {
    const texts = [];
    f.controller.runners.codex = async (ctx) => {
      texts.push(ctx.text);
      return { status: "completed" };
    };
    f.register();
    const command = await startLocalCommand(f, {
      resumeOn: ["complete"],
      continuation: "Inspect command progress.",
    });
    const file = await f.controller.watchers.createFile(f.chat.id, {
      path: "progress.log",
      until: "matches",
      pattern: "DONE",
      resumeOn: ["complete"],
      continuation: "Inspect file progress.",
    });
    f.arm(command);
    f.arm(file);
    for (let step = 1; step <= 12; step++) {
      f.advance(300_000);
      outputBytes++;
      await writeFile(join(root, "progress.log"), "working ".repeat(step));
      await f.controller.watchers.tick();
      await finishRuns(f.controller);
      if (step < 12) assert.equal(texts.length, 0);
    }
    await f.controller.watchers.tick();
    await finishRuns(f.controller);
    assert.equal(texts.length, 2);
    assert.ok(f.store.watchStore.get(file.id).excerpt.includes("working"));
    assert.equal(f.store.watchStore.get(file.id).fileObserved.exists, true);
    assert.equal(f.now - command.reviewedAt, activeReviewInterval);
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("custom command and CI reviews run at their own deadlines", async () => {
  let f;
  f = fixture({
    commands: commandDouble(
      async () => recorded,
      async () => ({
        done: false,
        output: "working",
        outputBytes: f.now,
        lastOutputAt: f.now,
      }),
      [],
    ),
  });
  try {
    const texts = [];
    f.controller.runners.codex = async (ctx) => {
      texts.push(ctx.text);
      return { status: "completed" };
    };
    f.result = {
      ...f.result,
      pollInterval: 900_000,
      items: [{ name: "Build", state: "pending" }],
    };
    const followup = {
      resumeOn: ["complete"],
      continuation: "Check the actual progress.",
      reviewAfterMinutes: 6,
    };
    const ci = f.register(followup);
    const duplicate = f.register({ ...followup, reviewAfterMinutes: 30 });
    assert.equal(duplicate.id, ci.id);
    assert.equal(duplicate.reviewAfterMinutes, 6);
    const command = await startLocalCommand(f, followup);
    await f.controller.watchers.tick();
    f.advance(60_000);
    f.arm(ci);
    f.arm(command);
    f.controller.watchers.parked(f.chat.id, [ci.id, command.id]);
    const deadline = f.now + 360_000;
    assert.equal(f.store.watchStore.get(ci.id).reviewAt, deadline);
    assert.equal(f.store.watchStore.get(command.id).reviewAt, deadline);

    const { github, commands } = f.controller.watchers;
    async function restartWatchers() {
      await f.controller.watchers.close();
      f.controller.watchers = new Watchers(f.controller, {
        now: () => f.now,
        github,
        commands,
      });
    }
    f.advance(359_999);
    await restartWatchers();
    assert.equal(f.store.watchStore.get(ci.id).reviewAt, deadline);
    await f.controller.watchers.tick();
    assert.deepEqual(texts, []);
    f.advance(1);
    await f.controller.watchers.tick();
    await finishRuns(f.controller);
    await f.controller.watchers.tick();
    await finishRuns(f.controller);
    assert.equal(texts.length, 2);
    assert.match(
      texts.find((message) => message.includes(ci.id)),
      /Build: pending/,
    );
    assert.match(
      texts.find((message) => message.includes(command.id)),
      /6-minute review interval/,
    );
    assert.equal(f.reads, 1);

    await restartWatchers();
    f.advance(360_000);
    await f.controller.watchers.tick();
    await finishRuns(f.controller);
    assert.equal(texts.length, 2);
  } finally {
    await f.close();
  }
});

test("custom review rejects invalid intervals and requires armed follow-up", async () => {
  const f = fixture();
  try {
    for (const reviewAfterMinutes of [0, 1.5, 1441, "6", null]) {
      assert.throws(
        () => f.register({ reviewAfterMinutes }),
        /whole number from 1 to 1440/,
      );
    }
    assert.throws(
      () => f.register({ reviewAfterMinutes: 6 }),
      /requires authorized follow-up/,
    );
    const ci = f.register({
      reviewAfterMinutes: 6,
      resumeOn: ["complete"],
      continuation: "Check progress.",
    });
    f.end();
    f.advance(360_000);
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(ci.id).reviews, undefined);
  } finally {
    await f.close();
  }
});

test("review intervals must fit before expiry at registration", async () => {
  const f = fixture({
    commands: { start: async () => assert.fail("Invalid command was launched") },
  });
  const input = {
    reviewAfterMinutes: 1440,
    expiryHours: 24,
    resumeOn: ["complete"],
    continuation: "Check progress.",
  };
  const invalid = /must be shorter than the .* watcher lifetime/;
  try {
    await assert.rejects(
      prepareWatchedCommand(
        { ...input, command: "echo fixture" },
        {
          project: { path: process.cwd() },
          approve: () => assert.fail("Invalid command reached approval"),
          signal: new AbortController().signal,
        },
      ),
      invalid,
    );
    assert.throws(
      () =>
        f.register({ ...input, expiryHours: undefined, reviewAfterMinutes: 360 }),
      invalid,
    );
    await assert.rejects(startLocalCommand(f, input), invalid);
    await assert.rejects(
      f.controller.watchers.createFile(f.chat.id, {
        ...input,
        path: "done.txt",
        until: "appears",
      }),
      invalid,
    );
    assert.deepEqual(f.store.watchStore.list(f.chat.id), []);
    const ci = f.register({
      ...input,
      expiryHours: undefined,
      reviewAfterMinutes: 359,
    });
    assert.equal(ci.reviewAfterMinutes, 359);
  } finally {
    await f.close();
  }
});

for (const phase of ["first yield", "repeat yield", "suspension confirmation"]) {
  test(`a command review can run out of time at ${phase}`, async () => {
    const f = fixture({
      commands: commandDouble(
        async () => ({ ...recorded }),
        async () => ({ done: false }),
        [],
      ),
    });
    try {
      const texts = [];
      f.controller.runners.codex = async (ctx) => {
        texts.push(ctx.text);
        return { status: "completed" };
      };
      const followup = {
        resumeOn: ["complete"],
        continuation: "Check progress.",
      };
      const ci = f.register({ ...followup, reviewAfterMinutes: 1 });
      const command = await startLocalCommand(f, {
        ...followup,
        reviewAfterMinutes: phase === "repeat yield" ? 8 : 14,
        expiryHours: 0.25,
      });
      const watchers = f.controller.watchers;
      const yieldInput = {
        ids: [command.id, ci.id],
        checkpoint: "Waiting for results.",
      };
      const yieldTurn = (input) => watchers.yield(f.chat.id, input);
      const confirmPark = (ids) => {
        clearTimeout(f.controller.active.get(f.chat.id).watchYield.timer);
        f.end();
        watchers.parked(f.chat.id, ids);
      };

      if (phase === "repeat yield") {
        const first = yieldTurn({ ...yieldInput, ids: [command.id] });
        assert.equal(first.parked, true);
        confirmPark(first.ids);
        assert.equal(
          f.store.watchStore.get(command.id).reviewAt,
          f.now + 480_000,
        );
        f.advance(480_000);
        await watchers.tick();
        await finishRuns(f.controller);
        assert.match(texts[0], /Scheduled progress review/);
        const run = f.store.createRun({
          conversationId: f.chat.id,
          actionId: randomUUID(),
          provider: "codex",
          model: "fixture",
          text: "Review",
        });
        f.controller.active.set(f.chat.id, {
          run,
          abort: new AbortController(),
          taskRootId: f.store.watchStore.get(command.id).rootId,
        });
      } else {
        f.advance(phase === "first yield" ? 60_000 : 59_999);
      }

      if (phase !== "suspension confirmation") {
        const before = f.store.watchStore.list(f.chat.id);
        const rejected = yieldTurn(yieldInput);
        assert.equal(rejected.parked, false);
        assert.deepEqual(rejected.reviewUnavailableIds, [command.id]);
        assert.equal(f.controller.active.get(f.chat.id).watchYield, undefined);
        assert.deepEqual(f.store.watchStore.list(f.chat.id), before);
      }
      const accepted = yieldTurn({
        ...yieldInput,
        allowResultOnly: phase !== "suspension confirmation",
      });
      assert.equal(accepted.parked, true);
      if (phase === "suspension confirmation") f.advance(1);
      confirmPark(accepted.ids);
      const saved = f.store.watchStore.get(command.id);
      assert.equal(saved.reviewAt, null);
      assert.match(saved.reviewWarning, /falls at or after expiry/);
      assert.equal(saved.armed, true);
      assert.equal(f.store.watchStore.get(ci.id).reviewAt, f.now + 60_000);

      f.advance(command.expiresAt - f.now);
      await watchers.tick();
      await finishRuns(f.controller);
      await watchers.tick();
      await finishRuns(f.controller);
      assert.equal(f.store.watchStore.get(command.id).status, "expired");
      assert.equal(
        f.store.watchStore.get(command.id).followupStatus,
        "completed",
      );
    } finally {
      await f.close();
    }
  });
}

for (const outcome of ["success", "expired"]) {
  test(`a CI watch that is ${outcome} at the review deadline skips progress review`, async () => {
    const f = fixture();
    try {
      const texts = [];
      f.controller.runners.codex = async (ctx) => {
        texts.push(ctx.text);
        return { status: "completed" };
      };
      if (outcome === "success") f.result = { ...f.result, status: "success" };
      const watch = f.register({
        reviewAfterMinutes: outcome === "success" ? 1 : 14,
        expiryHours: 0.25,
        resumeOn: ["complete"],
        continuation: "Check progress.",
      });
      f.arm(watch);
      if (outcome === "expired") f.advance(60_000);
      f.controller.watchers.parked(f.chat.id, [watch.id]);
      await f.controller.watchers.tick();
      f.advance(outcome === "success" ? 60_000 : 840_000);
      await f.controller.watchers.tick();
      await finishRuns(f.controller);
      const saved = f.store.watchStore.get(watch.id);
      assert.equal(saved.status, outcome);
      assert.equal(saved.reviews, undefined);
      assert.equal(saved.reviewAt, null);
      assert.equal(texts.length, outcome === "success" ? 1 : 0);
      if (outcome === "success") assert.match(texts[0], /Background CI result/);
    } finally {
      await f.close();
    }
  });
}

for (const kind of ["command", "file"])
  for (const outcome of ["error", "expired"]) {
    test(`${kind} ${outcome} resumes armed complete follow-up once`, async () => {
      const root = await mkdtemp(join(tmpdir(), "harness-terminal-watch-"));
      const f = fixture({
        projectPath: root,
        commands: commandDouble(
          async () => (outcome === "error" ? null : recorded),
          async () => ({ done: false }),
          [],
        ),
      });
      try {
        let calls = 0;
        f.controller.runners.codex = async () => {
          calls++;
          return { status: "completed" };
        };
        f.register();
        const input = {
          expiryHours: 0.25,
          resumeOn: ["complete"],
          continuation: "Diagnose the outcome without replaying the command.",
        };
        const watch =
          kind === "command"
            ? await startLocalCommand(f, input)
            : await f.controller.watchers.createFile(f.chat.id, {
                ...input,
                path: "done.txt",
                until: "appears",
              });
        f.arm(watch);
        if (kind === "file" && outcome === "error") {
          const saved = f.store.watchStore.get(watch.id);
          saved.root = join(root, "missing-worktree");
          f.store.watchStore.save(saved);
        }
        if (outcome === "expired") f.advance(900_000);
        await f.controller.watchers.tick();
        await finishRuns(f.controller);
        await f.controller.watchers.tick();
        assert.equal(f.store.watchStore.get(watch.id).status, outcome);
        assert.equal(calls, 1);
        assert.equal(
          f.store.watchStore.get(watch.id).followupStatus,
          "completed",
        );
      } finally {
        await f.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

test("old local watches gain ten-minute reviews without rearming revoked follow-up", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-watch-upgrade-"));
  const f = fixture({ projectPath: root });
  try {
    f.register();
    const watch = await f.controller.watchers.createFile(f.chat.id, {
      path: "old.done",
      until: "appears",
      resumeOn: ["complete"],
      continuation: "Check the producer.",
    });
    f.arm(watch);
    const old = f.store.watchStore.get(watch.id);
    delete old.lastActivityAt;
    delete old.reviewedAt;
    old.reviewAt = f.now + activeReviewInterval;
    f.store.watchStore.save(old);
    await f.controller.watchers.close();
    f.controller.watchers = new Watchers(f.controller, {
      now: () => f.now,
      github: f.controller.watchers.github,
    });
    assert.equal(
      f.store.watchStore.get(watch.id).reviewAt,
      f.now + quietReviewInterval,
    );
    assert.equal(f.store.watchStore.get(watch.id).armed, true);
    const migrated = f.store.watchStore.get(watch.id);
    migrated.armed = false;
    migrated.delivery = "blocked";
    f.store.watchStore.save(migrated);
    await f.controller.watchers.close();
    f.advance(quietReviewInterval * 3);
    f.controller.watchers = new Watchers(f.controller, {
      now: () => f.now,
      github: f.controller.watchers.github,
    });
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).armed, false);
    assert.equal(f.store.watchStore.get(watch.id).reviews, undefined);
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("slow GitHub checks do not block new local checks or duplicate the outstanding request", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-isolated-watch-"));
  const f = fixture({ projectPath: root });
  const remote = Promise.withResolvers();
  let pending;
  try {
    f.register();
    let requests = 0;
    f.controller.watchers.github.read = () => {
      requests++;
      return remote.promise;
    };
    pending = f.controller.watchers.tick();
    await Promise.resolve();
    const file = await f.controller.watchers.createFile(f.chat.id, {
      path: "ready.txt",
      until: "appears",
    });
    await writeFile(join(root, "ready.txt"), "ready");
    await f.controller.watchers.tick();
    f.advance(5_000);
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(file.id).status, "success");
    assert.equal(requests, 1);
  } finally {
    remote.resolve(f.result);
    await pending;
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("timed-out local checks retry three times and cannot overwrite the terminal result later", async () => {
  const late = Promise.withResolvers();
  const f = fixture({
    commands: commandDouble(
      async () => recorded,
      () => late.promise,
      [],
    ),
  });
  try {
    f.controller.watchers.checkTimeoutMs = 15;
    f.register();
    const watch = await startLocalCommand(f);
    f.end();
    for (let check = 1; check <= 3; check++) {
      await f.controller.watchers.tick();
      assert.equal(
        f.store.watchStore.get(watch.id).status,
        check === 3 ? "error" : "retrying",
      );
      f.advance(5_000);
    }
    late.resolve({ done: true, exitCode: 0, output: "late success" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.store.watchStore.get(watch.id).status, "error");
    assert.match(
      f.store.watchStore.get(watch.id).reason,
      /may still be running/,
    );
  } finally {
    late.resolve({ done: false });
    await f.close();
  }
});

test("a final result written during process lookup is collected before reporting a lost runner", async () => {
  let reads = 0;
  const f = fixture({
    commands: commandDouble(
      async () => null,
      async () =>
        ++reads === 1
          ? { done: false }
          : { done: true, exitCode: 0, output: "finished" },
      [],
    ),
  });
  try {
    f.register();
    const watch = await startLocalCommand(f);
    f.end();
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "success");
  } finally {
    await f.close();
  }
});

test("cancel during command startup keeps the cancellation and stops the runner once available", async () => {
  const startup = Promise.withResolvers(),
    kills = [];
  let reads = 0;
  const f = fixture({
    commands: {
      ...commandDouble(
        async () => recorded,
        async () => {
          reads++;
          return { done: false };
        },
        kills,
      ),
      start: () => startup.promise,
    },
  });
  try {
    f.register();
    const pending = startLocalCommand(f);
    const watch = f.store.watchStore
      .list(f.chat.id)
      .find((w) => w.kind === "command");
    await f.controller.watchers.tick();
    assert.equal(reads, 0);
    f.controller.watchers.cancel(f.chat.id, watch.id);
    startup.resolve({ ...recorded });
    await pending;
    await Promise.all([...f.controller.watchers.pendingStops]);
    assert.equal(f.store.watchStore.get(watch.id).status, "stopped");
    assert.deepEqual(kills, [recorded.pid]);
  } finally {
    startup.resolve(recorded);
    await f.close();
  }
});

test("failed agent follow-up is recorded and is never automatically replayed", async () => {
  let calls = 0;
  const f = fixture({
    commands: commandDouble(
      async () => recorded,
      async () => ({ done: true, exitCode: 0, output: "done" }),
      [],
    ),
  });
  try {
    f.controller.runners.codex = async () => {
      calls++;
      return { status: "failed", error: "Simulated provider failure" };
    };
    f.register();
    const watch = await startLocalCommand(f, {
      resumeOn: ["complete"],
      continuation: "Verify the result.",
    });
    f.arm(watch);
    await f.controller.watchers.tick();
    await finishRuns(f.controller);
    const saved = f.store.watchStore.get(watch.id);
    assert.equal(saved.followupStatus, "failed");
    assert.equal(saved.followupError, "Simulated provider failure");
    await f.controller.watchers.tick();
    assert.equal(calls, 1);
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

test("file watches ignore shared-project files and resume once for their worktree sentinel", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-file-worktree-"));
  const projectPath = join(root, "project"),
    worktreePath = join(root, "worktree");
  await Promise.all([mkdir(projectPath), mkdir(worktreePath)]);
  const f = fixture({ projectPath });
  try {
    f.store.updateConversation(f.chat.id, { worktree: { path: worktreePath } });
    let calls = 0;
    f.controller.runners.codex = async () => {
      calls++;
      return { status: "completed" };
    };
    f.register();
    const input = {
      path: "nested/job.done",
      until: "appears",
      resumeOn: ["complete"],
      continuation: "Inspect the job result.",
    };
    const watch = await f.controller.watchers.handle(
      f.chat.id,
      "watch_file",
      input,
    );
    assert.equal(watch.root, worktreePath);
    assert.equal(
      (await f.controller.watchers.handle(f.chat.id, "watch_file", input)).id,
      watch.id,
    );
    f.arm(watch);
    await mkdir(join(projectPath, "nested"));
    await writeFile(join(projectPath, "nested", "job.done"), "wrong job");
    await f.controller.watchers.tick();
    f.advance(5_000);
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "pending");
    assert.equal(calls, 0);
    await mkdir(join(worktreePath, "nested"));
    await writeFile(join(worktreePath, "nested", "job.done"), "ready");
    f.advance(5_000);
    await f.controller.watchers.tick();
    f.advance(5_000);
    await f.controller.watchers.tick();
    await finishRuns(f.controller);
    assert.equal(f.store.watchStore.get(watch.id).status, "success");
    assert.equal(calls, 1);
    f.advance(5_000);
    await f.controller.watchers.tick();
    assert.equal(calls, 1);
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a 12-hour file watch reviews every 30 minutes when rearmed without spending result wakes", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-file-review-"));
  const f = fixture({ projectPath: root });
  try {
    const texts = [];
    f.controller.runners.codex = async (ctx) => {
      texts.push(ctx.text);
      return { status: "completed" };
    };
    f.register();
    const watch = await f.controller.watchers.handle(f.chat.id, "watch_file", {
      path: "frames.done",
      until: "appears",
      resumeOn: ["complete"],
      continuation: "Verify the frame counts.",
      expiryHours: 12,
      reviewAfterMinutes: 30,
    });
    f.arm(watch);
    f.controller.watchers.parked(f.chat.id, [watch.id]);
    await f.controller.watchers.tick();
    const reviewInterval = 30 * 60_000;
    assert.equal(watch.expiresAt, f.now + 12 * 3_600_000);
    f.advance(reviewInterval - 1);
    await f.controller.watchers.tick();
    assert.equal(texts.length, 0);
    f.advance(1);
    // More reviews than the three result wakes a request gets.
    for (let review = 1; review <= 4; review++) {
      if (review > 1) f.advance(reviewInterval);
      await f.controller.watchers.tick();
      await finishRuns(f.controller);
      assert.equal(texts.length, review);
      assert.match(texts.at(-1), /Scheduled progress review/);
      assert.match(texts.at(-1), new RegExp(`Watcher ID: ${watch.id}`));
      assert.match(texts.at(-1), /Verify the frame counts/);
      const saved = f.store.watchStore.get(watch.id);
      assert.equal(saved.status, "pending");
      assert.equal(saved.armed, false);
      // Without a new yield the watch only notifies; no further reviews.
      f.advance(reviewInterval + 5_000);
      await f.controller.watchers.tick();
      await finishRuns(f.controller);
      assert.equal(texts.length, review);
      const run = f.store.createRun({
        conversationId: f.chat.id,
        actionId: randomUUID(),
        provider: "codex",
        model: "fixture",
        text: "Review",
      });
      // The review turn belongs to the same request as the watch.
      f.controller.active.set(f.chat.id, {
        run,
        abort: new AbortController(),
        taskRootId: saved.rootId,
      });
      await f.controller.watchers.handle(f.chat.id, "yield_to_watch", {
        ids: [watch.id],
        checkpoint: "Job still progressing.",
      });
      const active = f.controller.active.get(f.chat.id);
      clearTimeout(active.watchYield.timer);
      assert.equal(f.store.watchStore.get(watch.id).parked, false);
      f.end();
      f.controller.watchers.parked(f.chat.id, [watch.id]);
      assert.equal(f.store.watchStore.get(watch.id).delivery, "none");
      assert.equal(
        f.store.watchStore.get(watch.id).reviewAt,
        f.now + reviewInterval,
      );
    }
    await writeFile(join(root, "frames.done"), "done");
    f.advance(5_000);
    await f.controller.watchers.tick();
    f.advance(5_000);
    await f.controller.watchers.tick();
    await finishRuns(f.controller);
    assert.equal(f.store.watchStore.get(watch.id).status, "success");
    assert.equal(texts.length, 5);
    assert.match(texts.at(-1), /Background file result/);
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("file watches keep their registered directory across restart and chat-folder changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-file-restart-"));
  const projectPath = join(root, "project"),
    worktreePath = join(root, "worktree"),
    otherPath = join(root, "other"),
    path = join(root, "workspace.sqlite");
  await Promise.all([
    mkdir(projectPath),
    mkdir(worktreePath),
    mkdir(otherPath),
  ]);
  let f = fixture({ path, projectPath });
  try {
    f.store.updateConversation(f.chat.id, { worktree: { path: worktreePath } });
    f.register();
    const watch = await f.controller.watchers.handle(f.chat.id, "watch_file", {
      path: "job.done",
      until: "matches",
      pattern: "ready",
    });
    const chatId = f.chat.id;
    f.end();
    f.store.updateConversation(chatId, { worktree: { path: otherPath } });
    await f.close();
    f = fixture({ path, projectPath });
    assert.equal(f.store.watchStore.get(watch.id).root, worktreePath);
    await writeFile(join(otherPath, "job.done"), "ready");
    await f.controller.watchers.tick();
    f.advance(5_000);
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "pending");
    await writeFile(join(worktreePath, "job.done"), "ready");
    f.advance(5_000);
    await f.controller.watchers.tick();
    f.advance(5_000);
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "success");
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy file watches recover their chat directory and discard observations of the wrong folder", async () => {
  for (const ownWorktree of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "harness-file-legacy-"));
    const projectPath = join(root, "project"),
      worktreePath = join(root, "worktree"),
      path = join(root, "workspace.sqlite");
    await Promise.all([mkdir(projectPath), mkdir(worktreePath)]);
    let f = fixture({ path, projectPath });
    try {
      if (ownWorktree)
        f.store.updateConversation(f.chat.id, {
          worktree: { path: worktreePath },
        });
      f.register();
      const watch = await f.controller.watchers.handle(
        f.chat.id,
        "watch_file",
        {
          path: "job.done",
          until: "stable",
          resumeOn: ["complete"],
          continuation: "Inspect the recovered job result.",
        },
      );
      f.arm(watch);
      const legacy = f.store.watchStore.get(watch.id);
      delete legacy.root;
      legacy.key = `file:${f.chat.project_id}:job.done:stable:`;
      legacy.candidate = { fingerprint: "wrong-folder", since: f.now - 60_000 };
      f.store.watchStore.save(legacy);
      await f.close();
      f = fixture({ path, projectPath });
      let calls = 0;
      f.controller.runners.codex = async () => {
        calls++;
        return { status: "completed" };
      };
      const directory = ownWorktree ? worktreePath : projectPath;
      assert.equal(f.store.watchStore.get(watch.id).root, directory);
      assert.equal(f.store.watchStore.get(watch.id).candidate, null);
      await writeFile(join(directory, "job.done"), "ready");
      await f.controller.watchers.tick();
      assert.equal(f.store.watchStore.get(watch.id).status, "pending");
      f.advance(60_000);
      await f.controller.watchers.tick();
      await finishRuns(f.controller);
      assert.equal(f.store.watchStore.get(watch.id).status, "success");
      assert.equal(calls, 1);
    } finally {
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("worktree file watches reject escaping links at registration and on later polls", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-file-containment-"));
  const projectPath = join(root, "project"),
    worktreePath = join(root, "worktree");
  await Promise.all([mkdir(projectPath), mkdir(worktreePath)]);
  const f = fixture({ projectPath });
  try {
    f.store.updateConversation(f.chat.id, { worktree: { path: worktreePath } });
    f.register();
    await symlink(projectPath, join(worktreePath, "outside"), "junction");
    await assert.rejects(
      () =>
        f.controller.watchers.handle(f.chat.id, "watch_file", {
          path: "outside/job.done",
          until: "appears",
        }),
      /escapes the worktree/,
    );
    const watch = await f.controller.watchers.handle(f.chat.id, "watch_file", {
      path: "later/job.done",
      until: "appears",
    });
    f.end();
    await symlink(projectPath, join(worktreePath, "later"), "junction");
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "error");
    assert.match(
      f.store.watchStore.get(watch.id).reason,
      /escapes the worktree/,
    );
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unavailable worktree fails instead of watching the shared project", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-file-missing-root-"));
  const projectPath = join(root, "project"),
    worktreePath = join(root, "worktree");
  await Promise.all([mkdir(projectPath), mkdir(worktreePath)]);
  const f = fixture({ projectPath });
  try {
    f.store.updateConversation(f.chat.id, { worktree: { path: worktreePath } });
    f.register();
    const watch = await f.controller.watchers.handle(f.chat.id, "watch_file", {
      path: "job.done",
      until: "appears",
    });
    await rm(worktreePath, { recursive: true });
    await assert.rejects(
      () =>
        f.controller.watchers.handle(f.chat.id, "watch_file", {
          path: "other.done",
          until: "appears",
        }),
      /worktree could not be resolved/,
    );
    f.end();
    await writeFile(join(projectPath, "job.done"), "wrong job");
    await f.controller.watchers.tick();
    assert.equal(f.store.watchStore.get(watch.id).status, "error");
    assert.match(
      f.store.watchStore.get(watch.id).reason,
      /worktree could not be resolved/,
    );
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an already-merged pull request settles, and a new comment does not fire from the baseline", async () => {
  const f = fixture();
  try {
    f.register();
    const merged = await f.controller.watchers.handle(
      f.chat.id,
      "watch_pull_request",
      {
        repository: "owner/repo",
        pr: 4,
      },
    );
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
      cursor: {
        commentId: 9,
        reviewCommentId: 0,
        reviews: {},
        head: sha,
        state: "open",
        merged: false,
      },
      items: [],
      sha,
      url: "https://github.com/owner/repo/pull/4",
    };
    const quiet = await f.controller.watchers.handle(
      f.chat.id,
      "watch_pull_request",
      {
        repository: "owner/repo",
        pr: 8,
      },
    );
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

test("a Goal cannot yield only to a pull request; the owner pause keeps it armed", async () => {
  const f = fixture({ mode: "goal" });
  try {
    f.register();
    const pr = f.controller.watchers.createPull(f.chat.id, {
      repository: "owner/repo",
      pr: 4,
      resumeOn: ["complete"],
      continuation: "Assess goal.",
    });
    assert.throws(
      () =>
        f.controller.watchers.yield(f.chat.id, {
          ids: [pr.id],
          checkpoint: "Waiting for merge",
        }),
      /pause_for_owner/,
    );
    assert.deepEqual(
      f.controller.watchers.armForOwner(
        f.chat.id,
        f.controller.active.get(f.chat.id),
        "Merge #4.",
      ),
      [pr.id],
    );
  } finally {
    await f.close();
  }
});

test("outside a Goal a pull request watch can still be yielded to", async () => {
  const f = fixture();
  try {
    f.register();
    const pr = f.controller.watchers.createPull(f.chat.id, {
      repository: "owner/repo",
      pr: 4,
      resumeOn: ["complete"],
      continuation: "Check it.",
    });
    assert.equal(
      f.controller.watchers.yield(f.chat.id, {
        ids: [pr.id],
        checkpoint: "Waiting",
      }).parked,
      true,
    );
  } finally {
    await f.close();
  }
});
