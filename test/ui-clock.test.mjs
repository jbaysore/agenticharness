import test from "node:test";
import assert from "node:assert/strict";
import { createServerClock } from "../src/ui/clock.mjs";

test("usage time follows the host and advances despite a wrong or changed device clock", () => {
  let wall = 0, monotonic = 100;
  const clock = createServerClock({ wallNow: () => wall, monotonicNow: () => monotonic });
  assert.equal(clock.now(), 0);
  const host = 1_800_000_000_000;
  monotonic = 300;
  clock.observe(new Date(host).toUTCString());
  assert.equal(clock.now(), host);
  wall = host + 10 * 86400000;
  monotonic += 30000;
  assert.equal(clock.now(), host + 30000);
  clock.observe(null);
  clock.observe("invalid");
  assert.equal(clock.now(), host + 30000);
  monotonic += 500;
  clock.observe(new Date(host + 60000).toUTCString());
  assert.equal(clock.now(), host + 60000);
});
