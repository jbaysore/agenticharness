import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/core/store.mjs";
import {
  boundHistoryContent,
  historyCall,
  handoffContext,
  historyTools,
  promptDelivery,
  workspaceNotice,
  workspacePeers,
} from "../src/core/history.mjs";
import { pathsOverlap } from "../src/core/repository.mjs";

function legacyNote(
  store,
  { projectId, conversationId = null, content, evidence },
) {
  const id = crypto.randomUUID();
  store.db
    .prepare(
      "INSERT INTO notes(id,project_id,conversation_id,content,evidence,created_at) VALUES(?,?,?,?,?,?)",
    )
    .run(
      id,
      projectId,
      conversationId,
      content,
      JSON.stringify(evidence),
      store.now(),
    );
  return id;
}

test("committed partial messages survive restart; pending work and approvals become interrupted, never replayed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-store-")),
    path = join(directory, "db.sqlite");
  let db = new Store(path);
  const p = db.addProject("Project", "C:\\example"),
    c = db.createConversation({ projectId: p.id });
  const run = db.createRun({
    conversationId: c.id,
    actionId: "restart-action-123",
    provider: "codex",
    model: "m",
    text: "Implement a feature",
  });
  const message = db.addMessage({
    conversationId: c.id,
    runId: run.id,
    role: "assistant",
    provider: "codex",
    content: "Partial answer",
  });
  db.appendMessage(message, " survives");
  const approval = db.addApproval(c.id, run.id, "codex", { command: "write" });
  db.close();
  db = new Store(path);
  assert.equal(db.recover(), 1);
  assert.equal(db.run(run.id).status, "interrupted");
  assert.equal(db.approval(approval.id).status, "expired");
  assert.equal(db.messages(c.id)[1].content, "Partial answer survives");
  assert.equal(db.activeRun(c.id), undefined);
  assert.equal(db.recover(), 0);
  db.close();
  await rm(directory, { recursive: true, force: true });
});
test("idempotent submission does not duplicate a message or run, including after interruption", () => {
  const db = new Store(":memory:"),
    p = db.addProject("P", "C:\\p"),
    c = db.createConversation({ projectId: p.id });
  const request = {
    conversationId: c.id,
    actionId: "same-action-1234",
    provider: "codex",
    model: "m",
    text: "Hello",
  };
  const a = db.createRun(request),
    b = db.createRun(request);
  assert.equal(a.id, b.id);
  assert.equal(b.duplicate, true);
  assert.equal(db.messages(c.id).length, 1);
  db.recover();
  const third = db.createRun(request);
  assert.equal(third.id, a.id);
  assert.equal(third.status, "interrupted");
  db.close();
});
test("concurrent turns in a chat are rejected atomically", () => {
  const db = new Store(":memory:"),
    p = db.addProject("P", "C:\\p"),
    c = db.createConversation({ projectId: p.id });
  db.createRun({
    conversationId: c.id,
    actionId: "action-1",
    provider: "codex",
    model: "m",
    text: "a",
  });
  assert.throws(
    () =>
      db.createRun({
        conversationId: c.id,
        actionId: "action-2",
        provider: "claude",
        model: "m",
        text: "b",
      }),
    /already active/,
  );
  assert.equal(db.messages(c.id).length, 1);
  db.close();
});
test("history tools enforce none/project/all scopes with source attribution", () => {
  const db = new Store(":memory:"),
    a = db.addProject("A", "C:\\a"),
    b = db.addProject("B", "C:\\b");
  const ca = db.createConversation({ projectId: a.id, scope: "project" }),
    ca2 = db.createConversation({ projectId: a.id, scope: "none" }),
    cb = db.createConversation({ projectId: b.id });
  for (const c of [ca, ca2, cb])
    db.addMessage({
      conversationId: c.id,
      role: "assistant",
      provider: "claude",
      content: "The architecture decision is SQLite persistence.",
    });
  assert.equal(
    historyCall(db, ca.id, "history_search", { query: "SQLite" }).length,
    2,
  );
  assert.throws(
    () => historyCall(db, ca.id, "history_read", { conversationId: cb.id }),
    /outside/,
  );
  assert.equal(
    historyCall(db, ca2.id, "history_search", { query: "SQLite" }).length,
    1,
  );
  legacyNote(db, {
    projectId: a.id,
    conversationId: ca.id,
    content: "Another conversation decision",
    evidence: ["source"],
  });
  assert.throws(
    () => historyCall(db, ca2.id, "project_notes", {}),
    /Unknown history tool/,
  );
  assert.doesNotMatch(
    handoffContext(db, ca2, "claude"),
    /Another conversation decision/,
  );
  assert.equal(
    historyCall(db, cb.id, "history_search", { query: "SQLite" }).length,
    3,
  );
  assert.match(
    historyCall(db, cb.id, "history_search", { query: "SQLite" })[0].source,
    /harness:\/\/conversation\//,
  );
  db.close();
});
test("retired Project Log tools are unavailable while conversation and Memory Web tools remain", () => {
  const db = new Store(":memory:"),
    project = db.addProject("P", "C:/p"),
    chat = db.createConversation({ projectId: project.id });
  for (const name of ["project_notes", "project_note_read"]) {
    assert(!historyTools.some((t) => t.name === name));
    assert.throws(
      () => historyCall(db, chat.id, name, {}),
      /Unknown history tool/,
    );
  }
  for (const name of [
    "history_search",
    "history_read",
    "workspace_activity",
    "memory_search",
    "memory_read",
    "memory_write",
  ])
    assert(historyTools.some((t) => t.name === name));
  db.close();
});

