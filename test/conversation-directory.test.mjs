import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server.mjs";

test("directoryless chats have private persistent workspaces and run without a user project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-directoryless-"));
  let app = await createHarness({
    dataDir: dir,
    port: 0,
    startProviders: false,
  });
  const call = async (path, body, method = "POST") => {
    const response = await fetch(app.runtime.origin + path, {
      method,
      headers: { "Content-Type": "application/json", "X-Harness-Client": "1" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal(
      (await call("/api/chats", { projectId: "missing" })).status,
      400,
    );
    const first = await call("/api/chats", {}),
      second = await call("/api/chats", { projectId: null });
    assert.equal(first.status, 201);
    assert.equal(first.body.directoryless, true);
    assert.equal(second.body.directoryless, true);
    const home = app.store.project(first.body.project_id);
    assert.equal(home.scratch, 1);
    assert.ok((await stat(home.path)).isDirectory());
    assert.notEqual(home.path, app.store.project(second.body.project_id).path);
    assert.equal(app.store.projects().filter((p) => !p.scratch).length, 0);
    // A new chat must never inherit another general chat's workspace.
    const third = (await call("/api/chats", { projectId: home.id })).body;
    assert.notEqual(third.project_id, home.id);

    const upload = await fetch(
      `${app.runtime.origin}/api/projects/${home.id}/attachments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Harness-Client": "1",
          "X-Harness-Filename": "notes.txt",
        },
        body: "General chat attachment",
      },
    );
    assert.equal(upload.status, 201);
    const file = await upload.json();
    const attempts = [];
    for (const provider of ["codex", "claude", "cursor"]) {
      app.controller.providers.push({
        id: provider,
        models: [{ id: "fixture", efforts: [] }],
      });
      app.controller.runners[provider] = async (ctx) => {
        attempts.push(ctx);
        return { status: "completed" };
      };
      const result = await call(`/api/chats/${first.body.id}/messages`, {
        actionId: crypto.randomUUID(),
        text: "A general question",
        provider,
        model: "fixture",
        attachments: [file.id],
      });
      assert.equal(result.status, 202);
      while (app.controller.active.has(first.body.id))
        await new Promise((resolve) => setTimeout(resolve, 5));
      const ctx = attempts.at(-1);
      assert.equal(ctx.project.path, home.path);
      assert.equal(ctx.project.worktree, undefined);
      assert.match(ctx.instructions, /No project directory is selected/);
      assert.doesNotMatch(ctx.instructions, /Shared workspace:/);
      assert.equal(
        await readFile(ctx.attachments[0].path, "utf8"),
        "General chat attachment",
      );
      assert.equal(app.store.conversation(first.body.id).status, "idle");
    }
    const real = app.store.addProject("Real project", dir);
    const projectChat = app.store.createConversation({ projectId: real.id });
    app.store.addMessage({
      conversationId: projectChat.id,
      role: "user",
      content: "A general question in a project",
    });
    const results = await fetch(
      `${app.runtime.origin}/api/search?q=general&directoryless=true`,
    ).then((r) => r.json());
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.conversation_id === first.body.id));
    assert.equal(
      (
        await call(
          `/api/chats/${first.body.id}`,
          { projectId: real.id },
          "PATCH",
        )
      ).status,
      400,
    );
    const changed = await call(
      `/api/chats/${second.body.id}`,
      { projectId: real.id },
      "PATCH",
    );
    assert.equal(changed.body.directoryless, false);
    const cleared = await call(
      `/api/chats/${second.body.id}`,
      { projectId: null },
      "PATCH",
    );
    assert.equal(cleared.body.directoryless, true);
    assert.notEqual(cleared.body.project_id, home.id);
    await app.close();
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false });
    assert.equal(app.store.conversation(first.body.id).directoryless, true);
    assert.equal(app.store.project(first.body.project_id).path, home.path);
    assert.equal(app.store.messages(first.body.id).length, 3);
    assert.equal(app.store.attachment(file.id).project_id, home.id);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

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
