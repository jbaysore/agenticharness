import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server.mjs";

test("new chats default to auto-review and permission selections persist immediately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-permissions-http-"));
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
    const project = app.store.addProject("Permission defaults", dir),
      chat = (await call("/api/chats", { projectId: project.id })).body,
      sessions = { codex: { id: "keep-permission-session" } };
    assert.equal(chat.permissions, "auto");
    app.store.updateConversation(chat.id, { sessions });
    for (const permissions of ["override", "auto", "manual"]) {
      const changed = await call(
        "/api/chats/" + chat.id,
        { permissions },
        "PATCH",
      );
      assert.equal(changed.status, 200);
      assert.equal(changed.body.permissions, permissions);
      assert.equal(app.store.conversation(chat.id).permissions, permissions);
      assert.deepEqual(changed.body.sessions, sessions);
      assert.equal(app.store.messages(chat.id).length, 0);
    }
    for (const permissions of ["invalid", null, false]) {
      assert.equal(
        (await call("/api/chats/" + chat.id, { permissions }, "PATCH")).status,
        400,
      );
      assert.equal(app.store.conversation(chat.id).permissions, "manual");
    }
    assert.equal(
      (
        await call("/api/chats", {
          projectId: project.id,
          permissions: "override",
        })
      ).body.permissions,
      "override",
    );
    await app.close();
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false });
    assert.equal(app.store.conversation(chat.id).permissions, "manual");
    assert.deepEqual(app.store.conversation(chat.id).sessions, sessions);
    assert.equal(
      (await call("/api/chats", { projectId: project.id })).body.permissions,
      "auto",
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("real local HTTP server admits the host PC without pairing, enforces same-origin writes, and keeps stored history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-http-")),
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false });
  const url = app.runtime.origin;
  try {
    assert.equal((await fetch(url + "/api/state")).status, 200);
    assert.equal(
      (await fetch(url.replace("127.0.0.1", "localhost") + "/api/state"))
        .status,
      200,
    );
    // Tunnel traffic also arrives over loopback; it is not the host PC.
    assert.equal(
      (
        await fetch(url + "/api/state", {
          headers: { "Cf-Connecting-IP": "203.0.113.9" },
        })
      ).status,
      401,
    );
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

test("history defaults persist across restarts and apply only to new conversations without resetting sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-history-settings-"));
  let app = await createHarness({
    dataDir: dir,
    port: 0,
    startProviders: false,
  });
  const headers = {
    "Content-Type": "application/json",
    "X-Harness-Client": "1",
  };
  const call = async (path, body, method = "POST") => {
    const response = await fetch(app.runtime.origin + path, {
      method,
      headers,
      body: body && JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const project = app.store.addProject("History defaults", dir);
    assert.deepEqual((await call("/api/settings", undefined, "GET")).body, {
      defaultHistoryScope: "all",
    });
    const original = (await call("/api/chats", { projectId: project.id })).body;
    assert.equal(original.scope, "all");
    const sessions = {
      codex: { id: "keep-codex-thread" },
      claude: { id: "keep-claude-session" },
      cursor: { id: "keep-cursor-session" },
    };
    app.store.updateConversation(original.id, { sessions });
    const run = app.store.createRun({
      conversationId: original.id,
      actionId: "history-setting-active-turn",
      provider: "codex",
      model: "fixture",
      text: "Keep my context",
    });
    const originalTitle = app.store.conversation(original.id).title;
    for (const active of [true, false]) {
      if (!active) app.store.setRun(run.id, "completed");
      const rejected = await call(
        "/api/chats/" + original.id,
        { scope: "project", title: "Must not rename" },
        "PATCH",
      );
      assert.equal(rejected.status, 409);
      assert.match(rejected.body.error, /new conversations/);
      assert.equal(app.store.conversation(original.id).title, originalTitle);
      assert.deepEqual(app.store.conversation(original.id).sessions, sessions);
      // The global default can be changed even while a turn is active.
      assert.equal(
        (
          await call(
            "/api/settings",
            { defaultHistoryScope: active ? "project" : "none" },
            "PATCH",
          )
        ).status,
        200,
      );
      const next = (await call("/api/chats", { projectId: project.id })).body;
      assert.equal(next.scope, active ? "project" : "none");
      assert.equal(app.store.conversation(original.id).scope, "all");
      assert.deepEqual(app.store.conversation(original.id).sessions, sessions);
    }
    const invalid = await call(
      "/api/settings",
      { defaultHistoryScope: "invalid" },
      "PATCH",
    );
    assert.equal(invalid.status, 400);
    assert.equal(app.store.settings().defaultHistoryScope, "none");
    assert.throws(
      () => app.store.updateConversation(original.id, { scope: "project" }),
      /fixed/,
    );
    assert.ok(app.store.events().some((e) => e.type === "settings"));
    await app.close();
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false });
    const state = (await call("/api/state", undefined, "GET")).body;
    assert.deepEqual(state.settings, { defaultHistoryScope: "none" });
    assert.equal(app.store.conversation(original.id).scope, "all");
    assert.deepEqual(app.store.conversation(original.id).sessions, sessions);
    assert.equal(app.store.messages(original.id)[0].content, "Keep my context");
    assert.equal(
      (await call("/api/chats", { projectId: project.id })).body.scope,
      "none",
    );
    await call("/api/settings", { defaultHistoryScope: "all" }, "PATCH");
    assert.equal(
      (await call("/api/chats", { projectId: project.id })).body.scope,
      "all",
    );
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
    app.controller.active.set(chat.id, { abort: new AbortController() });
    const pinnedWhileBusy = await call(
      `/api/chats/${chat.id}`,
      { pinned: true },
      "PATCH",
    );
    assert.equal(pinnedWhileBusy.status, 200);
    assert.ok(pinnedWhileBusy.body.pinned_at);
    assert.equal((await listed()).id, chat.id);
    app.controller.active.delete(chat.id);
    assert.equal(
      (await call(`/api/chats/${chat.id}`, { pinned: false }, "PATCH")).body
        .pinned_at,
      null,
    );
    assert.equal((await call("/api/chats/missing/read", {})).status, 404);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent rules are saved through the API, validated, and announced", async () => {
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
    const call = async (path, body, method = "GET") => {
      const response = await fetch(url + path, {
        method,
        headers,
        body: body && JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    app.controller.providers = [
      {
        id: "claude",
        name: "Claude Code",
        connected: true,
        models: [
          {
            id: "haiku",
            name: "Haiku",
            efforts: [],
            resolvedModel: "claude-haiku-5-5",
          },
        ],
      },
    ];
    const initial = (await call("/api/state")).body;
    assert.equal(initial.rules.instructions, "");
    assert.equal(initial.rules.delegate.enabled, false);
    assert.deepEqual(initial.rules.delegate.workers, []);
    assert.equal(initial.rules.delegate.actions.edit, true);
    assert.deepEqual(initial.delegation, {});
    const announced = [];
    app.controller.on("event", (e) => announced.push(e.type));
    const rejected = await call(
      "/api/rules",
      { delegate: { enabled: true, workers: [] } },
      "PUT",
    );
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /Choose a worker model/);
    assert.deepEqual(announced, []);
    const saved = await call(
      "/api/rules",
      {
        instructions: "Keep answers short.",
        delegate: {
          enabled: true,
          workers: [{ provider: "claude", model: "haiku" }],
          actions: { draft: false },
        },
      },
      "PUT",
    );
    assert.equal(saved.status, 200);
    assert.deepEqual(announced, ["rules"]);
    const { rules } = (await call("/api/state")).body;
    assert.equal(rules.instructions, "Keep answers short.");
    assert.deepEqual(rules.delegate.workers, [
      {
        provider: "claude",
        model: "haiku",
        effort: null,
        name: "Claude Code · Haiku",
        priced: true,
        available: true,
        reason: null,
      },
    ]);
    assert.equal(rules.delegate.actions.draft, false);
    assert.equal(rules.delegate.actions.run, true);
    app.controller.providers[0].blockReason = "Out of usage.";
    assert.deepEqual(
      (await call("/api/state")).body.rules.delegate.workers.map((w) => [
        w.available,
        w.reason,
      ]),
      [[false, "Out of usage."]],
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
