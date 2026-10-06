import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { historyCall, handoffContext } from "../src/core/history.mjs";

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
  const ca = db.createConversation({ projectId: a.id }),
    ca2 = db.createConversation({ projectId: a.id }),
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
  db.updateConversation(ca.id, { scope: "none" });
  assert.equal(
    historyCall(db, ca.id, "history_search", { query: "SQLite" }).length,
    1,
  );
  db.addNote({
    projectId: a.id,
    conversationId: ca2.id,
    content: "Another conversation decision",
    evidence: ["source"],
  });
  assert.equal(historyCall(db, ca.id, "project_notes", {}).length, 0);
  assert.doesNotMatch(
    handoffContext(db, db.conversation(ca.id), "claude"),
    /Another conversation decision/,
  );
  db.updateConversation(ca.id, { scope: "all" });
  assert.equal(
    historyCall(db, ca.id, "history_search", { query: "SQLite" }).length,
    3,
  );
  assert.match(
    historyCall(db, ca.id, "history_search", { query: "SQLite" })[0].source,
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
