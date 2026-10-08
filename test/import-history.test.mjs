import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { importLocalHistory } from "../src/core/import-history.mjs";

async function writeJsonl(file, rows) {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(
    file,
    rows.map((row) => JSON.stringify(row)).join("\n"),
  );
}

test("local transcripts import once, skip tools, and keep native sessions empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-import-"));
  const db = new Store(join(root, "workspace.sqlite"));
  const linescience = db.addProject(
    "linescience",
    "C:\\Users\\Joshua\\Projects\\linescience",
  );
  const cursorFile = join(
    root,
    "cursor",
    "c-Users-Joshua-Projects-linescience",
    "agent-transcripts",
    "chat-1",
    "chat-1.jsonl",
  );
  await writeJsonl(cursorFile, [
    {
      role: "user",
      message: {
        content: [
          { type: "text", text: "Trim the prefix" },
          { type: "tool_use", name: "shell", input: "secret" },
        ],
      },
    },
    {
      role: "assistant",
      message: { content: [{ type: "text", text: "Done" }] },
    },
    { type: "turn_ended", status: "success" },
  ]);
  const codexFile = join(root, "codex", "sessions", "2026", "thread.jsonl");
  await writeJsonl(codexFile, [
    {
      type: "session_meta",
      timestamp: "2026-07-10T17:53:53.568Z",
      payload: {
        cwd: "C:\\Users\\Joshua\\Projects\\linescience",
        timestamp: "2026-07-10T17:53:34.969Z",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-07-10T17:54:00.000Z",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "system prompt" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-07-10T17:55:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Explain the fee registry" }],
      },
    },
  ]);
  const claudeFile = join(root, "claude", "session.jsonl");
  await writeJsonl(claudeFile, [
    { type: "ai-title", aiTitle: "Quiet hours" },
    {
      type: "user",
      isSidechain: true,
      message: { content: "hidden subagent" },
    },
    {
      type: "user",
      timestamp: "2026-07-11T04:04:22.971Z",
      cwd: "C:\\Users\\Joshua\\Projects\\not-a-harness-project",
      message: { content: [{ type: "text", text: "Review the modal" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-07-11T04:05:00.000Z",
      message: {
        content: [
          { type: "text", text: "The modal is fine" },
          { type: "tool_use", name: "read" },
        ],
      },
    },
  ]);
  try {
    const first = await importLocalHistory(db, {
      cursorRoot: join(root, "cursor"),
      codexRoot: join(root, "codex"),
      claudeRoot: join(root, "claude"),
      importedPath: join(root, "imported"),
    });
    assert.equal(first.imported, 3);
    const chats = db.conversations();
    assert.equal(chats.length, 3);
    const cursor = chats.find((chat) => chat.provider === "cursor");
    const codex = chats.find((chat) => chat.provider === "codex");
    const claude = chats.find((chat) => chat.provider === "claude");
    assert.equal(cursor.project_id, linescience.id);
    assert.equal(codex.project_id, linescience.id);
    assert.notEqual(claude.project_id, linescience.id);
    assert.equal(cursor.title, "Trim the prefix");
    assert.equal(claude.title, "Quiet hours");
    assert.deepEqual(cursor.sessions, {});
    const cursorMessages = db.messages(cursor.id).map((message) => message.content);
    assert.match(cursorMessages[0], /not a resumable native session/);
    assert.match(cursorMessages[1], /Trim the prefix/);
    assert.equal(cursorMessages.some((content) => content.includes("secret")), false);
    const codexMessages = db.messages(codex.id).map((message) => message.content);
    assert.equal(
      codexMessages.some((content) => content.includes("system prompt")),
      false,
    );
    const claudeMessages = db.messages(claude.id).map((message) => message.content);
    assert.equal(
      claudeMessages.some((content) => content.includes("hidden subagent")),
      false,
    );
    assert.match(claudeMessages.join("\n"), /The modal is fine/);
    const second = await importLocalHistory(db, {
      cursorRoot: join(root, "cursor"),
      codexRoot: join(root, "codex"),
      claudeRoot: join(root, "claude"),
      importedPath: join(root, "imported"),
    });
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 3);
    assert.equal(db.conversations().length, 3);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
