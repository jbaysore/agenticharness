import test from "node:test";
import assert from "node:assert/strict";
import { placeWatches } from "../src/ui/watch-order.mjs";

const at = (s) => new Date(Date.UTC(2026, 10, 3, 12, 0, s)).toISOString();
const ms = (s) => Date.parse(at(s));

test("watch cards stay with the turn that registered them", () => {
  const messages = [
    { id: "u1", role: "user", created_at: at(0) },
    { id: "a1", role: "assistant", created_at: at(20) },
    { id: "w1", role: "user", source: "watcher", created_at: at(30) },
    { id: "a2", role: "assistant", created_at: at(40) },
    { id: "u2", role: "user", created_at: at(50) },
  ];
  const first = { id: "first", createdAt: ms(10) },
    second = { id: "second", createdAt: ms(45) },
    latest = { id: "latest", createdAt: ms(55) },
    undated = { id: "undated" };
  const placed = placeWatches(messages, [first, second, latest, undated]);
  assert.deepEqual(placed.get("w1"), [first]);
  assert.deepEqual(placed.get("u2"), [second]);
  assert.deepEqual(placed.get(null), [latest, undated]);
});
