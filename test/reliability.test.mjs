import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { git, workspaceFingerprint } from "../src/core/repository.mjs";
import { executeCommand } from "../src/core/command-tool.mjs";
import {
  checkFreshness,
  commandEvidence,
  reliabilityProjection,
  sessionTiming,
} from "../src/core/reliability.mjs";
import { createHarness } from "../src/server.mjs";

function fixture() {
  const store = new Store(":memory:");
  const controller = new Controller(store, {
    probePath: ".local",
    bridgeUrl: "http://localhost",
  });
  const project = store.addProject("Reliability fixture", process.cwd());
  const chat = store.createConversation({
    projectId: project.id,
    provider: "codex",
    model: "fixture",
  });
  store.updateConversation(chat.id, { sessions: { codex: { id: "native" } } });
  const run = store.createRun({
    conversationId: chat.id,
    actionId: crypto.randomUUID(),
    provider: "codex",
    model: "fixture",
    text: "Fixture",
  });
  const context = (patch = {}) =>
    controller.event(chat.id, run.id, "context-usage", {
      provider: "codex",
      sessionId: "native",
      model: "fixture",
      generation: 0,
      state: "ready",
      basis: "last-request",
      source: "fixture",
      usedTokens: 900000,
      windowTokens: 1000000,
      ...patch,
    });
  return {
    store,
    controller,
    project,
    chat,
    run,
    context,
    read: () => controller.reliability.read(chat.id),
  };
}

test("capacity and session age do not assert reliability; compaction notices deduplicate and survive reload", async () => {
  const f = fixture();
  try {
    f.context();
    f.store.setRun(f.run.id, "completed");
    assert.equal((await f.read()).status, "Not assessed");
    f.context({ generation: 1, state: "compacting" });
    f.context({ generation: 1, state: "compacting" });
    f.context({ generation: 1, usedTokens: 20000 });
    let view = await f.read();
    assert.equal(view.compactions, 1);
    assert.equal(view.notices.length, 1);
    const action = {
      actionId: crypto.randomUUID(),
      kind: "acknowledge",
      targetId: view.notices[0].id,
    };
    await f.controller.reliability.action(f.chat.id, action);
    await f.controller.reliability.action(f.chat.id, action);
    assert.equal(f.store.reliabilityData(f.chat.id).actions.length, 1);
    view = await f.read();
    assert.equal(view.status, "Not assessed");
    assert.equal(view.noticeHistory[0].acknowledged, true);
    f.context({ generation: 2, state: "compacting" });
    assert.equal((await f.read()).notices.length, 1);
    const second = new Controller(f.store, {
      probePath: ".local",
      bridgeUrl: "http://localhost",
    });
    assert.equal((await second.reliability.read(f.chat.id)).compactions, 2);
  } finally {
    f.store.close();
  }
});

test("history collapses samples by completed turn and stops growth at generation and source changes", () => {
  const chat = {
    provider: "codex",
    model: "m",
    created_at: "2026-01-01T00:00:00Z",
    sessions: { codex: { id: "s" } },
  };
  const runs = Array.from({ length: 35 }, (_, i) => ({
    id: String(i),
    status: "completed",
  }));
  const events = runs.flatMap((run, i) =>
    [1, 2].map((sample) => ({
      id: i * 2 + sample,
      type: "context-usage",
      runId: run.id,
      createdAt: "2026-01-01T00:01:00Z",
      payload: {
        provider: "codex",
        model: "m",
        sessionId: "s",
        state: "ready",
        generation: i === 34 ? 1 : 0,
        source: "fixture",
        basis: "last-request",
        usedTokens: i * 100 + sample,
      },
    })),
  );
  const view = reliabilityProjection({ chat, runs, events });
  assert.equal(view.history.length, 30);
  assert.equal(view.history.at(-1).usedTokens, 3402);
  assert.equal(view.growth, null);
  assert.equal(
    reliabilityProjection({ chat, runs, events, model: "another" }).history
      .length,
    0,
  );
});

