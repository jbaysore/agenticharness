import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Store {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, repositories TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, scope TEXT NOT NULL DEFAULT 'project', sessions TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), action_id TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, native_turn_id TEXT, created_at TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), run_id TEXT REFERENCES runs(id), role TEXT NOT NULL, provider TEXT, model TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL);
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
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(runs)")
        .all()
        .some((c) => c.name === "error")
    )
      this.db.exec("ALTER TABLE runs ADD COLUMN error TEXT");
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
      .prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
      .all()
      .map((c) => ({ ...c, sessions: JSON.parse(c.sessions) }));
  }
  conversation(id) {
    const c = this.db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
    return c && { ...c, sessions: JSON.parse(c.sessions) };
  }
  createConversation({
    projectId,
    title = "New conversation",
    provider = "codex",
    model = "",
    effort = null,
    scope = "project",
  }) {
    const id = randomUUID(),
      now = this.now();
    this.db
      .prepare(
        "INSERT INTO conversations(id,project_id,title,provider,model,effort,scope,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(id, projectId, title, provider, model, effort, scope, now, now);
    return this.conversation(id);
  }
  updateConversation(id, fields) {
    const allowed = new Set([
      "title",
      "provider",
      "model",
      "effort",
      "scope",
      "sessions",
    ]);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    if (entries.length)
      this.db
        .prepare(
          `UPDATE conversations SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=? WHERE id=?`,
        )
        .run(
          ...entries.map(([key, value]) =>
            key === "sessions" ? JSON.stringify(value) : value,
          ),
          this.now(),
          id,
        );
    return this.conversation(id);
  }
  messages(id) {
    return this.db
      .prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid")
      .all(id);
  }
  addMessage({
    id = randomUUID(),
    conversationId,
    runId = null,
    role,
    provider = null,
    model = null,
    content = "",
  }) {
    this.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,run_id,role,provider,model,content,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        conversationId,
        runId,
        role,
        provider,
        model,
        content,
        this.now(),
      );
    this.updateConversation(conversationId, {});
    return id;
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
  createRun({ conversationId, actionId, provider, model, text }) {
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
      });
      const c = this.conversation(conversationId);
      this.updateConversation(conversationId, {
        title: c.title === "New conversation" ? text.slice(0, 70) : c.title,
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
      projects: this.projects(),
      conversations: this.conversations(),
      lastEventId: this.latestEventId(),
    };
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
      lastEventId: this.latestEventId(),
    };
  }
}
