import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildSteps, settle } from "./steps.mjs";
import { provisionalTitle } from "./history.mjs";
import {
  blockingGoals,
  goalStatus,
  goalStopped,
  hasOwnerPause,
  sessionGoals,
} from "./goals.mjs";
import { isUsageExhausted } from "../security/billing.mjs";
import { WatchStore } from "./watch-store.mjs";

const historyScopes = ["none", "project", "all"];
// A chat's newest run is its only possible active one: createRun refuses a second.
const summary = `SELECT c.*, (SELECT scratch FROM projects WHERE id=c.project_id) AS directoryless, l.status AS last_status, l.ended_at AS last_ended_at, l.error AS last_error,
  COALESCE((SELECT r.provider FROM runs r WHERE r.id=c.usage_stopped_run_id),
    (SELECT r.provider FROM runs r WHERE r.conversation_id=c.id AND c.usage_stopped_at IS NOT NULL AND r.error=c.usage_stopped_reason ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)) AS usage_stopped_provider,
  (SELECT count(*) FROM approvals a WHERE a.conversation_id=c.id AND a.status='pending') AS pending_approvals,
  (SELECT count(*) FROM background_watches w WHERE w.conversation_id=c.id AND w.status IN ('registering','pending','settling','retrying')) AS active_watches,
  (SELECT group_concat(DISTINCT COALESCE(json_extract(w.payload,'$.kind'), 'ci')) FROM background_watches w WHERE w.conversation_id=c.id AND w.status IN ('registering','pending','settling','retrying')) AS watch_kinds,
  (SELECT MAX(result_at) FROM background_watches w WHERE w.conversation_id=c.id) AS last_watch_at
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
      (!!row.last_watch_at && row.last_watch_at > (row.read_at ?? "")) ||
      (!active && !!row.last_ended_at && row.last_ended_at > (row.read_at ?? "")),
    watching: Number(row.active_watches) > 0,
  };
}

function summarize(row) {
  const owner_pause = hasOwnerPause(row.sessions);
  const {
    last_status,
    last_ended_at,
    pending_approvals,
    active_watches,
    goal_progress,
    ...c
  } = row;
  return {
    ...c,
    directoryless: Boolean(c.directoryless),
    sessions: JSON.parse(c.sessions),
    worktree: c.worktree ? JSON.parse(c.worktree) : null,
    goalProgress: goal_progress ? JSON.parse(goal_progress) : null,
    owner_pause,
    ...chatStatus({
      ...c,
      last_status,
      last_ended_at,
      pending_approvals,
      active_watches,
    }),
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
      CREATE INDEX IF NOT EXISTS events_conversation_type ON events(conversation_id,type,id);
      CREATE INDEX IF NOT EXISTS events_run_type_time ON events(run_id,type,created_at);
      CREATE INDEX IF NOT EXISTS events_run_control ON events(run_id,id)
        WHERE type='work' AND json_extract(payload,'$.kind') IN ('provider-startup','cancellation');
      CREATE TABLE IF NOT EXISTS reliability_actions(action_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_context(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, provider TEXT NOT NULL, payload TEXT NOT NULL, last_event_id INTEGER NOT NULL, PRIMARY KEY(conversation_id,provider));
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, run_id TEXT NOT NULL, provider TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plan_reviews(run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, status TEXT NOT NULL, reviewer TEXT, result TEXT, error TEXT, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS plan_reviews_conversation ON plan_reviews(conversation_id);
      CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), conversation_id TEXT REFERENCES conversations(id), content TEXT NOT NULL, evidence TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), repository TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, body TEXT NOT NULL, revision TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS openrouter_sessions(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), project_id TEXT NOT NULL REFERENCES projects(id), repository TEXT NOT NULL, file TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id,created_at);
      CREATE INDEX IF NOT EXISTS approvals_conversation ON approvals(conversation_id,status);
      CREATE TABLE IF NOT EXISTS queued_inputs(
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        action_id TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT,
        permissions TEXT,
        mode TEXT,
        status TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS queued_inputs_conversation ON queued_inputs(conversation_id, position);
    `);
    this.watchStore = new WatchStore(this.db);
    const columns = (table) =>
      this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
    if (!columns("messages").includes("source"))
      this.db.exec("ALTER TABLE messages ADD COLUMN source TEXT");
    if (!columns("messages").includes("attachments"))
      this.db.exec(
        "ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
      );
    if (!columns("runs").includes("error"))
      this.db.exec("ALTER TABLE runs ADD COLUMN error TEXT");
    // The chat mode a run worked in. Older runs have none.
    if (!columns("runs").includes("mode"))
      this.db.exec("ALTER TABLE runs ADD COLUMN mode TEXT");
    // The plan text a review read, so a revised plan gets its own review.
    if (!columns("plan_reviews").includes("plan"))
      this.db.exec("ALTER TABLE plan_reviews ADD COLUMN plan TEXT");
    const conversation = columns("conversations");
    if (!columns("queued_inputs").includes("goal_replacement"))
      this.db.exec("ALTER TABLE queued_inputs ADD COLUMN goal_replacement INTEGER NOT NULL DEFAULT 0");
    if (!conversation.includes("goal_progress"))
      this.db.exec("ALTER TABLE conversations ADD COLUMN goal_progress TEXT");
    if (!conversation.includes("permissions"))
      this.db.exec(
        "ALTER TABLE conversations ADD COLUMN permissions TEXT NOT NULL DEFAULT 'auto'",
      );
    // default, ask, plan or goal: how the next turn runs.
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
    // The chat's own Git worktree, created on its first turn.
    if (!conversation.includes("worktree"))
      this.db.exec("ALTER TABLE conversations ADD COLUMN worktree TEXT");
    // Set when included usage runs out, including a rejection before the turn
    // does any work. Cleared when a later turn starts working, or when dismissed.
    if (!conversation.includes("usage_stopped_at"))
      this.db.exec(
        "ALTER TABLE conversations ADD COLUMN usage_stopped_at TEXT",
      );
    if (!conversation.includes("usage_stopped_reason"))
      this.db.exec(
        "ALTER TABLE conversations ADD COLUMN usage_stopped_reason TEXT",
      );
    if (!conversation.includes("usage_dismissed_run_id"))
      this.db.exec(
        "ALTER TABLE conversations ADD COLUMN usage_dismissed_run_id TEXT",
      );
    if (!conversation.includes("usage_stopped_run_id")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN usage_stopped_run_id TEXT");
      this.db.exec(`UPDATE conversations SET usage_stopped_run_id=(SELECT r.id FROM runs r
        WHERE r.conversation_id=conversations.id AND r.error=conversations.usage_stopped_reason
        ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1) WHERE usage_stopped_at IS NOT NULL`);
    }
    // Set while this chat should continue the stopped model after usage resets.
    if (!conversation.includes("usage_resume_at"))
      this.db.exec("ALTER TABLE conversations ADD COLUMN usage_resume_at TEXT");
    if (!conversation.includes("usage_resume_action"))
      this.db.exec("ALTER TABLE conversations ADD COLUMN usage_resume_action TEXT");
    if (!conversation.includes("usage_resume_error"))
      this.db.exec("ALTER TABLE conversations ADD COLUMN usage_resume_error TEXT");
    // Run on a chat's rebased branch before it lands on the project's branch.
    if (!columns("projects").includes("check_command"))
      this.db.exec("ALTER TABLE projects ADD COLUMN check_command TEXT");
    if (!columns("projects").includes("scratch"))
      this.db.exec(
        "ALTER TABLE projects ADD COLUMN scratch INTEGER NOT NULL DEFAULT 0",
      );
    if (this.setting("default-history-scope") === null)
      this.setting("default-history-scope", "all");
    this.protectLegacyGoals();
    this.repairReplayedGoalUsageStops();
    this.repairStartupUsageStops();
  }

  close() {
    this.db.close();
  }
  repairReplayedGoalUsageStops() {
    // Older hosts latched a resumed Codex Goal's historical usageLimited
    // notification. Repair only runs whose saved events prove reactivation,
    // completion and a healthy final meter, with no current billing/error stop.
    const candidates = this.db
      .prepare(
        `SELECT r.*, c.sessions FROM runs r JOIN conversations c ON c.id=r.conversation_id
          WHERE r.provider='codex' AND r.status='failed'
          AND r.error='A provider usage limit has been reached.'`,
      )
      .all();
    const evidence = this.db.prepare(
      `SELECT type,payload FROM events WHERE run_id=? AND
        (type IN ('chat','usage') OR (type='work' AND json_extract(payload,'$.kind') IN ('billing-stop','error')))
        ORDER BY id`,
    );
    for (const run of candidates) {
      const saved = JSON.parse(run.sessions).codex?.goal;
      if (saved?.runId !== run.id || saved.status !== "complete") continue;
      const events = evidence.all(run.id).map((e) => ({
        type: e.type,
        payload: JSON.parse(e.payload),
      }));
      if (events.some((e) => e.type === "work")) continue;
      const states = events.flatMap((e, index) => {
        const goal = e.type === "chat" && e.payload.sessions?.codex?.goal;
        return goal?.runId === run.id ? [{ index, status: goal.status }] : [];
      });
      const final = states.at(-1);
      if (
        states[0]?.status !== "usageLimited" ||
        !states.some((s) => s.status === "active") ||
        final?.status !== "complete"
      )
        continue;
      const usage = events
        .slice(final.index + 1)
        .findLast((e) => e.type === "usage")?.payload;
      if (
        usage?.authoritative !== true ||
        usage.ordinaryUsageAllowed !== true ||
        !usage.windows?.length ||
        !usage.windows.every(
          (w) => typeof w.usedPercent === "number" && w.usedPercent < 100,
        )
      )
        continue;
      const latest = this.db
        .prepare(
          "SELECT id FROM runs WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get(run.conversation_id);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare("UPDATE runs SET status='completed',error=NULL WHERE id=?")
          .run(run.id);
        if (latest?.id === run.id) this.clearUsageStop(run.conversation_id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  repairStartupUsageStops() {
    // Older hosts saved a startup quota rejection as an ordinary failure.
    // Only the latest failed run can become the usage notice. A dismissed
    // stop, a cancelled run, and an older failure stay as they were.
    const latest = this.db
      .prepare(
        `SELECT c.id AS conversation_id, c.updated_at, r.id AS run_id, r.provider, r.error
         FROM conversations c
         JOIN runs r ON r.rowid=(
           SELECT rr.rowid FROM runs rr WHERE rr.conversation_id=c.id
           ORDER BY rr.created_at DESC, rr.rowid DESC LIMIT 1)
         WHERE c.usage_stopped_at IS NULL AND r.status='failed'
           AND (c.usage_dismissed_run_id IS NULL OR c.usage_dismissed_run_id!=r.id)`,
      )
      .all();
    for (const row of latest) {
      if (!isUsageExhausted(row.error)) continue;
      this.setUsageStop(row.conversation_id, row.error, row.run_id);
      const chat = this.conversation(row.conversation_id);
      const goal = chat?.sessions?.[row.provider]?.goal;
      if (!goal || goal.runId !== row.run_id || goalStopped(goal.status)) continue;
      this.setGoalState(row.conversation_id, row.provider, row.run_id, "usageLimited");
      this.db
        .prepare("UPDATE conversations SET updated_at=? WHERE id=?")
        .run(row.updated_at, row.conversation_id);
    }
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
  addProject(name, path, { scratch = false } = {}) {
    const existing = this.db
      .prepare("SELECT id FROM projects WHERE path=?")
      .get(path);
    if (existing) return this.project(existing.id);
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO projects(id,name,path,created_at,scratch) VALUES(?,?,?,?,?)",
      )
      .run(id, name, path, this.now(), Number(scratch));
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
  protectLegacyGoals(id) {
    const rows = id
      ? this.db
          .prepare("SELECT id,mode,sessions FROM conversations WHERE id=?")
          .all(id)
      : this.db
          .prepare(
            "SELECT id,mode,sessions FROM conversations WHERE mode='goal'",
          )
          .all();
    for (const row of rows) {
      const chat = { ...row, sessions: JSON.parse(row.sessions) };
      let changed = false;
      for (const { provider, status } of sessionGoals(chat)) {
        const session = chat.sessions[provider];
        if (session?.goal) continue;
        chat.sessions[provider] = {
          ...(typeof session === "string" ? { id: session } : session),
          goal: { status },
        };
        changed = true;
      }
      // Migration must not reorder saved conversations.
      if (changed)
        this.db
          .prepare("UPDATE conversations SET sessions=? WHERE id=?")
          .run(JSON.stringify(chat.sessions), row.id);
    }
  }
  restartBlockingGoals() {
    return this.db
      .prepare("SELECT id,mode,sessions FROM conversations")
      .all()
      .flatMap((row) =>
        blockingGoals({ ...row, sessions: JSON.parse(row.sessions) }).map(
          (goal) => ({ ...goal, conversationId: row.id }),
        ),
      );
  }
  // The objective is kept so a paused Goal can resume without retyping it.
  // Leave it undefined to keep the saved one; null forgets it.
  setGoalState(id, provider, runId, status, objective, ownerPause) {
    const chat = this.conversation(id);
    if (!chat) return;
    const previous = chat.sessions[provider];
    const session = typeof previous === "string" ? { id: previous } : previous;
    const kept =
      objective === undefined ? session?.goal?.objective : objective || null;
    const next = goalStatus(status);
    const pause =
      next === "owner" ? ownerPause ?? session?.goal?.ownerPause : null;
    const progress = chat.goalProgress;
    if (progress?.provider === provider && progress.runId === runId) {
      const completed = next === "complete" && progress.status !== "complete";
      this.saveGoalProgress(id, {
        ...progress,
        status: next,
        ...(completed && {
          phases: progress.phases.map((phase) => ({ ...phase, status: "completed" })),
          updatedAt: this.now(),
        }),
      });
    }
    return this.updateConversation(id, {
      sessions: {
        ...chat.sessions,
        [provider]: {
          ...session,
          goal: {
            runId,
            status: next,
            ...(kept && { objective: kept }),
            ...(pause?.statement && {
              ownerPause: {
                statement: pause.statement,
                askedAt: pause.askedAt ?? this.now(),
                ...(pause.expects === "text" && pause.prompt
                  ? { expects: "text", prompt: pause.prompt }
                  : {}),
              },
            }),
          },
        },
      },
    });
  }
  latestModel(conversationId, provider) {
    return this.db
      .prepare(
        "SELECT model FROM runs WHERE conversation_id=? AND provider=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(conversationId, provider)?.model;
  }
  saveGoalProgress(id, progress) {
    this.db.prepare("UPDATE conversations SET goal_progress=? WHERE id=?")
      .run(JSON.stringify(progress), id);
    return progress;
  }
  beginGoalProgress(id, provider, runId, replace = false, objective) {
    const previous = this.conversation(id)?.goalProgress;
    return this.saveGoalProgress(id, {
      ...(replace ? null : previous),
      goalId: !replace && previous ? previous.goalId : runId,
      objective: objective ?? (!replace ? previous?.objective : null) ?? null,
      provider,
      runId,
      status: "starting",
      phases: !replace && previous ? previous.phases : [],
      explanation: !replace && previous ? previous.explanation : "",
      updatedAt: !replace && previous ? previous.updatedAt : null,
    });
  }
  updateGoalProgress(id, provider, runId, report) {
    const chat = this.conversation(id), progress = chat?.goalProgress;
    if (chat?.mode !== "goal" || progress?.provider !== provider || progress.runId !== runId ||
        !["starting", "active", "unknown"].includes(progress.status)) return null;
    if (JSON.stringify([progress.phases, progress.explanation]) ===
        JSON.stringify([report.phases, report.explanation])) return null;
    return this.saveGoalProgress(id, { ...progress, ...report, updatedAt: this.now() });
  }
  stopGoals(id) {
    const chat = this.conversation(id);
    const goals = [...blockingGoals(chat), ...sessionGoals(chat).filter((g) => g.status === "waiting" || g.status === "owner")];
    for (const goal of goals)
      this.setGoalState(id, goal.provider, goal.runId, "paused");
    return goals.length;
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
    if (archived) this.clearUsageResume(id);
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
  // Leaves updated_at alone, so the reminder does not reorder the chat.
  setUsageStop(id, reason, runId = null) {
    const text = String(reason ?? "")
      .trim()
      .slice(0, 500);
    if (!text) throw new Error("A usage stop needs a reason");
    if (runId && this.run(runId)?.conversation_id !== id)
      throw new Error("Usage stop run belongs to another conversation");
    this.db
      .prepare(
        `UPDATE conversations SET usage_stopped_at=?, usage_stopped_reason=?, usage_dismissed_run_id=NULL,
         usage_resume_at=NULL, usage_resume_action=NULL, usage_resume_error=NULL,
         usage_stopped_run_id=COALESCE(?,(SELECT r.id FROM runs r WHERE r.conversation_id=? AND r.error=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)) WHERE id=?`,
      )
      .run(this.now(), text, runId, id, text, id);
    return this.conversation(id);
  }
  clearUsageStop(id) {
    this.db
      .prepare(
        `UPDATE conversations SET usage_stopped_at=NULL, usage_stopped_reason=NULL, usage_stopped_run_id=NULL,
          usage_dismissed_run_id=NULL, usage_resume_at=NULL, usage_resume_action=NULL, usage_resume_error=NULL WHERE id=?`,
      )
      .run(id);
    return this.conversation(id);
  }
  dismissUsageStop(id) {
    // Acknowledging this stop also hides the same run's generic failure
    // notice. Keep its recorded error and allow later failures to surface.
    this.db
      .prepare(
        `UPDATE conversations SET usage_stopped_at=NULL, usage_stopped_reason=NULL, usage_stopped_run_id=NULL,
          usage_resume_at=NULL, usage_resume_action=NULL, usage_resume_error=NULL,
          usage_dismissed_run_id=COALESCE(usage_stopped_run_id,(SELECT id FROM runs WHERE conversation_id=?
            AND status='failed' AND error=conversations.usage_stopped_reason
            ORDER BY created_at DESC, rowid DESC LIMIT 1))
          WHERE id=? AND usage_stopped_at IS NOT NULL`,
      )
      .run(id, id);
    return this.conversation(id);
  }
  // Chats waiting to continue the model that ran out, oldest request first.
  usageResumes() {
    return this.db
      .prepare(
        `SELECT id FROM conversations
         WHERE usage_resume_at IS NOT NULL AND usage_stopped_at IS NOT NULL AND archived_at IS NULL
         ORDER BY usage_resume_at, rowid`,
      )
      .all()
      .map((row) => this.conversation(row.id))
      .filter(Boolean);
  }
  // One arm per stop. A second request keeps the same action so a refresh
  // cannot start a second turn. A new arm after an error gets a new action.
  armUsageResume(id) {
    const chat = this.conversation(id);
    if (!chat) throw new Error("Conversation not found");
    if (!chat.usage_stopped_at)
      throw new Error("This chat is not stopped because usage ran out");
    const run = chat.usage_stopped_run_id
      ? this.run(chat.usage_stopped_run_id)
      : null;
    if (!run?.model) throw new Error("The stopped turn has no model to resume");
    if (chat.usage_resume_at && chat.usage_resume_action && !chat.usage_resume_error)
      return chat;
    const actionId = `usage-resume-${run.id}-${randomUUID().slice(0, 8)}`;
    if (!/^[-\w]{16,100}$/.test(actionId))
      throw new Error("Could not prepare the usage resume");
    this.db
      .prepare(
        `UPDATE conversations SET usage_resume_at=?, usage_resume_action=?, usage_resume_error=NULL WHERE id=?`,
      )
      .run(this.now(), actionId, id);
    return this.conversation(id);
  }
  clearUsageResume(id) {
    this.db
      .prepare(
        `UPDATE conversations SET usage_resume_at=NULL, usage_resume_action=NULL, usage_resume_error=NULL WHERE id=?`,
      )
      .run(id);
    return this.conversation(id);
  }
  // The wait cannot succeed. Keep the usage stop so the chat can choose again.
  failUsageResume(id, message) {
    const text = String(message ?? "").trim().slice(0, 500);
    if (!text) throw new Error("A usage resume failure needs a reason");
    this.db
      .prepare(
        `UPDATE conversations SET usage_resume_at=NULL, usage_resume_action=NULL, usage_resume_error=? WHERE id=?`,
      )
      .run(text, id);
    return this.conversation(id);
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
  conversationStarted(id) {
    const chat = this.conversation(id);
    if (!chat) return false;
    return Boolean(
      this.messages(id).length ||
      this.db
        .prepare("SELECT 1 FROM runs WHERE conversation_id=? LIMIT 1")
        .get(id) ||
      Object.keys(chat.sessions).length ||
      chat.worktree,
    );
  }
  setConversationProject(id, projectId) {
    const chat = this.conversation(id);
    if (!chat) throw new Error("Conversation not found");
    if (!this.project(projectId)) throw new Error("Project not found");
    if (chat.project_id === projectId) return chat;
    if (this.conversationStarted(id))
      throw new Error("Choose a directory before sending the first message");
    this.db
      .prepare("UPDATE conversations SET project_id=?,updated_at=? WHERE id=?")
      .run(projectId, this.now(), id);
    return this.conversation(id);
  }
  moveConversation(id, projectId) {
    if (!this.conversation(id)) throw new Error("Conversation not found");
    if (!this.project(projectId)) throw new Error("Project not found");
    this.db.prepare("DELETE FROM openrouter_sessions WHERE conversation_id=?").run(id);
    this.db.prepare("DELETE FROM conversation_context WHERE conversation_id=?").run(id);
    this.db
      .prepare(
        "UPDATE conversations SET project_id=?,sessions='{}',worktree=NULL,updated_at=? WHERE id=?",
      )
      .run(projectId, this.now(), id);
    return this.conversation(id);
  }
  // Empty unused chats can be dropped. A typed composer draft is a client
  // concern; anything that has started a turn stays.
  discardUnusedConversation(id) {
    const chat = this.conversation(id);
    if (!chat) throw new Error("Conversation not found");
    if (chat.pinned_at) throw new Error("Unpin this chat before discarding it");
    if (chat.archived_at) throw new Error("This conversation is archived");
    if (this.conversationStarted(id))
      throw new Error("This conversation already has messages");
    this.db.prepare("DELETE FROM conversations WHERE id=?").run(id);
  }
  updateConversation(id, fields) {
    if (Object.hasOwn(fields, "scope"))
      throw new Error("History scope is fixed when a conversation is created");
    // Freeze legacy protection before a mode/provider change can hide it.
    this.protectLegacyGoals(id);
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
    this.protectLegacyGoals(id);
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
    source = null,
  }) {
    this.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,run_id,role,provider,model,content,created_at,attachments,source) VALUES(?,?,?,?,?,?,?,?,?,?)",
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
        source,
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
  search(
    query,
    { projectId, conversationId, directoryless = false, limit = 30 } = {},
  ) {
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
      WHERE messages_fts MATCH ? AND (? IS NULL OR c.project_id=?) AND (? IS NULL OR c.id=?)
      AND (? = 0 OR c.project_id IN (SELECT id FROM projects WHERE scratch=1)) ORDER BY rank LIMIT ?`,
      )
      .all(
        match,
        projectId ?? null,
        projectId ?? null,
        conversationId ?? null,
        conversationId ?? null,
        Number(directoryless),
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
  parseQueued(row) {
    return row && { ...row, attachments: JSON.parse(row.attachments) };
  }
  inputForAction(actionId) {
    return this.parseQueued(
      this.db
        .prepare("SELECT * FROM queued_inputs WHERE action_id=?")
        .get(actionId),
    );
  }
  queuedInput(id) {
    return this.parseQueued(
      this.db.prepare("SELECT * FROM queued_inputs WHERE id=?").get(id),
    );
  }
  queuedInputs(conversationId) {
    return this.db
      .prepare(
        "SELECT * FROM queued_inputs WHERE conversation_id=? AND status='queued' ORDER BY position, rowid",
      )
      .all(conversationId)
      .map((row) => this.parseQueued(row));
  }
  enqueueInput({
    conversationId,
    actionId,
    text,
    attachments = [],
    provider,
    model,
    effort = null,
    permissions = null,
    mode = null,
    status = "queued",
    replaceGoal = false,
    position = null,
  }) {
    const existing = this.inputForAction(actionId);
    if (existing) return { ...existing, duplicate: true };
    const id = randomUUID(),
      place =
        position ??
        this.db
          .prepare(
            "SELECT COALESCE(MAX(position), 0) AS n FROM queued_inputs WHERE conversation_id=?",
          )
          .get(conversationId).n + 1;
    this.db
      .prepare(
        `INSERT INTO queued_inputs(id,conversation_id,action_id,text,attachments,provider,model,effort,permissions,mode,status,position,created_at,goal_replacement)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        conversationId,
        actionId,
        text,
        JSON.stringify(attachments),
        provider,
        model,
        effort,
        permissions,
        mode,
        status,
        place,
        this.now(),
        replaceGoal ? 1 : 0,
      );
    return this.inputForAction(actionId);
  }
  // An undelivered steer goes ahead of messages that were already waiting.
  requeueInput(id) {
    const row = this.queuedInput(id);
    if (!row || row.status !== "steered") return null;
    const front = this.db
      .prepare(
        "SELECT COALESCE(MIN(position), 1) AS n FROM queued_inputs WHERE conversation_id=? AND status='queued'",
      )
      .get(row.conversation_id).n;
    this.db
      .prepare(
        "UPDATE queued_inputs SET status='queued', position=? WHERE id=?",
      )
      .run(front - 1, id);
    return this.queuedInput(id);
  }
  claimNextQueued(conversationId) {
    const row = this.db
      .prepare(
        "SELECT * FROM queued_inputs WHERE conversation_id=? AND status='queued' ORDER BY position, rowid LIMIT 1",
      )
      .get(conversationId);
    if (!row) return null;
    this.db.prepare("DELETE FROM queued_inputs WHERE id=?").run(row.id);
    return this.parseQueued(row);
  }
  deleteQueued(id) {
    const row = this.queuedInput(id);
    if (!row || row.status !== "queued") return null;
    this.db.prepare("DELETE FROM queued_inputs WHERE id=?").run(id);
    return row;
  }
  restoreQueued(row) {
    this.db
      .prepare(
        `INSERT INTO queued_inputs(id,conversation_id,action_id,text,attachments,provider,model,effort,permissions,mode,status,position,created_at,goal_replacement)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.conversation_id,
        row.action_id,
        row.text,
        JSON.stringify(row.attachments ?? []),
        row.provider,
        row.model,
        row.effort,
        row.permissions,
        row.mode,
        "queued",
        row.position,
        row.created_at,
        row.goal_replacement ?? 0,
      );
    return this.queuedInput(row.id);
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
    source = null,
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
        source,
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
  setRunMode(id, mode) {
    this.db.prepare("UPDATE runs SET mode=? WHERE id=?").run(mode, id);
  }
  appendEvent(conversationId, runId, type, payload) {
    if (type === "run" && payload.status === "interrupted")
      this.insertEvent(conversationId, runId, "reliability-transition", { kind: "interruption", key: "interruption:" + runId, provider: payload.provider });
    if (type !== "context-usage")
      return this.insertEvent(conversationId, runId, type, payload);
    this.db.exec("SAVEPOINT context_event");
    try {
      const prior = this.db.prepare("SELECT payload FROM conversation_context WHERE conversation_id=? ORDER BY last_event_id DESC LIMIT 1").get(conversationId);
      const previous = prior ? JSON.parse(prior.payload) : null;
      const event = this.insertEvent(conversationId, runId, type, payload);
      this.db.prepare("INSERT INTO conversation_context(conversation_id,provider,payload,last_event_id) VALUES(?,?,?,?) ON CONFLICT(conversation_id,provider) DO UPDATE SET payload=excluded.payload,last_event_id=excluded.last_event_id")
        .run(conversationId, payload.provider, JSON.stringify(payload), event.id);
      if (previous && (previous.provider !== payload.provider || previous.sessionId !== payload.sessionId))
        this.insertEvent(conversationId, runId, "reliability-transition", { kind: "handoff", key: "handoff:" + event.id, provider: payload.provider, sessionId: payload.sessionId });
      if (payload.state === "compacting" && (!previous || previous.provider !== payload.provider || previous.sessionId !== payload.sessionId || previous.model !== payload.model || previous.generation !== payload.generation))
        this.insertEvent(conversationId, runId, "reliability-transition", { kind: "compaction", key: `compaction:${payload.provider}:${payload.sessionId}:${payload.model}:${payload.generation}`, provider: payload.provider, sessionId: payload.sessionId });
      // The summary arrives after the boundary; it joins the same notice.
      if (payload.compactSummary && payload.compactSummary !== previous?.compactSummary)
        this.insertEvent(conversationId, runId, "reliability-transition", { kind: "compaction", key: `compaction:${payload.provider}:${payload.sessionId}:${payload.model}:${payload.generation}`, provider: payload.provider, sessionId: payload.sessionId, summary: payload.compactSummary });
      this.db.exec("RELEASE context_event");
      return event;
    } catch (error) {
      this.db.exec("ROLLBACK TO context_event; RELEASE context_event");
      throw error;
    }
  }
  contextByProvider(conversationId) {
    const sessions = this.conversation(conversationId)?.sessions ?? {};
    return Object.fromEntries(this.db.prepare("SELECT provider,payload,last_event_id FROM conversation_context WHERE conversation_id=?").all(conversationId).flatMap((row) => {
      const payload = JSON.parse(row.payload), saved = sessions[row.provider];
      return payload.sessionId === (typeof saved === "string" ? saved : saved?.id)
        ? [[row.provider, { ...payload, eventId: row.last_event_id }]] : [];
    }));
  }
  insertEvent(conversationId, runId, type, payload) {
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
  reliabilityData(id) {
    const chat = this.conversation(id);
    if (!chat) throw new Error("Conversation not found");
    chat.timingIncomplete = !!this.db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND run_id IS NULL LIMIT 1").get(id);
    const runs = this.db.prepare(`SELECT r.*, (SELECT MAX(e.created_at) FROM events e WHERE e.run_id=r.id AND e.type IN ('text','work','context-usage')) AS last_progress_at FROM runs r WHERE conversation_id=? ORDER BY created_at,rowid`).all(id);
    const events = this.db.prepare(`SELECT * FROM events WHERE conversation_id=? AND (
      type='reliability-transition' OR
      (type='context-usage' AND id IN (SELECT MAX(id) FROM events WHERE conversation_id=? AND type='context-usage' AND json_extract(payload,'$.state')='ready' GROUP BY run_id)) OR
      (type='work' AND (json_extract(payload,'$.kind')='host-command' OR (run_id IN (SELECT id FROM runs WHERE conversation_id=? ORDER BY created_at DESC LIMIT 30) AND json_extract(payload,'$.kind') IN ('tool','tool-result','tool_call','tool_call_update','land-result'))))
    ) ORDER BY id`).all(id, id, id).map((e) => ({ id: e.id, type: e.type, payload: JSON.parse(e.payload), runId: e.run_id, createdAt: e.created_at }));
    const actions = this.db.prepare("SELECT payload,created_at FROM reliability_actions WHERE conversation_id=? ORDER BY rowid").all(id).map((a) => ({ ...JSON.parse(a.payload), createdAt: a.created_at }));
    return { chat, runs, events, actions, lastEventId: this.latestEventId() };
  }
  saveReliabilityAction(id, action) {
    const previous = this.db.prepare("SELECT conversation_id,payload FROM reliability_actions WHERE action_id=?").get(action.actionId);
    if (previous) {
      if (previous.conversation_id !== id || previous.payload !== JSON.stringify(action)) throw new Error("Action ID was already used for a different action");
      return false;
    }
    this.db.prepare("INSERT INTO reliability_actions VALUES(?,?,?,?)").run(action.actionId, id, JSON.stringify(action), this.now());
    return true;
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
  recover() {
    this.db.prepare("UPDATE conversation_context SET payload=json_set(payload,'$.state','outdated') WHERE json_extract(payload,'$.state') IN ('ready','updating')").run();
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
    this.db
      .prepare(
        "UPDATE plan_reviews SET status='failed', error=?, updated_at=? WHERE status='running'",
      )
      .run(
        "Host restarted during the review. Ask for it again.",
        this.now(),
      );
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
        // Drive both lookups from recent runs to skip older event payloads.
        // A reply's first text event is enough to place the steps after it.
        `WITH recent AS MATERIALIZED (
          SELECT id, status FROM runs WHERE conversation_id=? ORDER BY created_at DESC LIMIT 30
        ), first_text AS (
          SELECT MIN(e.id) AS id
          FROM recent r CROSS JOIN events e INDEXED BY events_run_type_time
          WHERE e.run_id=r.id AND e.type='text' AND e.conversation_id=?
          GROUP BY json_extract(e.payload,'$.messageId')
        )
        SELECT e.id AS id, e.run_id, e.type, e.payload, r.status
        FROM recent r CROSS JOIN events e INDEXED BY events_run_type_time
        WHERE e.run_id=r.id AND e.type='work' AND e.conversation_id=?
          AND json_extract(e.payload,'$.kind') NOT IN ('command-output','token-usage')
        UNION ALL
        SELECT e.id, e.run_id, e.type, e.payload, r.status
        FROM first_text f JOIN events e ON e.id=f.id JOIN recent r ON r.id=e.run_id
        ORDER BY id`,
      )
      .all(conversationId, conversationId, conversationId)) {
      const run = (byRun[e.run_id] ??= { status: e.status, payloads: [] });
      run.payloads.push({ id: e.id, type: e.type, payload: JSON.parse(e.payload) });
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
  proposedPlans(conversationId) {
    return Object.fromEntries(
      this.db
        .prepare(
          "SELECT run_id, payload FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE conversation_id=? AND type='proposed-plan' GROUP BY run_id)",
        )
        .all(conversationId)
        .map((event) => [event.run_id, JSON.parse(event.payload).text]),
    );
  }
  savePlanReview({ conversationId, runId, plan, status, reviewer, result, error }) {
    this.db
      .prepare(
        `INSERT INTO plan_reviews(run_id,conversation_id,plan,status,reviewer,result,error,updated_at)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id) DO UPDATE SET
           conversation_id=excluded.conversation_id,
           plan=excluded.plan,
           status=excluded.status,
           reviewer=excluded.reviewer,
           result=excluded.result,
           error=excluded.error,
           updated_at=excluded.updated_at`,
      )
      .run(
        runId,
        conversationId,
        plan ?? null,
        status,
        reviewer ? JSON.stringify(reviewer) : null,
        result ? JSON.stringify(result) : null,
        error ?? null,
        this.now(),
      );
    return this.planReview(conversationId, runId);
  }
  planReview(conversationId, runId) {
    return this.planReviews(conversationId)[runId] ?? null;
  }
  planReviews(conversationId) {
    return Object.fromEntries(
      this.db
        .prepare(
          "SELECT * FROM plan_reviews WHERE conversation_id=? ORDER BY updated_at",
        )
        .all(conversationId)
        .map((row) => [
          row.run_id,
          {
            plan: row.plan,
            status: row.status,
            reviewer: row.reviewer ? JSON.parse(row.reviewer) : null,
            result: row.result ? JSON.parse(row.result) : null,
            error: row.error,
            updatedAt: row.updated_at,
          },
        ]),
    );
  }
  // The plan the latest finished run left for the user to confirm or revise.
  // A plan approved during the run, or one carried out by a Goal, is not open.
  openPlan(conversationId) {
    const run = this.db
      .prepare(
        "SELECT id, status, mode FROM runs WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(conversationId);
    if (!run || run.status !== "completed" || run.mode === "goal") return null;
    const plan = this.proposedPlans(conversationId)[run.id];
    if (!plan?.trim()) return null;
    const approved = this.db
      .prepare(
        "SELECT 1 FROM approvals WHERE run_id=? AND json_extract(request,'$.kind')='plan' AND json_extract(response,'$.allow')=1 LIMIT 1",
      )
      .get(run.id);
    return approved ? null : { runId: run.id, plan, mode: run.mode };
  }
  conversationStatus(id) {
    const activeRun = this.activeRun(id);
    if (activeRun) Object.assign(activeRun, this.runProgress(activeRun.id));
    const latestRun = activeRun ?? this.db.prepare("SELECT id FROM runs WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id);
    return {
      id,
      activeRun,
      pause: activeRun ? activeRun.pause : (latestRun ? this.runProgress(latestRun.id).pause : undefined),
      lastEventId: this.latestEventId(),
    };
  }
  conversationSnapshot(id) {
    const status = this.conversationStatus(id);
    return {
      ...this.conversation(id),
      ...status,
      contextByProvider: this.contextByProvider(id),
      messages: this.messages(id),
      proposedPlans: this.proposedPlans(id),
      planReviews: this.planReviews(id),
      openPlan: this.openPlan(id),
      queue: this.queuedInputs(id),
      watches: this.watchStore.list(id).map(({ checkpoint, rootId, originRunId, runner, ...watch }) => watch),
      approvals: this.pendingApprovals(id),
      comments: this.comments(id),
      artifacts: this.db
        .prepare(
          "SELECT * FROM artifacts WHERE conversation_id=? ORDER BY created_at DESC",
        )
        .all(id),
      runs: this.db
        .prepare(
          "SELECT * FROM runs WHERE conversation_id=? ORDER BY created_at DESC",
        )
        .all(id),
      steps: this.steps(id),
      lastEventId: this.latestEventId(),
    };
  }
  runProgress(runId) {
    const progress = {};
    for (const [key, kind] of [["startup", "provider-startup"], ["pause", "cancellation"]]) {
      const row = this.db.prepare(`SELECT payload FROM events WHERE run_id=? AND type='work'
        AND json_extract(payload,'$.kind') IN ('provider-startup','cancellation')
        AND json_extract(payload,'$.kind')=? ORDER BY id DESC LIMIT 1`).get(runId, kind);
      if (row) progress[key] = JSON.parse(row.payload);
    }
    return progress;
  }
}