test("timing unions overlapping runs and treats interruption downtime as unknown", () => {
  const chat = { created_at: "2026-01-01T00:00:00Z" };
  const runs = [
    {
      created_at: chat.created_at,
      ended_at: "2026-01-01T00:02:00Z",
      status: "completed",
    },
    {
      created_at: "2026-01-01T00:01:00Z",
      ended_at: "2026-01-01T00:03:00Z",
      status: "completed",
    },
  ];
  const now = Date.parse("2026-01-01T00:10:00Z");
  assert.deepEqual(sessionTiming(chat, runs, now), {
    activeMs: 180000,
    idleMs: 420000,
    totalMs: 600000,
    incomplete: false,
  });
  runs[1].status = "interrupted";
  runs[1].last_progress_at = "2026-01-01T00:01:30Z";
  assert.equal(sessionTiming(chat, runs, now).idleMs, null);
  assert.equal(sessionTiming(chat, runs, now).activeMs, 120000);
});

test("successful prose and generic provider completion never become passing checks", async () => {
  const f = fixture();
  try {
    f.controller.event(f.chat.id, f.run.id, "work", {
      kind: "host-command",
      id: "plain",
      command: "rg fixture",
      status: "failed",
      exitCode: 1,
    });
    const source = f.controller.event(f.chat.id, f.run.id, "work", {
      provider: "claude",
      kind: "tool",
      item: {
        type: "tool_use",
        name: "Bash",
        id: "native",
        input: { command: "npm test" },
      },
    });
    f.controller.event(f.chat.id, f.run.id, "work", {
      provider: "claude",
      kind: "tool-result",
      toolUseId: "native",
      isError: false,
      item: "Tests passed",
    });
    assert.equal((await f.read()).notices.length, 0);
    await f.controller.reliability.action(f.chat.id, {
      actionId: crypto.randomUUID(),
      kind: "track",
      targetId: "claude:native",
    });
    const check = (await f.read()).checks[0];
    assert.equal(check.outcome, "unknown");
    assert.equal(check.freshness, "Freshness unavailable");
    assert.match(
      f.controller.reliability.evidence(f.chat.id, source.id).text,
      /npm test/,
    );
    assert.equal(
      commandEvidence([
        {
          id: 1,
          payload: {
            kind: "land-result",
            root: "a",
            result: { landed: true, checked: "npm test", commit: "abc1234" },
          },
        },
      ])[0].outcome,
      "passed",
    );
  } finally {
    f.store.close();
  }
});

test("check freshness and superseding failures remain scoped to execution evidence", () => {
  const before = { root: "worktree", hash: "a" };
  const check = { workspaceBefore: before, workspaceAfter: before };
  assert.equal(checkFreshness(check, before), "Workspace matches");
  assert.equal(
    checkFreshness(check, { root: "other", hash: "a" }),
    "Freshness unavailable",
  );
  assert.equal(
    checkFreshness(check, { root: "worktree", hash: "b" }),
    "Workspace changed",
  );
  assert.equal(
    checkFreshness(
      { ...check, workspaceAfter: { root: "worktree", hash: "b" } },
      before,
    ),
    "Changed during check",
  );
  assert.equal(
    checkFreshness({ commit: "abcd123456" }, before),
    "Checked commit abcd123",
  );
});

test("user issues preserve source ownership, resolution history and action idempotency", async () => {
  const f = fixture();
  try {
    const messageId = f.store.addMessage({
      conversationId: f.chat.id,
      runId: f.run.id,
      role: "assistant",
      content: "A claim",
    });
    const action = {
      actionId: crypto.randomUUID(),
      kind: "report",
      messageId,
      category: "Missed requirement",
      note: "Explicitly reported by the user",
    };
    await f.controller.reliability.action(f.chat.id, action);
    await f.controller.reliability.action(f.chat.id, action);
    assert.equal((await f.read()).notices.length, 1);
    await assert.rejects(
      f.controller.reliability.action(f.chat.id, {
        ...action,
        category: "Other",
      }),
      /already used/,
    );
    const other = f.store.createConversation({
      projectId: f.project.id,
      provider: "codex",
      model: "fixture",
    });
    await assert.rejects(
      f.controller.reliability.action(other.id, {
        ...action,
        actionId: crypto.randomUUID(),
      }),
      /outside/,
    );
    await f.controller.reliability.action(f.chat.id, {
      actionId: crypto.randomUUID(),
      kind: "resolve",
      targetId: action.actionId,
    });
    assert.equal((await f.read()).notices.length, 0);
    assert.equal((await f.read()).issues[0].resolved, true);
  } finally {
    f.store.close();
  }
});

