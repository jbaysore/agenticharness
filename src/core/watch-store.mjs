// Watch state and the continuation outbox share the workspace database. A result
// and its delivery intent are one row, so a restart cannot lose one of them.
export class WatchStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS background_watches(
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        result_at TEXT,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS watches_conversation ON background_watches(conversation_id);
      CREATE TABLE IF NOT EXISTS watch_targets(key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watch_wakes(
        action_id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL,
        watch_id TEXT NOT NULL UNIQUE REFERENCES background_watches(id) ON DELETE CASCADE
      );
    `);
  }
  list(chatId, id) {
    return this.db
      .prepare(
        `SELECT payload FROM background_watches
      ${chatId ? "WHERE conversation_id=?" : ""} ORDER BY rowid`,
      )
      .all(...(chatId ? [chatId] : []))
      .map((row) => JSON.parse(row.payload))
      .filter((watch) => !id || watch.id === id);
  }
  get(id) {
    const row = this.db
      .prepare("SELECT payload FROM background_watches WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.payload) : null;
  }
  save(watch) {
    this.db
      .prepare(
        `INSERT INTO background_watches(id,conversation_id,status,result_at,payload)
      VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,
      result_at=excluded.result_at,payload=excluded.payload`,
      )
      .run(
        watch.id,
        watch.chatId,
        watch.status,
        watch.resultAt ?? null,
        JSON.stringify(watch),
      );
    return watch;
  }
  target(key) {
    const row = this.db
      .prepare("SELECT payload FROM watch_targets WHERE key=?")
      .get(key);
    return row
      ? JSON.parse(row.payload)
      : { key, cache: {}, nextCheckAt: 0, failures: 0 };
  }
  saveTarget(target) {
    this.db
      .prepare(
        `INSERT INTO watch_targets(key,payload) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET payload=excluded.payload`,
      )
      .run(target.key, JSON.stringify(target));
  }
  // Reserve once, including across crashes before createRun. A run with the
  // action ID is the receipt that execution started; it must never be replayed.
  reserve(watch) {
    const actionId = `watch-${watch.id}`;
    if (
      this.db
        .prepare("SELECT 1 FROM watch_wakes WHERE action_id=?")
        .get(actionId)
    )
      return actionId;
    const count = this.db
      .prepare("SELECT count(*) AS n FROM watch_wakes WHERE root_id=?")
      .get(watch.rootId).n;
    if (count >= 3) return null;
    this.db
      .prepare(
        "INSERT INTO watch_wakes(action_id,root_id,watch_id) VALUES(?,?,?)",
      )
      .run(actionId, watch.rootId, watch.id);
    return actionId;
  }
}
