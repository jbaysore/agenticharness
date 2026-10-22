import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildSteps, settle } from "./steps.mjs";
import { provisionalTitle } from "./history.mjs";

const historyScopes = ["none", "project", "all"];

// A chat's newest run is its only possible active one: createRun refuses a second.
const summary = `SELECT c.*, l.status AS last_status, l.ended_at AS last_ended_at, l.error AS last_error,
  (SELECT count(*) FROM approvals a WHERE a.conversation_id=c.id AND a.status='pending') AS pending_approvals
  FROM conversations c LEFT JOIN runs l ON l.rowid=(SELECT r.rowid FROM runs r WHERE r.conversation_id=c.id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1)`;

export function chatStatus(row) {
  const active = ["starting", "running", "waiting"].includes(row.last_status);
  return {
    status: active
      ? row.pending_approvals > 0 || row.last_status === "waiting"
        ? "needs-approval"
        : "running"
      : ["failed", "interrupted"].includes(row.last_status)
        ? row.last_status
        : "idle",
    unread:
      !active && !!row.last_ended_at && row.last_ended_at > (row.read_at ?? ""),
  };
}

function summarize({ last_status, last_ended_at, pending_approvals, ...c }) {
  return {
    ...c,
    sessions: JSON.parse(c.sessions),
    worktree: c.worktree ? JSON.parse(c.worktree) : null,
    ...chatStatus({ ...c, last_status, last_ended_at, pending_approvals }),
  };
}