test("workspace fingerprints include staged, untracked and committed content and fail closed on limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-evidence-"));
  try {
    await git(root, ["init", "-q"]);
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "tracked.txt"), "initial");
    await git(root, ["add", "."]);
    await git(root, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "initial",
    ]);
    const initial = await workspaceFingerprint(root);
    assert.ok(initial.hash, initial.reason);
    await writeFile(join(root, "untracked.txt"), "one");
    const untracked = await workspaceFingerprint(root);
    assert.notEqual(initial.hash, untracked.hash);
    await writeFile(join(root, "untracked.txt"), "two");
    assert.notEqual(untracked.hash, (await workspaceFingerprint(root)).hash);
    await writeFile(join(root, "tracked.txt"), "staged");
    await git(root, ["add", "tracked.txt"]);
    const staged = await workspaceFingerprint(root);
    await writeFile(join(root, "tracked.txt"), "unstaged");
    assert.notEqual(staged.hash, (await workspaceFingerprint(root)).hash);
    await git(root, ["add", "."]);
    const preCommit = await workspaceFingerprint(root);
    await git(root, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "changed",
    ]);
    const committed = await workspaceFingerprint(root);
    assert.notEqual(preCommit.hash, committed.hash);
    await writeFile(join(root, "ignored.txt"), "ignored");
    assert.equal(committed.hash, (await workspaceFingerprint(root)).hash);
    assert.equal(
      (await workspaceFingerprint(root, { maxFiles: 0 })).hash,
      undefined,
    );
    assert.equal(
      (await workspaceFingerprint(root, { maxBytes: 0 })).hash,
      undefined,
    );
    const events = [];
    await executeCommand(
      { command: "fixture check" },
      {
        project: { path: root, check_command: "fixture check" },
        signal: new AbortController().signal,
        approve: async () => ({ allow: true }),
        emit: (type, payload) => events.push({ type, payload }),
        run: async () => {
          await writeFile(join(root, "tracked.txt"), "changed during check");
          return { exitCode: 0 };
        },
      },
    );
    const recorded = commandEvidence(events)[0];
    assert.equal(recorded.trackedCheck, true);
    assert.equal(
      checkFreshness(recorded, await workspaceFingerprint(root)),
      "Changed during check",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("late workspace reads cannot restore a match after new work, and concurrent refreshes coalesce", async () => {
  const f = fixture();
  try {
    const gate = Promise.withResolvers();
    let calls = 0;
    const reliability = f.controller.reliability;
    reliability.fingerprint = async (root) => {
      calls++;
      if (calls === 1) await gate.promise;
      return { root, hash: calls === 1 ? "old" : "new" };
    };
    const first = reliability.refresh(f.chat.id);
    const shared = reliability.refresh(f.chat.id);
    assert.equal(calls, 1);
    f.controller.event(f.chat.id, f.run.id, "run", { status: "running" });
    const afterChange = reliability.refresh(f.chat.id);
    gate.resolve();
    await Promise.all([first, shared, afterChange]);
    assert.equal(calls, 2);
    assert.equal(reliability.current.get(f.project.path).hash, "new");
  } finally {
    f.store.close();
  }
});

test("pinned native evidence survives history paging, and a later passing check supersedes a failure", () => {
  const workspace = { root: "fixture", hash: "same" };
  const chat = {
    created_at: new Date().toISOString(),
    provider: "codex",
    model: "m",
    sessions: {},
  };
  const pinned = {
    id: "codex:old",
    command: "old command",
    outcome: "unknown",
    eventId: 1,
  };
  assert.equal(
    reliabilityProjection({
      chat,
      actions: [{ kind: "track", targetId: pinned.id, evidence: pinned }],
    }).checks[0].id,
    pinned.id,
  );
  const events = [1, 2].map((id) => ({
    id,
    type: "work",
    payload: {
      kind: "host-command",
      id: String(id),
      command: "check",
      cwd: "fixture",
      trackedCheck: true,
      exitCode: id === 1 ? 1 : 0,
      workspaceBefore: workspace,
      workspaceAfter: workspace,
    },
  }));
  const projection = reliabilityProjection({ chat, events, workspace });
  assert.equal(projection.notices.length, 0);
  assert.equal(projection.checksCurrent, true);
  assert.equal(projection.status, "Not assessed");
  assert.equal(projection.checks.length, 2);
});

test("growth cannot jump over incompatible samples and imported timing stays incomplete", () => {
  const chat = {
    created_at: "2026-01-01T00:00:00Z",
    provider: "codex",
    model: "m",
    sessions: { codex: { id: "s" } },
    timingIncomplete: true,
  };
  const runs = [1, 2, 3].map((id) => ({
    id: String(id),
    status: "completed",
    created_at: chat.created_at,
    ended_at: chat.created_at,
  }));
  const events = runs.map((run, index) => ({
    id: index,
    type: "context-usage",
    runId: run.id,
    payload: {
      state: "ready",
      provider: "codex",
      model: "m",
      sessionId: "s",
      generation: 0,
      basis: "last-request",
      source: index === 1 ? "different" : "same",
      usedTokens: index * 100,
    },
  }));
  const projection = reliabilityProjection({ chat, runs, events });
  assert.equal(projection.growth, null);
  assert.equal(projection.timing.incomplete, true);
  assert.equal(projection.timing.idleMs, null);
});

test("session handoffs are distinct from model selection and missing measurements stay unavailable", async () => {
  const f = fixture();
  try {
    f.context();
    f.context({ model: "other" });
    assert.equal((await f.read()).notices.length, 0);
    f.store.updateConversation(f.chat.id, {
      sessions: { codex: { id: "replacement" } },
    });
    f.context({
      sessionId: "replacement",
      usedTokens: null,
      windowTokens: null,
    });
    const projection = await f.read();
    assert.equal(projection.notices.length, 1);
    assert.equal(projection.notices[0].type, "handoff");
    assert.equal(projection.growth, null);
  } finally {
    f.store.close();
  }
});

test("authenticated reliability API is read-only until explicit annotations and isolates evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-reliability-api-"));
  const app = await createHarness({
    dataDir: directory,
    port: 0,
    startProviders: false,
  });
  try {
    const project = app.store.addProject("fixture", directory);
    const chat = app.store.createConversation({
      projectId: project.id,
      provider: "codex",
      model: "fixture",
    });
    const source = app.controller.event(chat.id, null, "work", {
      kind: "host-command",
      id: "test",
      command: "fixture check",
      exitCode: 0,
      status: "ok",
    });
    const headers = {
      Authorization: "Bearer " + app.auth.pairing(),
      "X-Harness-Client": "1",
      "Content-Type": "application/json",
      Origin: app.runtime.origin,
    };
    const url = app.runtime.origin + `/api/chats/${chat.id}/reliability`;
    assert.equal(
      (
        await fetch(url + "/actions", {
          method: "POST",
          headers: { ...headers, Origin: "https://untrusted.invalid" },
          body: "{}",
        })
      ).status,
      403,
    );
    const before = app.store.latestEventId();
    const read = await fetch(url + "?refresh=1", { headers });
    assert.equal(read.status, 200, await read.clone().text());
    assert.equal((await read.json()).status, "Not assessed");
    assert.equal(app.store.latestEventId(), before);
    const report = await fetch(url + "/actions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        actionId: crypto.randomUUID(),
        kind: "track",
        targetId: "host:test",
      }),
    });
    assert.equal(report.status, 200, await report.clone().text());
    assert.equal(
      (await (await fetch(url, { headers })).json()).checks[0].outcome,
      "passed",
    );
    assert.equal(
      (await fetch(url + "/evidence/" + source.id, { headers })).status,
      200,
    );
    const other = app.store.createConversation({
      projectId: project.id,
      provider: "codex",
      model: "fixture",
    });
    assert.equal(
      (
        await fetch(
          app.runtime.origin +
            `/api/chats/${other.id}/reliability/evidence/${source.id}`,
          { headers },
        )
      ).status,
      400,
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
