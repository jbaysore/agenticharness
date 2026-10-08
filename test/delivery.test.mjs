import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
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

test("remote origin requires the owner's Cloudflare Access token, in addition to pairing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-remote-"));
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }),
    stranger = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const token = (claims, key = privateKey) => {
    const body = [{ alg: "RS256", kid: "key-1" }, claims]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .join(".");
    return (
      body +
      "." +
      sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")
    );
  };
  const owner = {
    iss: "https://team.cloudflareaccess.example",
    aud: ["harness-audience"],
    email: "Owner@example.test",
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const app = await createHarness({
    dataDir: dir,
    port: 0,
    startProviders: false,
    publicOrigin: "https://harness.example.test",
    remoteIdentityHash: createHash("sha256")
      .update("owner@example.test")
      .digest("hex"),
    access: {
      teamDomain: "team.cloudflareaccess.example",
      audience: "harness-audience",
    },
    accessKeys: async () => [
      { ...publicKey.export({ format: "jwk" }), kid: "key-1" },
    ],
  });
  try {
    const headers = { Host: "harness.example.test" },
      status = async (assertion) =>
        (
          await proxyFetch(app.runtime.origin + "/api/state", {
            headers: assertion
              ? { ...headers, "Cf-Access-Jwt-Assertion": assertion }
              : // A spoofed proxy identity header must not count as signed in.
                { ...headers, "Tailscale-User-Login": "owner@example.test" },
          })
        ).status;
    assert.equal(await status(), 403);
    assert.equal(await status(token(owner, stranger)), 403);
    assert.equal(
      await status(token({ ...owner, email: "other@example.test" })),
      403,
    );
    assert.equal(await status(token({ ...owner, aud: ["another-app"] })), 403);
    assert.equal(await status(token({ ...owner, exp: owner.exp - 600 })), 403);
    assert.equal(await status(token(owner)), 401);
    const result = await proxyFetch(app.runtime.origin + "/api/pair", {
      method: "POST",
      headers: {
        ...headers,
        "Cf-Access-Jwt-Assertion": token(owner),
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
