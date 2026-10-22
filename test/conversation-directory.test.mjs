import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server.mjs";

test("only unstarted conversations can change their project directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-directory-")),
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false });
  const change = async (chat, projectId) => {
    const response = await fetch(`${app.runtime.origin}/api/chats/${chat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Harness-Client": "1" },
      body: JSON.stringify({ projectId }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const first = app.store.addProject("First", join(dir, "first")),
      second = app.store.addProject("Second", join(dir, "second")),
      chat = app.store.createConversation({
        projectId: first.id,
        provider: "codex",
        model: "fixture",
        permissions: "manual",
        mode: "plan",
        scope: "project",
      });
    const result = await change(chat, second.id);
    assert.equal(result.status, 200);
    assert.equal(result.body.project_id, second.id);
    for (const field of [
      "id",
      "provider",
      "model",
      "permissions",
      "mode",
      "scope",
    ])
      assert.equal(result.body[field], chat[field]);
    assert.equal((await change(chat, "missing")).status, 400);
    assert.equal(app.store.conversation(chat.id).project_id, second.id);

    const started = app.store.createConversation({ projectId: first.id });
    const run = app.store.createRun({
      conversationId: started.id,
      actionId: crypto.randomUUID(),
      provider: "codex",
      model: "fixture",
      text: "Already sent",
    });
    for (const status of ["running", "completed"]) {
      app.store.setRun(run.id, status);
      const rejected = await change(started, second.id);
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.error, /before sending the first message/);
      assert.equal(app.store.conversation(started.id).project_id, first.id);
    }
    const resumed = app.store.createConversation({ projectId: first.id });
    app.store.updateConversation(resumed.id, {
      sessions: { codex: { id: "native" } },
    });
    assert.equal((await change(resumed, second.id)).status, 400);
    const imported = app.store.createConversation({ projectId: first.id });
    app.store.addMessage({
      conversationId: imported.id,
      role: "user",
      content: "Imported",
    });
    assert.equal((await change(imported, second.id)).status, 400);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
