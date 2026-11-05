import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { retryFileOperation } from "../src/core/file-retry.mjs";
import { atomicJson } from "../src/core/restart-state.mjs";

test("atomic replacement retains the previous state while Windows readers deny replacement", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harness-file-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  await atomicJson(path, { revision: "previous" });
  let attempts = 0, elapsed = 0;
  await atomicJson(path, { revision: "next" }, {
    replace: async (from, to) => {
      if (++attempts < 4) {
        assert.deepEqual(JSON.parse(await readFile(path)), { revision: "previous" });
        throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
      }
      return rename(from, to);
    },
    retry: { platform: "win32", now: () => elapsed, sleep: async (ms) => { elapsed += ms; } },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(JSON.parse(await readFile(path)), { revision: "next" });
  await assert.rejects(atomicJson(path, {}, {
    replace: async () => { throw Object.assign(new Error("permanent denial"), { code: "EACCES" }); },
    retry: { platform: "win32", timeoutMs: 100, now: () => elapsed, sleep: async (ms) => { elapsed += ms; } },
  }), /permanent denial/);
  assert.deepEqual(JSON.parse(await readFile(path)), { revision: "next" });
  assert.deepEqual(await readdir(dir), ["state.json"]);
});

test("file retries do not mask unrelated errors or retry on other platforms", async () => {
  for (const [platform, code] of [["win32", "ENOENT"], ["linux", "EPERM"]]) {
    let attempts = 0;
    await assert.rejects(retryFileOperation(() => { attempts++; throw Object.assign(new Error(code), { code }); }, { platform }), { code });
    assert.equal(attempts, 1);
  }
});
