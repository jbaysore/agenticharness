import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/core/store.mjs";
import {
  historyCall,
  handoffContext,
  historyTools,
  workspaceNotice,
  workspacePeers,
} from "../src/core/history.mjs";
import { pathsOverlap } from "../src/core/repository.mjs";

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
  db.addNote({
    projectId: a.id,
    conversationId: ca.id,
    content: "Another conversation decision",
    evidence: ["source"],
  });
  assert.equal(historyCall(db, ca2.id, "project_notes", {}).length, 0);
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
test("handoffs carry origin, evidence and review comments without treating native sessions as interchangeable", () => {
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
  db.addNote({
    projectId: p.id,
    conversationId: c.id,
    content: "Use SQLite",
    evidence: ["src/db.mjs@abc"],
  });
  const result = handoffContext(db, c, "claude");
  assert.match(result, /context handoff/);
  assert.match(result, /model-a/);
  assert.match(result, /src\/db.mjs@abc/);
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
