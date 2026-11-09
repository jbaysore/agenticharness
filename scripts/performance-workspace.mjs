// Read-only comparison against an existing archive; never constructs/migrates Store.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { Store } from "../src/core/store.mjs";
import { WatchStore } from "../src/core/watch-store.mjs";

const path =
  process.argv[2] ??
  join(
    process.env.LOCALAPPDATA ?? homedir(),
    "AgenticHarness",
    "workspace.sqlite",
  );
const db = new DatabaseSync(path, { readOnly: true });
const store = Object.create(Store.prototype);
store.db = db;
store.watchStore = Object.assign(Object.create(WatchStore.prototype), { db });
const sql = Store.prototype.steps
  .toString()
  .match(/`(SELECT e\.id,[\s\S]*?)`/)[1];
const oldSql = sql.replace("WHERE e.conversation_id=? AND ", "WHERE ");
const timed = (run) => {
  const start = performance.now();
  const value = run();
  return { value, ms: Math.round(performance.now() - start) };
};
try {
  const chats = db
    .prepare(
      "SELECT conversation_id,count(*) AS events FROM events WHERE conversation_id IS NOT NULL GROUP BY conversation_id ORDER BY events DESC LIMIT 4",
    )
    .all();
  const rows = [];
  for (const { conversation_id: id, events } of chats) {
    const before = timed(() => db.prepare(oldSql).all(id, id, id));
    const after = timed(() => db.prepare(sql).all(id, id, id, id));
    assert.deepEqual(after.value, before.value);
    const snapshot = timed(() => store.conversationSnapshot(id));
    rows.push({
      chatId: id,
      events,
      beforeQueryMs: before.ms,
      afterQueryMs: after.ms,
      snapshotMs: snapshot.ms,
      statusMs: timed(() => store.conversationStatus(id)).ms,
      identical: true,
    });
  }
  console.log(JSON.stringify({ readOnly: true, samples: rows }, null, 2));
} finally {
  db.close();
}