test("legacy decisions survive restart without rebuilding their retired index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-retired-decisions-")),
    path = join(directory, "db.sqlite");
  let db = new Store(path);
  try {
    const project = db.addProject("P", "C:/p"),
      chat = db.createConversation({ projectId: project.id });
    const id = legacyNote(db, {
      projectId: project.id,
      conversationId: chat.id,
      content: "Legacy decision",
      evidence: ["harness://conversation/source"],
    });
    const before = db.db.prepare("SELECT * FROM notes WHERE id=?").get(id);
    db.setting("project-log-index-version", 0);
    db.close();
    db = new Store(path);
    assert.deepEqual(
      db.db.prepare("SELECT * FROM notes WHERE id=?").get(id),
      before,
    );
    assert.equal(db.setting("project-log-index-version"), 0);
    assert.equal(
      db.db
        .prepare("SELECT name FROM sqlite_schema WHERE name='notes_fts'")
        .get(),
      undefined,
    );
    assert.equal(typeof db.searchProjectNotes, "undefined");
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("search accepts punctuation safely and indexes updated streaming content", () => {
  const db = new Store(":memory:"),
    p = db.addProject("P", "C:\\p"),
    c = db.createConversation({ projectId: p.id });
  const id = db.addMessage({
    conversationId: c.id,
    role: "assistant",
    content: "old",
  });
  db.replaceMessage(id, "SQLite search persisted");
  assert.equal(db.search('SQLite:* "search"').length, 1);
  assert.equal(db.search("old").length, 0);
  assert.deepEqual(db.search('" * -'), []);
  db.close();
});
test("handoffs carry transcript attribution without injecting unfiltered project notes", () => {
  const db = new Store(":memory:"),
    p = db.addProject("P", "C:\\p"),
    c = db.createConversation({ projectId: p.id });
  db.addMessage({
    conversationId: c.id,
    role: "assistant",
    provider: "codex",
    model: "model-a",
    content: "Validation passed.",
  });
  db.addMessage({ conversationId: c.id, role: "user", content: "Review it" });
  legacyNote(db, {
    projectId: p.id,
    conversationId: c.id,
    content: "Use SQLite",
    evidence: ["src/db.mjs@abc"],
  });
  const result = handoffContext(db, c, "claude");
  assert.match(result, /context handoff/);
  assert.match(result, /model-a/);
  assert.doesNotMatch(result, /Use SQLite|src\/db.mjs@abc/);
  assert.match(result, /Validation passed/);
  db.close();
});
test("upstream reference is directional and never grants write access", () => {
  const db = new Store(":memory:"),
    down = db.addProject("personal", "C:\\personal"),
    up = db.addProject("upstream", "C:\\upstream");
  db.addReference(down.id, { path: up.path, name: up.name, writable: true });
  assert.equal(db.project(down.id).repositories[0].writable, false);
  assert.equal(db.project(up.id).repositories.length, 0);
  db.close();
});
test("workspace peers are the other active chats in the same or a nested folder", () => {
  assert.equal(pathsOverlap("C:\\work\\repo", "C:\\work\\repo"), true);
  assert.equal(pathsOverlap("C:\\work\\repo", "C:\\work\\repo\\pkg"), true);
  assert.equal(pathsOverlap("C:\\work\\repo\\pkg", "C:\\work\\repo"), true);
  assert.equal(pathsOverlap("C:\\work\\repo", "C:\\work\\repo-two"), false);
  assert.equal(pathsOverlap("C:\\work\\repo", "D:\\work\\repo"), false);
  const db = new Store(":memory:"),
    repo = db.addProject("Repo", "C:\\work\\repo"),
    apart = db.addProject("Apart", "C:\\work\\apart");
  const mine = db.createConversation({ projectId: repo.id, title: "Mine" }),
    busy = db.createConversation({ projectId: repo.id, title: "Busy" }),
    secret = db.createConversation({
      projectId: repo.id,
      title: "Private",
      scope: "none",
    }),
    idle = db.createConversation({ projectId: repo.id, title: "Idle" }),
    far = db.createConversation({ projectId: apart.id, title: "Far" });
  const run = (chat, text) =>
    db.createRun({
      conversationId: chat.id,
      actionId: "peer-run-" + chat.title,
      provider: "claude",
      model: "m",
      text,
    });
  run(mine, "My own task");
  run(busy, "Rework   the\nparser " + "x".repeat(400));
  run(secret, "Confidential request");
  run(far, "Elsewhere");
  db.setRun(run(idle, "Finished already").id, "completed");
  const peers = workspacePeers(db, mine.id);
  assert.deepEqual(
    peers.map((p) => p.title),
    ["Busy", "Private"],
  );
  assert.equal(peers[0].request.length, 300);
  assert.equal(peers[1].request, null);
  assert.equal(peers[0].source, `harness://conversation/${busy.id}`);
  assert.deepEqual(historyCall(db, mine.id, "workspace_activity", {}), peers);
  assert.deepEqual(workspacePeers(db, far.id), []);
  assert.ok(historyTools.some((t) => t.name === "workspace_activity"));

  assert.equal(workspaceNotice([], [{ status: " M", file: "a.js" }]), "");
  const changes = Array.from({ length: 45 }, (_, i) => ({
    status: " M",
    file: `src/file-${i}.js`,
  }));
  const notice = workspaceNotice(peers, changes);
  assert.match(notice, /2 other chats are working in this repository/);
  assert.match(notice, /"Busy" \(claude, started .*\): Rework the parser x/);
  assert.match(notice, /"Private" \(claude, started [^)]*\)\n/);
  assert.doesNotMatch(notice, /Confidential/);
  assert.match(notice, /- M src\/file-39\.js\n- and 5 more/);
  assert.match(notice, /commit by explicit path/);
  assert.doesNotMatch(
    workspaceNotice(peers.slice(0, 1), null),
    /uncommitted changes/,
  );
  assert.match(notice, /While they are working/);
  assert.doesNotMatch(
    workspaceNotice(peers, changes, { rules: false }),
    /While they are working/,
  );
  db.close();
});
test("a chat summary follows its newest turn: running, needs approval, unread, failed", () => {
  const db = new Store(":memory:"),
    p = db.addProject("P", "C:\\p"),
    c = db.createConversation({ projectId: p.id });
  const summary = () => {
    const { status, unread } = db.conversations().find((x) => x.id === c.id);
    return { status, unread };
  };
  assert.deepEqual(summary(), { status: "idle", unread: false });
  const run = db.createRun({
    conversationId: c.id,
    actionId: "summary-action-1",
    provider: "codex",
    model: "m",
    text: "a",
  });
  assert.deepEqual(summary(), { status: "running", unread: false });
  db.addApproval(c.id, run.id, "codex", { command: "write" });
  db.setRun(run.id, "waiting");
  assert.deepEqual(summary(), { status: "needs-approval", unread: false });
  db.expireApprovals(run.id);
  db.setRun(run.id, "completed");
  assert.deepEqual(summary(), { status: "idle", unread: true });
  assert.equal(db.conversationSnapshot(c.id).unread, true);
  db.db
    .prepare("UPDATE conversations SET read_at=? WHERE id=?")
    .run("9999-01-01T00:00:00.000Z", c.id);
  assert.deepEqual(summary(), { status: "idle", unread: false });
  db.db.prepare("UPDATE conversations SET read_at=NULL WHERE id=?").run(c.id);
  const failed = db.createRun({
    conversationId: c.id,
    actionId: "summary-action-2",
    provider: "claude",
    model: "m",
    text: "b",
  });
  db.setRun(failed.id, "failed", null, "Out of usage");
  assert.deepEqual(summary(), { status: "failed", unread: true });
  assert.equal(db.conversation(c.id).last_error, "Out of usage");
  db.close();
});
test("a usage stop is remembered until it is dismissed, without reordering the chat", () => {
  const db = new Store(":memory:"),
    p = db.addProject("P", "C:\\usage-stop"),
    chat = db.createConversation({ projectId: p.id });
  const before = chat.updated_at;
  const flagged = db.setUsageStop(
    chat.id,
    "Included Codex quota is exhausted.",
  );
  assert.ok(flagged.usage_stopped_at);
  assert.equal(
    flagged.usage_stopped_reason,
    "Included Codex quota is exhausted.",
  );
  assert.equal(flagged.updated_at, before);
  assert.throws(() => db.setUsageStop(chat.id, "  "), /reason/);
  const cleared = db.clearUsageStop(chat.id);
  assert.equal(cleared.usage_stopped_at, null);
  assert.equal(cleared.usage_stopped_reason, null);
  assert.equal(cleared.updated_at, before);
  db.close();
});
test("dismissing a usage stop acknowledges only that run and keeps its history", () => {
  const db = new Store(":memory:"),
    chat = db.createConversation({
      projectId: db.addProject("P", "C:\\dismiss-usage").id,
    });
  try {
    const run = db.createRun({
      conversationId: chat.id,
      actionId: "dismiss-usage-first",
      provider: "codex",
      model: "m",
      text: "Continue",
    });
    db.setRun(run.id, "failed", null, "Included Codex quota is exhausted.");
    db.setUsageStop(chat.id, "Included Codex quota is exhausted.");
    const before = db.conversation(chat.id).updated_at;
    for (let i = 0; i < 2; i++) {
      const dismissed = db.dismissUsageStop(chat.id);
      assert.equal(dismissed.usage_stopped_at, null);
      assert.equal(dismissed.usage_stopped_reason, null);
      assert.equal(dismissed.usage_dismissed_run_id, run.id);
      assert.equal(dismissed.updated_at, before);
      assert.equal(db.run(run.id).error, "Included Codex quota is exhausted.");
    }
    const next = db.createRun({
      conversationId: chat.id,
      actionId: "dismiss-usage-next",
      provider: "codex",
      model: "m",
      text: "Try again",
    });
    // Dismissing an older reminder during startup cannot acknowledge the new run.
    db.setUsageStop(chat.id, "Included Codex quota is exhausted.");
    assert.equal(db.dismissUsageStop(chat.id).usage_dismissed_run_id, run.id);
    db.setRun(next.id, "failed", null, "Provider unavailable");
    db.dismissUsageStop(chat.id);
    assert.notEqual(db.conversation(chat.id).usage_dismissed_run_id, next.id);
    db.setUsageStop(chat.id, "Included Codex quota is exhausted.");
    assert.equal(db.conversation(chat.id).usage_dismissed_run_id, null);
  } finally {
    db.close();
  }
});

