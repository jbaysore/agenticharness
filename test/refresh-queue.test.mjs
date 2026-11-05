import test from "node:test";
import assert from "node:assert/strict";
import { refreshQueue } from "../src/ui/refresh-queue.mjs";

test("refresh bursts share a read and mutations during it receive a fresh snapshot", async () => {
  const reads = [], applied = [];
  const request = refreshQueue(() => {
    const read = Promise.withResolvers(); reads.push(read); return read.promise;
  }, (value) => applied.push(value));
  const first = request();
  assert.equal(request(), first);
  await Promise.resolve();
  assert.equal(reads.length, 1);
  const afterMutation = request();
  reads[0].resolve("before mutation");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(reads.length, 2);
  reads[1].resolve("after mutation");
  assert.equal(await first, "after mutation");
  assert.equal(await afterMutation, "after mutation");
  assert.deepEqual(applied, ["before mutation", "after mutation"]);
});

test("refresh failures release the queue for retry", async () => {
  let attempts = 0;
  const request = refreshQueue(async () => { if (!attempts++) throw new Error("offline"); return "reconnected"; }, () => {});
  await assert.rejects(request(), /offline/);
  assert.equal(await request(), "reconnected");
});
