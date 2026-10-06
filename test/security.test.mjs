import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Authentication, safeOrigin } from "../src/security/http.mjs";
import { readRepositoryFile } from "../src/core/repository.mjs";

test("pairing is one-time, browser tokens persist only as hashes, and revocation works", () => {
  const store = new Store(":memory:"),
    auth = new Authentication(store),
    code = auth.pairing(),
    token = auth.pair(code, "local");
  const req = { headers: { cookie: "harness_session=" + token } };
  assert.equal(auth.authenticated(req), true);
  assert.throws(() => auth.pair(code, "local"), /expired/);
  assert.doesNotMatch(
    JSON.stringify(store.setting("browser-sessions")),
    new RegExp(token),
  );
  auth.logout(req);
  assert.equal(auth.authenticated(req), false);
  store.close();
});
test("DNS rebinding, foreign Origin, and cross-site requests are rejected", () => {
  const origin = "http://127.0.0.1:47831",
    request = (headers) => ({ headers });
  assert.equal(
    safeOrigin(request({ host: "127.0.0.1:47831", origin }), origin),
    true,
  );
  assert.equal(
    safeOrigin(request({ host: "attacker.example:47831" }), origin),
    false,
  );
  assert.equal(
    safeOrigin(
      request({ host: "127.0.0.1:47831", origin: "https://attacker.example" }),
      origin,
    ),
    false,
  );
  assert.equal(
    safeOrigin(
      request({ host: "127.0.0.1:47831", "sec-fetch-site": "cross-site" }),
      origin,
    ),
    false,
  );
  assert.equal(
    safeOrigin(
      request({ host: "private.example", origin: "https://private.example" }),
      origin,
      "https://private.example",
    ),
    true,
  );
});
test("file panel refuses traversal, private config, and junctions escaping the project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-path-")),
    repo = join(dir, "repo"),
    outside = join(dir, "outside");
  await mkdir(repo);
  await mkdir(outside);
  await writeFile(join(repo, "ok.txt"), "ok");
  await writeFile(join(outside, "secret.txt"), "private");
  await writeFile(join(repo, ".env"), "secret");
  assert.equal((await readRepositoryFile(repo, "ok.txt")).content, "ok");
  await assert.rejects(
    readRepositoryFile(repo, "../outside/secret.txt"),
    /outside/,
  );
  await assert.rejects(readRepositoryFile(repo, ".env"), /Private/);
  await symlink(
    outside,
    join(repo, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    readRepositoryFile(repo, "escape/secret.txt"),
    /outside/,
  );
  await rm(dir, { recursive: true, force: true });
});