test("reopening repairs proven replayed Goal usage failures and preserves genuine or unverified stops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-usage-repair-")),
    path = join(dir, "workspace.sqlite"),
    fixtures = [];
  let db = new Store(path);
  try {
    const project = db.addProject("Usage repair", dir);
    for (const kind of [
      "replayed",
      "dismissed",
      "billing",
      "error",
      "exhausted",
      "unverified",
      "no-history",
      "still-limited",
      "newer-failure",
    ]) {
      const chat = db.createConversation({ projectId: project.id }),
        run = db.createRun({
          conversationId: chat.id,
          actionId: "usage-repair-" + kind,
          provider: "codex",
          model: "m",
          text: "Continue the goal",
        });
      for (const status of ["usageLimited", "active", "complete"]) {
        const updated = db.setGoalState(chat.id, "codex", run.id, status);
        if (kind !== "no-history")
          db.appendEvent(chat.id, run.id, "chat", updated);
      }
      db.appendEvent(chat.id, run.id, "usage", {
        authoritative: kind !== "unverified",
        ordinaryUsageAllowed: true,
        windows: [{ usedPercent: kind === "exhausted" ? 100 : 61 }],
      });
      if (["billing", "error"].includes(kind))
        db.appendEvent(chat.id, run.id, "work", {
          kind: kind === "billing" ? "billing-stop" : "error",
          reason: "A provider usage limit has been reached.",
        });
      if (kind === "still-limited")
        db.setGoalState(chat.id, "codex", run.id, "usageLimited");
      db.setRun(
        run.id,
        "failed",
        null,
        "A provider usage limit has been reached.",
      );
      db.setUsageStop(chat.id, "A provider usage limit has been reached.");
      if (kind === "dismissed") db.dismissUsageStop(chat.id);
      if (kind === "newer-failure") {
        const next = db.createRun({
          conversationId: chat.id,
          actionId: "usage-repair-newer-run",
          provider: "codex",
          model: "m",
          text: "Another task",
        });
        db.setRun(
          next.id,
          "failed",
          null,
          "Included Codex quota is exhausted.",
        );
        db.setUsageStop(chat.id, "Included Codex quota is exhausted.");
      }
      fixtures.push({
        kind,
        chatId: chat.id,
        runId: run.id,
        before: db.conversation(chat.id),
        endedAt: db.run(run.id).ended_at,
      });
    }
    db.close();
    db = new Store(path);
    for (const f of fixtures) {
      const repaired = ["replayed", "dismissed", "newer-failure"].includes(
          f.kind,
        ),
        chat = db.conversation(f.chatId),
        run = db.run(f.runId);
      assert.equal(run.status, repaired ? "completed" : "failed", f.kind);
      assert.equal(
        run.error,
        repaired ? null : "A provider usage limit has been reached.",
        f.kind,
      );
      assert.equal(run.ended_at, f.endedAt, f.kind);
      assert.equal(chat.updated_at, f.before.updated_at, f.kind);
      if (["replayed", "dismissed"].includes(f.kind)) {
        assert.equal(chat.usage_stopped_at, null, f.kind);
        assert.equal(chat.usage_dismissed_run_id, null, f.kind);
      } else {
        assert.equal(chat.usage_stopped_at, f.before.usage_stopped_at, f.kind);
        assert.equal(
          chat.usage_stopped_reason,
          f.before.usage_stopped_reason,
          f.kind,
        );
      }
    }
    db.repairReplayedGoalUsageStops();
    assert.equal(db.run(fixtures[0].runId).status, "completed");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("marking read and archiving leave the conversation order alone", () => {
  const db = new Store(":memory:"),
    p = db.addProject("P", "C:\\p"),
    older = db.createConversation({ projectId: p.id }),
    newer = db.createConversation({ projectId: p.id });
  db.stampConversation(
    older.id,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  db.markRead(older.id);
  db.setArchived(older.id, true);
  const [first, second] = db.conversations();
  assert.equal(first.id, newer.id);
  assert.equal(second.updated_at, "2026-01-01T00:00:00.000Z");
  assert.ok(second.archived_at);
  assert.ok(second.read_at);
  db.setArchived(older.id, false);
  assert.equal(db.conversation(older.id).archived_at, null);
  db.close();
});
test("pinning floats a chat without moving its activity time", () => {
  const db = new Store(":memory:"),
    p = db.addProject("P", "C:\\p"),
    older = db.createConversation({ projectId: p.id, title: "Older" }),
    newer = db.createConversation({ projectId: p.id, title: "Newer" });
  db.stampConversation(
    older.id,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  const pinAt = (id, at) =>
    db.db
      .prepare("UPDATE conversations SET pinned_at=? WHERE id=?")
      .run(at, id);
  db.setPinned(older.id, true);
  const [first, second] = db.conversations();
  assert.equal(first.id, older.id);
  assert.equal(first.updated_at, "2026-01-01T00:00:00.000Z");
  assert.ok(first.pinned_at);
  assert.equal(second.id, newer.id);
  assert.equal(second.pinned_at, null);
  pinAt(older.id, "2026-01-02T00:00:00.000Z");
  db.setPinned(newer.id, true);
  pinAt(newer.id, "2026-01-03T00:00:00.000Z");
  const pinned = db.conversations();
  assert.equal(pinned[0].id, newer.id);
  assert.equal(pinned[1].id, older.id);
  db.setPinned(older.id, false);
  const after = db.conversations();
  assert.equal(after[0].id, newer.id);
  assert.equal(after[1].id, older.id);
  assert.equal(after[1].updated_at, "2026-01-01T00:00:00.000Z");
  assert.equal(db.conversation(older.id).pinned_at, null);
  db.setPinned(older.id, true);
  db.setArchived(older.id, true);
  pinAt(older.id, "2026-02-01T00:00:00.000Z");
  assert.ok(db.conversation(older.id).pinned_at);
  assert.ok(db.conversation(older.id).archived_at);
  assert.equal(db.conversations()[0].id, older.id);
  db.close();
});
test("an unused empty chat can be discarded, but started or kept chats cannot", () => {
  const db = new Store(":memory:"),
    p = db.addProject("P", "C:\\p"),
    empty = db.createConversation({ projectId: p.id }),
    named = db.createConversation({ projectId: p.id, title: "Keep me" }),
    messaged = db.createConversation({ projectId: p.id }),
    pinned = db.createConversation({ projectId: p.id }),
    archived = db.createConversation({ projectId: p.id }),
    resumed = db.createConversation({ projectId: p.id });
  db.addMessage({
    conversationId: messaged.id,
    role: "user",
    content: "Hello",
  });
  db.setPinned(pinned.id, true);
  db.setArchived(archived.id, true);
  db.updateConversation(resumed.id, { sessions: { codex: { id: "native" } } });
  db.discardUnusedConversation(empty.id);
  assert.equal(db.conversation(empty.id), undefined);
  db.discardUnusedConversation(named.id);
  assert.equal(db.conversation(named.id), undefined);
  assert.throws(
    () => db.discardUnusedConversation(messaged.id),
    /already has messages/,
  );
  assert.throws(
    () => db.discardUnusedConversation(pinned.id),
    /Unpin this chat/,
  );
  assert.throws(() => db.discardUnusedConversation(archived.id), /archived/);
  assert.throws(
    () => db.discardUnusedConversation(resumed.id),
    /already has messages/,
  );
  assert.throws(
    () => db.discardUnusedConversation("missing"),
    /Conversation not found/,
  );
  db.close();
});
test("an existing workspace gains the chat columns with its history already read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-migrate-")),
    path = join(directory, "db.sqlite"),
    old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, repositories TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
    CREATE TABLE conversations(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, scope TEXT NOT NULL DEFAULT 'project', sessions TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE runs(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), action_id TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, native_turn_id TEXT, created_at TEXT NOT NULL, ended_at TEXT);
    INSERT INTO projects VALUES('p','P','C:\\p','[]','2026-01-01T00:00:00.000Z');
    INSERT INTO conversations VALUES('c','p','Earlier work','codex','m',NULL,'project','{}','2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z');
    INSERT INTO runs VALUES('r','c','old-action','codex','m','completed',NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:05:00.000Z');
  `);
  old.close();
  let db = new Store(path);
  const chat = db.conversation("c");
  assert.equal(chat.scope, "project");
  assert.deepEqual(db.settings(), { defaultHistoryScope: "all" });
  assert.equal(chat.read_at, "2026-01-02T00:00:00.000Z");
  assert.equal(chat.archived_at, null);
  assert.equal(chat.pinned_at, null);
  assert.deepEqual(
    { status: chat.status, unread: chat.unread },
    { status: "idle", unread: false },
  );
  db.close();
  db = new Store(path);
  assert.equal(db.conversation("c").read_at, "2026-01-02T00:00:00.000Z");
  db.close();
  await rm(directory, { recursive: true, force: true });
});

test("an agent names a chat once from its first message and never replaces the user's title", () => {
  const db = new Store(":memory:"),
    p = db.addProject("Project", "C:\example");
  const start = (chat, text) =>
    db.createRun({
      conversationId: chat.id,
      actionId: "rename-" + chat.id,
      provider: "claude",
      model: "m",
      text,
    });
  const named = db.createConversation({ projectId: p.id });
  start(
    named,
    "Could you please look into why the sidebar flickers on resize?",
  );
  assert.deepEqual(
    historyCall(db, named.id, "rename_chat", {
      title: ' "Fix sidebar flicker." ',
    }),
    { renamed: true, title: "Fix sidebar flicker" },
  );
  assert.equal(db.conversation(named.id).title, "Fix sidebar flicker");
  const again = historyCall(db, named.id, "rename_chat", { title: "Other" });
  assert.equal(again.renamed, false);
  assert.equal(db.conversation(named.id).title, "Fix sidebar flicker");

  const mine = db.createConversation({ projectId: p.id });
  start(mine, "Some request");
  db.updateConversation(mine.id, { title: "My name" });
  assert.equal(
    historyCall(db, mine.id, "rename_chat", { title: "Agent name" }).renamed,
    false,
  );
  assert.equal(db.conversation(mine.id).title, "My name");
  assert.throws(() => historyCall(db, named.id, "rename_chat", { title: " " }));
  assert.ok(historyTools.some((t) => t.name === "rename_chat"));
});

test("saved steps remember which reply they followed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-store-")),
    db = new Store(join(directory, "db.sqlite"));
  const p = db.addProject("Project", "C:\example"),
    c = db.createConversation({ projectId: p.id }),
    run = db.createRun({
      conversationId: c.id,
      actionId: "steps-after-1",
      provider: "claude",
      model: "m",
      text: "Fix it",
    });
  const read = (id) => ({
    kind: "tool",
    provider: "claude",
    item: { type: "tool_use", id, name: "Read", input: { file_path: id } },
  });
  db.appendEvent(c.id, run.id, "work", read("a"));
  db.appendEvent(c.id, run.id, "text", { messageId: "m1", delta: "Looking" });
  db.appendEvent(c.id, run.id, "text", { messageId: "m1", delta: " closer" });
  db.appendEvent(c.id, run.id, "work", read("b"));
  db.appendEvent(c.id, run.id, "text", { messageId: "m2", delta: "Done" });
  assert.deepEqual(
    db.steps(c.id)[run.id].map((s) => [s.target, s.after]),
    [
      ["a", null],
      ["b", "m1"],
    ],
  );
  db.close();
  await rm(directory, { recursive: true, force: true });
});

test("history_read caps each page and can return windows around a query", () => {
  const db = new Store(":memory:"),
    project = db.addProject("P", "C:\\p"),
    chat = db.createConversation({ projectId: project.id });
  const long = "alpha " + "x".repeat(5000) + " NEEDLE " + "y".repeat(5000);
  for (let i = 0; i < 5; i++)
    db.addMessage({
      conversationId: chat.id,
      role: "assistant",
      provider: "codex",
      content: i === 4 ? long : `note ${i}`,
    });
  const page = historyCall(db, chat.id, "history_read", {
    conversationId: chat.id,
  });
  assert.equal(page.messages.length, 4);
  assert.equal(page.nextOffset, 4);
  const around = historyCall(db, chat.id, "history_read", {
    conversationId: chat.id,
    offset: 4,
    query: "NEEDLE",
  });
  assert.match(around.messages[0].content, /NEEDLE/);
  assert.ok(around.messages[0].content.length <= 2000);
  assert.equal(around.messages[0].truncated, true);
  assert.equal(boundHistoryContent("short", "").truncated, false);
  const handoff = handoffContext(db, chat, "claude");
  assert.ok(handoff.length <= 16000);
  db.close();
});

test("Cursor is given the standing prompt only when its hash changes", () => {
  const prefix = "Standing prompt",
    first = promptDelivery({
      provider: "cursor",
      session: {},
      prefix,
      addendum: "Notice",
    });
  assert.equal(first.instructions, prefix);
  assert.equal(first.addendum, "Notice");
  const again = promptDelivery({
    provider: "cursor",
    session: {
      promptHash: first.promptHash,
      addendumHash: first.addendumHash,
    },
    prefix,
    addendum: "Notice",
  });
  assert.equal(again.instructions, "");
  assert.equal(again.addendum, "");
  const changed = promptDelivery({
    provider: "codex",
    session: { promptHash: first.promptHash, addendumHash: first.addendumHash },
    prefix,
    addendum: "Notice changed",
  });
  assert.equal(changed.instructions, prefix);
  assert.equal(changed.addendum, "Notice changed");
});
