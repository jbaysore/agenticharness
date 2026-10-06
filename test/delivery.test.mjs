import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createHarness } from "../src/server.mjs";
import { request } from "node:http";
// Undici fetch deliberately rewrites Host; raw HTTP exercises the reverse-proxy boundary.
const proxyFetch = (url, options = {}) =>
  new Promise((resolve, reject) => {
    const req = request(url, options, (res) => {
      res.resume();
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: {
            get: (name) => {
              const value = res.headers[name.toLowerCase()];
              return Array.isArray(value) ? value.join("; ") : value;
            },
          },
        }),
      );
    });
    req.on("error", reject);
    req.end(options.body);
  });

test("HTTPS proxy requires the configured owner identity, in addition to pairing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-remote-"));
  const app = await createHarness({
    dataDir: dir,
    port: 0,
    startProviders: false,
    publicOrigin: "https://test.tail.example:9443",
    remoteIdentityHash: createHash("sha256")
      .update("owner@example.test")
      .digest("hex"),
  });
  try {
    const headers = { Host: "test.tail.example:9443" };
    assert.equal(
      (await proxyFetch(app.runtime.origin + "/api/state", { headers })).status,
      403,
    );
    assert.equal(
      (
        await proxyFetch(app.runtime.origin + "/api/state", {
          headers: { ...headers, "Tailscale-User-Login": "other@example.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await proxyFetch(app.runtime.origin + "/api/state", {
          headers: { ...headers, "Tailscale-User-Login": "owner@example.test" },
        })
      ).status,
      401,
    );
    const result = await proxyFetch(app.runtime.origin + "/api/pair", {
      method: "POST",
      headers: {
        ...headers,
        "Tailscale-User-Login": "owner@example.test",
        "X-Harness-Client": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: app.auth.pairing() }),
    });
    assert.equal(result.status, 200);
    assert.match(result.headers.get("set-cookie"), /Secure/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live backup is consistent, contains history and excludes browser capabilities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-backup-")),
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false });
  try {
    const p = app.store.addProject("Backup test", dir),
      c = app.store.createConversation({ projectId: p.id });
    app.store.addMessage({
      conversationId: c.id,
      role: "user",
      content: "Evidence survives backup",
    });
    const token = app.auth.pair(app.auth.pairing(), "local"),
      result = await fetch(app.runtime.origin + "/api/backup", {
        method: "POST",
        headers: {
          Cookie: "harness_session=" + token,
          "X-Harness-Client": "1",
        },
      }).then((r) => r.json());
    const copy = new DatabaseSync(result.path);
    assert.equal(
      copy.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    assert.equal(
      copy.prepare("SELECT content FROM messages").get().content,
      "Evidence survives backup",
    );
    assert.equal(
      copy
        .prepare("SELECT value FROM settings WHERE key='browser-sessions'")
        .get(),
      undefined,
    );
    copy.close();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SSE replay starts after the acknowledged ID and restart preserves the same history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-reconnect-"));
  let app = await createHarness({
    dataDir: dir,
    port: 0,
    startProviders: false,
  });
  try {
    const p = app.store.addProject("Reconnect", dir),
      c = app.store.createConversation({ projectId: p.id });
    const first = app.controller.event(c.id, null, "work", {
      label: "before disconnect",
    });
    const second = app.controller.event(c.id, null, "work", {
      label: "while disconnected",
    });
    const token = app.auth.pair(app.auth.pairing(), "local"),
      abort = new AbortController();
    const response = await fetch(app.runtime.origin + "/api/events", {
      headers: {
        Cookie: "harness_session=" + token,
        "Last-Event-ID": String(first.id),
      },
      signal: abort.signal,
    });
    const reader = response.body.getReader(),
      chunk = new TextDecoder().decode((await reader.read()).value);
    abort.abort();
    await reader.cancel().catch(() => {});
    assert.match(chunk, new RegExp("id: " + second.id));
    assert.doesNotMatch(chunk, /before disconnect/);
    await app.close();
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false });
    assert.equal(app.store.events(first.id).length, 1);
    assert.equal(app.store.conversation(c.id).id, c.id);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
