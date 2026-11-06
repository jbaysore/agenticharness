import test from "node:test";
import assert from "node:assert/strict";
import {
  identitiesMatch,
  killIfMatched,
  processIdentity,
} from "../src/core/process-identity.mjs";

test("process identity matches this process and a reused id is not killed", async () => {
  const self = await processIdentity(process.pid);
  assert.ok(self?.createdAt);
  assert.equal(identitiesMatch(self, self), true);
  const shifted = {
    pid: self.pid,
    createdAt: new Date(Date.parse(self.createdAt) + 5000).toISOString(),
  };
  assert.equal(identitiesMatch(self, shifted), false);
  const kills = [];
  const outcome = await killIfMatched(self, {
    identity: async () => shifted,
    kill: async (pid) => kills.push(pid),
  });
  assert.equal(outcome.killed, false);
  assert.deepEqual(kills, []);
});
