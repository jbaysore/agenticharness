import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server.mjs";

test("real local HTTP server requires pairing, enforces same-origin writes, and keeps stored history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-http-")),
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false });
  const url = app.runtime.origin;
  try {
    assert.equal((await fetch(url + "/api/state")).status, 401);
    const code = app.auth.pairing(),
      headers = { "Content-Type": "application/json", "X-Harness-Client": "1" };
    const paired = await fetch(url + "/api/pair", {
      method: "POST",
      headers,
      body: JSON.stringify({ code }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (await fetch(url + "/api/state", { headers: { cookie } })).status,
      200,
    );
    assert.equal(
      (
        await fetch(url + "/api/projects", {
          method: "POST",
          headers: { cookie, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + "/api/state", {
          headers: { cookie, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const project = await fetch(url + "/api/projects", {
      method: "POST",
      headers: { ...headers, cookie },
      body: JSON.stringify({ path: dir, name: "Test project" }),
    }).then((r) => r.json());
    const chat = await fetch(url + "/api/chats", {
      method: "POST",
      headers: { ...headers, cookie },
      body: JSON.stringify({ projectId: project.id }),
    }).then((r) => r.json());
    assert.ok(chat.id);
    const state = await fetch(url + "/api/state", { headers: { cookie } }).then(
      (r) => r.json(),
    );
    assert.equal(state.conversations.length, 1);
    assert.equal(
      (
        await fetch(url + "/internal/history", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      401,
    );
    const response = await fetch(url + "/api/chats/" + chat.id + "/messages", {
      method: "POST",
      headers: { ...headers, cookie },
      body: JSON.stringify({
        actionId: "submit-once-12345",
        text: "hello",
        provider: "codex",
        model: "unverified",
      }),
    });
    assert.equal(response.status, 400);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a chat can be renamed, archived and marked read, and each change is announced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-http-")),
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false });
  const url = app.runtime.origin;
  try {
    const headers = {
      "Content-Type": "application/json",
      "X-Harness-Client": "1",
    };
    const paired = await fetch(url + "/api/pair", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: app.auth.pairing() }),
    });
    headers.cookie = paired.headers.get("set-cookie").split(";")[0];
    const call = async (path, body, method = "POST") => {
      const response = await fetch(url + path, {
        method,
        headers,
        body: body && JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const project = app.store.addProject("Test project", dir),
      chat = app.store.createConversation({ projectId: project.id });
    const run = app.store.createRun({
      conversationId: chat.id,
      actionId: "finished-elsewhere-1",
      provider: "codex",
      model: "m",
      text: "hello",
    });
    app.store.setRun(run.id, "completed");
    const listed = async () =>
      (await call("/api/state", undefined, "GET")).body.conversations[0];
    assert.equal((await listed()).unread, true);
    const announced = [];
    app.controller.on("event", (e) => announced.push(e.type));
    assert.equal((await call(`/api/chats/${chat.id}/read`, {})).status, 200);
    assert.equal((await listed()).unread, false);
    await call(`/api/chats/${chat.id}/read`, {});
    assert.deepEqual(announced, ["chat"]);
    const renamed = await call(
      `/api/chats/${chat.id}`,
      { title: "Renamed", archived: true },
      "PATCH",
    );
    assert.equal(renamed.body.title, "Renamed");
    assert.ok(renamed.body.archived_at);
    assert.deepEqual(announced, ["chat", "chat"]);
    app.controller.active.set(chat.id, { abort: new AbortController() });
    const busy = await call(
      `/api/chats/${chat.id}`,
      { archived: false },
      "PATCH",
    );
    assert.equal(busy.status, 400);
    assert.match(busy.body.error, /Stop the turn/);
    app.controller.active.delete(chat.id);
    assert.equal(
      (await call(`/api/chats/${chat.id}`, { archived: false }, "PATCH")).body
        .archived_at,
      null,
    );
    assert.equal((await call("/api/chats/missing/read", {})).status, 404);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