export class Store {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, repositories TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, scope TEXT NOT NULL DEFAULT 'all', sessions TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), action_id TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, native_turn_id TEXT, created_at TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), run_id TEXT REFERENCES runs(id), role TEXT NOT NULL, provider TEXT, model TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid,content) VALUES (new.rowid,new.content); END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts,rowid,content) VALUES ('delete',old.rowid,old.content); END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN INSERT INTO messages_fts(messages_fts,rowid,content) VALUES ('delete',old.rowid,old.content); INSERT INTO messages_fts(rowid,content) VALUES (new.rowid,new.content); END;
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT, run_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_conversation ON events(conversation_id,id);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, run_id TEXT NOT NULL, provider TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), conversation_id TEXT REFERENCES conversations(id), content TEXT NOT NULL, evidence TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), repository TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, body TEXT NOT NULL, revision TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), project_id TEXT NOT NULL REFERENCES projects(id), repository TEXT NOT NULL, file TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id,created_at);
      CREATE INDEX IF NOT EXISTS approvals_conversation ON approvals(conversation_id,status);
    `);
    const columns = (table) =>
      this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
    if (!columns("messages").includes("attachments"))
      this.db.exec(
        "ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
      );
    if (!columns("runs").includes("error"))
      this.db.exec("ALTER TABLE runs ADD COLUMN error TEXT");
    const conversation = columns("conversations");
    if (!conversation.includes("permissions"))
      this.db.exec(
        "ALTER TABLE conversations ADD COLUMN permissions TEXT NOT NULL DEFAULT 'auto'",
      );
    // Default, plan or goal: how the next turn runs, in the agent's own terms.
    if (!conversation.includes("mode"))
      this.db.exec(
        "ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'default'",
      );
    if (!conversation.includes("archived_at"))
      this.db.exec("ALTER TABLE conversations ADD COLUMN archived_at TEXT");
    // Kept until the chat is unpinned, including while it is archived.
    if (!conversation.includes("pinned_at"))
      this.db.exec("ALTER TABLE conversations ADD COLUMN pinned_at TEXT");
    // Existing history starts out read; only later turns can mark a chat unread.
    if (!conversation.includes("read_at"))
      this.db.exec(
        "ALTER TABLE conversations ADD COLUMN read_at TEXT; UPDATE conversations SET read_at=updated_at",
      );
    // The chat's own Git worktree, when it started beside another busy chat.
    if (!conversation.includes("worktree"))
      this.db.exec("ALTER TABLE conversations ADD COLUMN worktree TEXT");
    // Run on a chat's rebased branch before it lands on the project's branch.
    if (!columns("projects").includes("check_command"))
      this.db.exec("ALTER TABLE projects ADD COLUMN check_command TEXT");
    if (this.setting("default-history-scope") === null)
      this.setting("default-history-scope", "all");
  }

  close() {
    this.db.close();
  }
  now() {
    return new Date().toISOString();
  }
  setting(key, value) {
    if (value === undefined) {
      const row = this.db
        .prepare("SELECT value FROM settings WHERE key=?")
        .get(key);
      return row ? JSON.parse(row.value) : null;
    }
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
    return value;
  }
  settings() {
    return { defaultHistoryScope: this.setting("default-history-scope") };
  }
  saveSettings({ defaultHistoryScope }) {
    if (defaultHistoryScope !== undefined) {
      if (!historyScopes.includes(defaultHistoryScope))
        throw new Error("Invalid history scope");
      this.setting("default-history-scope", defaultHistoryScope);
    }
    return this.settings();
  }
  projects() {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY created_at")
      .all()
      .map((p) => ({ ...p, repositories: JSON.parse(p.repositories) }));
  }
  project(id) {
    return this.projects().find((p) => p.id === id);
  }
  addProject(name, path) {
    const existing = this.db
      .prepare("SELECT id FROM projects WHERE path=?")
      .get(path);
    if (existing) return this.project(existing.id);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO projects(id,name,path,created_at) VALUES(?,?,?,?)")
      .run(id, name, path, this.now());
    return this.project(id);
  }
  setCheckCommand(projectId, command) {
    if (!this.project(projectId)) throw new Error("Project not found");
    const value =
      String(command ?? "")
        .trim()
        .slice(0, 2000) || null;
    this.db
      .prepare("UPDATE projects SET check_command=? WHERE id=?")
      .run(value, projectId);
    return this.project(projectId);
  }
  addReference(projectId, reference) {
    const project = this.project(projectId);
    if (!project) throw new Error("Project not found");
    if (reference.path === project.path)
      throw new Error("A reference must be a different repository");
    const references = [
      ...project.repositories.filter((r) => r.path !== reference.path),
      { ...reference, role: "reference", writable: false },
    ];
    this.db
      .prepare("UPDATE projects SET repositories=? WHERE id=?")
      .run(JSON.stringify(references), projectId);
    return this.project(projectId);
  }
  conversations() {
    return this.db
      .prepare(
        `${summary} ORDER BY c.pinned_at IS NULL, c.pinned_at DESC, c.updated_at DESC`,
      )
      .all()
      .map(summarize);
  }
  conversation(id) {
    const c = this.db.prepare(`${summary} WHERE c.id=?`).get(id);
    return c && summarize(c);
  }
  markRead(id) {
    this.db
      .prepare("UPDATE conversations SET read_at=? WHERE id=?")
      .run(this.now(), id);
  }
  setArchived(id, archived) {
    this.db
      .prepare("UPDATE conversations SET archived_at=? WHERE id=?")
      .run(archived ? this.now() : null, id);
  }
  // Pinning leaves updated_at alone, so unpinning returns the chat to its
  // place among the others. Pinning again records a new time and moves it up.
  setPinned(id, pinned) {
    this.db
      .prepare("UPDATE conversations SET pinned_at=? WHERE id=?")
      .run(pinned ? this.now() : null, id);
  }
  createConversation({
    projectId,
    title = "New conversation",
    provider = "codex",
    model = "",
    effort = null,
    permissions = "auto",
    mode = "default",
    scope = this.settings().defaultHistoryScope,
    createdAt,
  }) {
    if (!historyScopes.includes(scope))
      throw new Error("Invalid history scope");
    const id = randomUUID(),
      now = createdAt || this.now();
    this.db
      .prepare(
        "INSERT INTO conversations(id,project_id,title,provider,model,effort,permissions,mode,scope,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        projectId,
        title,
        provider,
        model,
        effort,
        permissions,
        mode,
        scope,
        now,
        now,
      );
    return this.conversation(id);
  }
  setConversationProject(id, projectId) {
    const chat = this.conversation(id);
    if (!chat) throw new Error("Conversation not found");
    if (!this.project(projectId)) throw new Error("Project not found");
    if (chat.project_id === projectId) return chat;
    if (
      this.messages(id).length ||
      this.db
        .prepare("SELECT 1 FROM runs WHERE conversation_id=? LIMIT 1")
        .get(id) ||
      Object.keys(chat.sessions).length ||
      chat.worktree
    )
      throw new Error("Choose a directory before sending the first message");
    this.db
      .prepare("UPDATE conversations SET project_id=?,updated_at=? WHERE id=?")
      .run(projectId, this.now(), id);
    return this.conversation(id);
  }
  updateConversation(id, fields) {
    if (Object.hasOwn(fields, "scope"))
      throw new Error("History scope is fixed when a conversation is created");
    const allowed = new Set([
      "title",
      "provider",
      "model",
      "effort",
      "permissions",
      "mode",
      "sessions",
      "worktree",
    ]);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    if (entries.length)
      this.db
        .prepare(
          `UPDATE conversations SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=? WHERE id=?`,
        )
        .run(
          ...entries.map(([key, value]) =>
            key === "sessions" || (key === "worktree" && value)
              ? JSON.stringify(value)
              : value,
          ),
          this.now(),
          id,
        );
    return this.conversation(id);
  }
  messages(id) {
    return this.db
      .prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid")
      .all(id)
      .map((m) => ({ ...m, attachments: JSON.parse(m.attachments) }));
  }
  addAttachment({ id, projectId, name, type, size }) {
    this.db
      .prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?)")
      .run(id, projectId, name, type, size, this.now());
  }
  attachment(id) {
    return this.db.prepare("SELECT * FROM attachments WHERE id=?").get(id);
  }
  addMessage({
    id = randomUUID(),
    conversationId,
    runId = null,
    role,
    provider = null,
    model = null,
    content = "",
    attachments = [],
    createdAt,
  }) {
    this.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,run_id,role,provider,model,content,created_at,attachments) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        conversationId,
        runId,
        role,
        provider,
        model,
        content,
        createdAt || this.now(),
        JSON.stringify(attachments),
      );
    this.updateConversation(conversationId, {});
    return id;
  }
  stampConversation(id, createdAt, updatedAt) {
    this.db
      .prepare("UPDATE conversations SET created_at=?, updated_at=? WHERE id=?")
      .run(createdAt, updatedAt, id);
  }
  appendMessage(id, delta) {
    this.db
      .prepare("UPDATE messages SET content=content || ? WHERE id=?")
      .run(delta, id);
  }
  replaceMessage(id, text) {
    this.db.prepare("UPDATE messages SET content=? WHERE id=?").run(text, id);
  }
  search(query, { projectId, conversationId, limit = 30 } = {}) {
    const terms =
      query
        .trim()
        .match(/[\p{L}\p{N}_-]+/gu)
        ?.slice(0, 12) ?? [];
    if (!terms.length) return [];
    const match = terms
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(" AND ");
    return this.db
      .prepare(
        `SELECT m.id,m.conversation_id,m.role,m.provider,m.model,m.created_at,c.title,c.project_id,
      snippet(messages_fts,0,'','', ' … ',32) AS excerpt FROM messages_fts
      JOIN messages m ON m.rowid=messages_fts.rowid JOIN conversations c ON c.id=m.conversation_id
      WHERE messages_fts MATCH ? AND (? IS NULL OR c.project_id=?) AND (? IS NULL OR c.id=?) ORDER BY rank LIMIT ?`,
      )
      .all(
        match,
        projectId ?? null,
        projectId ?? null,
        conversationId ?? null,
        conversationId ?? null,
        Math.min(limit, 100),
      )
      .map((row) => ({
        ...row,
        source: `harness://conversation/${row.conversation_id}#${row.id}`,
      }));
  }
  run(id) {
    return this.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
  }
  runForAction(actionId) {
    return this.db
      .prepare("SELECT * FROM runs WHERE action_id=?")
      .get(actionId);
  }
  activeRun(conversationId) {
    return this.db
      .prepare(
        "SELECT * FROM runs WHERE conversation_id=? AND status IN ('running','starting','waiting') ORDER BY created_at DESC LIMIT 1",
      )
      .get(conversationId);
  }
  activeRuns() {
    return this.db
      .prepare(
        "SELECT * FROM runs WHERE status IN ('running','starting','waiting') ORDER BY created_at, rowid",
      )
      .all();
  }
  runRequest(runId) {
    return (
      this.db
        .prepare(
          "SELECT content FROM messages WHERE run_id=? AND role='user' ORDER BY rowid LIMIT 1",
        )
        .get(runId)?.content ?? ""
    );
  }
  createRun({
    conversationId,
    actionId,
    provider,
    model,
    text,
    attachments = [],
  }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.runForAction(actionId);
      if (existing) {
        if (existing.conversation_id !== conversationId)
          throw new Error("Action ID belongs to another conversation");
        this.db.exec("COMMIT");
        return { ...existing, duplicate: true };
      }
      if (this.activeRun(conversationId))
        throw new Error("A turn is already active in this conversation");
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO runs(id,conversation_id,action_id,provider,model,status,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          conversationId,
          actionId,
          provider,
          model,
          "starting",
          this.now(),
        );
      this.addMessage({
        conversationId,
        runId: id,
        role: "user",
        content: text,
        attachments,
      });
      const c = this.conversation(conversationId);
      this.updateConversation(conversationId, {
        title:
          c.title === "New conversation"
            ? provisionalTitle(text, attachments)
            : c.title,
        provider,
        model,
      });
      this.db.exec("COMMIT");
      return this.run(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  setRun(id, status, nativeTurnId = null, error = null) {
    this.db
      .prepare(
        "UPDATE runs SET status=?,native_turn_id=COALESCE(?,native_turn_id),ended_at=?,error=? WHERE id=?",
      )
      .run(
        status,
        nativeTurnId,
        ["completed", "failed", "cancelled", "interrupted"].includes(status)
          ? this.now()
          : null,
        error,
        id,
      );
  }
  appendEvent(conversationId, runId, type, payload) {
    const now = this.now();
    const result = this.db
      .prepare(
        "INSERT INTO events(conversation_id,run_id,type,payload,created_at) VALUES(?,?,?,?,?)",
      )
      .run(conversationId, runId, type, JSON.stringify(payload), now);
    return {
      id: Number(result.lastInsertRowid),
      conversationId,
      runId,
      type,
      payload,
      createdAt: now,
    };
  }
  events(after = 0, limit = 1000) {
    return this.db
      .prepare("SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?")
      .all(after, limit)
      .map((e) => ({
        id: e.id,
        conversationId: e.conversation_id,
        runId: e.run_id,
        type: e.type,
        payload: JSON.parse(e.payload),
        createdAt: e.created_at,
      }));
  }
  latestEventId() {
    return this.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM events").get()
      .id;
  }
  addApproval(conversationId, runId, provider, request) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO approvals(id,conversation_id,run_id,provider,request,status,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        conversationId,
        runId,
        provider,
        JSON.stringify(request),
        "pending",
        this.now(),
      );
    return this.approval(id);
  }
  approval(id) {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id);
    return (
      row && {
        ...row,
        request: JSON.parse(row.request),
        response: row.response && JSON.parse(row.response),
      }
    );
  }
  pendingApprovals(conversationId) {
    return this.db
      .prepare(
        "SELECT id FROM approvals WHERE conversation_id=? AND status='pending'",
      )
      .all(conversationId)
      .map((r) => this.approval(r.id));
  }
  resolveApproval(id, response) {
    return (
      this.db
        .prepare(
          "UPDATE approvals SET status='resolved',response=? WHERE id=? AND status='pending'",
        )
        .run(JSON.stringify(response), id).changes > 0
    );
  }
  expireApprovals(runId) {
    this.db
      .prepare(
        "UPDATE approvals SET status='expired' WHERE run_id=? AND status='pending'",
      )
      .run(runId);
  }
  addComment({ conversationId, repository, file, line, body, revision }) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO comments VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id,
        conversationId,
        repository,
        file,
        line,
        body,
        revision,
        this.now(),
      );
    return id;
  }
  comments(conversationId) {
    return this.db
      .prepare(
        "SELECT * FROM comments WHERE conversation_id=? ORDER BY created_at",
      )
      .all(conversationId);
  }
  addNote({ projectId, conversationId = null, content, evidence }) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO notes(id,project_id,conversation_id,content,evidence,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        projectId,
        conversationId,
        content,
        JSON.stringify(evidence),
        this.now(),
      );
    return id;
  }
  notes(projectId) {
    return this.db
      .prepare(
        "SELECT * FROM notes WHERE project_id=? ORDER BY created_at DESC",
      )
      .all(projectId)
      .map((n) => ({
        ...n,
        evidence: JSON.parse(n.evidence),
        stale: !!n.stale,
      }));
  }
  recover() {
    const interrupted = this.db
      .prepare(
        "SELECT * FROM runs WHERE status IN ('starting','running','waiting')",
      )
      .all();
    for (const run of interrupted) {
      this.setRun(run.id, "interrupted");
      this.expireApprovals(run.id);
      this.appendEvent(run.conversation_id, run.id, "run", {
        status: "interrupted",
        reason:
          "Host restarted. Review partial work, then explicitly continue; no action was automatically replayed.",
      });
    }
    return interrupted.length;
  }
  snapshot() {
    return {
      settings: this.settings(),
      projects: this.projects(),
      conversations: this.conversations(),
      lastEventId: this.latestEventId(),
    };
  }
  // What each recent turn did, normalised so the chat can summarise it inline.
  steps(conversationId) {
    const byRun = {};
    for (const e of this.db
      .prepare(
        // A reply's first text event is enough to place the steps after it.
        `SELECT e.run_id, e.type, e.payload, r.status FROM events e JOIN runs r ON r.id=e.run_id
        WHERE e.run_id IN (SELECT id FROM runs WHERE conversation_id=? ORDER BY created_at DESC LIMIT 30)
        AND ((e.type='work' AND json_extract(e.payload,'$.kind') NOT IN ('command-output','token-usage'))
          OR e.id IN (SELECT MIN(id) FROM events WHERE conversation_id=? AND type='text'
            AND run_id IN (SELECT id FROM runs WHERE conversation_id=? ORDER BY created_at DESC LIMIT 30)
            GROUP BY json_extract(payload,'$.messageId')))
        ORDER BY e.id`,
      )
      .all(conversationId, conversationId, conversationId)) {
      const run = (byRun[e.run_id] ??= { status: e.status, payloads: [] });
      run.payloads.push({ type: e.type, payload: JSON.parse(e.payload) });
    }
    return Object.fromEntries(
      Object.entries(byRun).map(([runId, { status, payloads }]) => {
        const steps = buildSteps(payloads);
        return [
          runId,
          ["running", "starting", "waiting"].includes(status)
            ? steps
            : settle(steps),
        ];
      }),
    );
  }
  conversationSnapshot(id) {
    return {
      ...this.conversation(id),
      messages: this.messages(id),
      activeRun: this.activeRun(id),
      approvals: this.pendingApprovals(id),
      comments: this.comments(id),
      artifacts: this.db
        .prepare(
          "SELECT * FROM artifacts WHERE conversation_id=? ORDER BY created_at DESC",
        )
        .all(id),
      runs: this.db
        .prepare(
          "SELECT * FROM runs WHERE conversation_id=? ORDER BY created_at DESC LIMIT 30",
        )
        .all(id),
      steps: this.steps(id),
      lastEventId: this.latestEventId(),
    };
  }
}
