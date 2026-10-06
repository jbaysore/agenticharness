import test from "node:test";
import assert from "node:assert/strict";
import { readPending, savePending } from "../src/ui/outbox.mjs";
test("unconfirmed submission survives a reload with its original action ID", () => {
  const data = new Map(),
    storage = {
      getItem: (k) => data.get(k),
      setItem: (k, v) => data.set(k, v),
      removeItem: (k) => data.delete(k),
    };
  const body = {
    actionId: "stable-action-12345",
    chatId: "chat",
    text: "An uncertain submission",
    provider: "codex",
    model: "model",
  };
  assert.equal(savePending(body, storage), true);
  assert.deepEqual(readPending(storage), body);
  savePending(null, storage);
  assert.equal(readPending(storage), null);
});
test("broken or blocked browser storage does not submit or crash", () => {
  assert.equal(readPending({ getItem: () => "{invalid" }), null);
  const blocked = {
    getItem: () => {
      throw Error("disabled");
    },
    setItem: () => {
      throw Error("disabled");
    },
  };
  assert.equal(readPending(blocked), null);
  assert.equal(savePending({ actionId: "x" }, blocked), false);
});
