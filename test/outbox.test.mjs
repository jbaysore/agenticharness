import test from "node:test";
import assert from "node:assert/strict";
import { readAllPending, readPending, savePending } from "../src/ui/outbox.mjs";
import {
  readDraft,
  saveDraft,
  readDraftAttachments,
  saveDraftAttachments,
} from "../src/ui/drafts.mjs";
const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k),
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
};
const blocked = {
  getItem: () => {
    throw Error("disabled");
  },
  setItem: () => {
    throw Error("disabled");
  },
};
test("unconfirmed submission survives a reload with its original action ID", () => {
  const storage = memory();
  const body = {
    actionId: "stable-action-12345",
    chatId: "chat",
    text: "An uncertain submission",
    provider: "codex",
    model: "model",
  };
  assert.equal(savePending("chat", body, storage), true);
  assert.deepEqual(readPending("chat", storage), body);
  savePending("chat", null, storage);
  assert.equal(readPending("chat", storage), null);
  assert.equal(storage.data.size, 0);
});
test("each chat keeps its own unconfirmed submission", () => {
  const storage = memory();
  const first = { actionId: "action-for-first", chatId: "a", text: "one" },
    second = { actionId: "action-for-second", chatId: "b", text: "two" };
  savePending("a", first, storage);
  savePending("b", second, storage);
  assert.deepEqual(readAllPending(storage), { a: first, b: second });
  savePending("a", null, storage);
  assert.equal(readPending("a", storage), null);
  assert.deepEqual(readPending("b", storage), second);
});
test("a submission saved by the single-chat build is still reconciled", () => {
  const old = { actionId: "saved-before-update", chatId: "a", text: "kept" },
    storage = memory({
      "harness.pending-submission.v1": JSON.stringify(old),
    });
  assert.deepEqual(readPending("a", storage), old);
  savePending("a", null, storage);
  assert.equal(readPending("a", storage), null);
  assert.equal(storage.data.size, 0);
});
test("broken or blocked browser storage does not submit or crash", () => {
  assert.equal(readPending("chat", { getItem: () => "{invalid" }), null);
  assert.equal(readPending("chat", blocked), null);
  assert.equal(savePending("chat", { actionId: "x" }, blocked), false);
});
test("a draft stays with its chat and blocked storage loses it quietly", () => {
  const storage = memory();
  saveDraft("a", "half a thought", storage);
  saveDraft("b", "another", storage);
  assert.equal(readDraft("a", storage), "half a thought");
  assert.equal(readDraft("b", storage), "another");
  saveDraft("a", "", storage);
  assert.equal(readDraft("a", storage), "");
  saveDraft("b", "", storage);
  assert.equal(storage.data.size, 0);
  assert.equal(readDraft("a", blocked), "");
  assert.equal(saveDraft("a", "text", blocked), false);
});

test("attachment drafts and unconfirmed sends preserve file references without storing file bytes", () => {
  const storage = memory(),
    files = [
      {
        id: "file-id",
        name: "screen.png",
        type: "image/png",
        size: 123,
        url: "/api/attachments/file-id",
      },
    ];
  saveDraftAttachments("a", files, storage);
  assert.deepEqual(readDraftAttachments("a", storage), files);
  assert.deepEqual(readDraftAttachments("b", storage), []);
  const pending = {
    actionId: "attachment-retry",
    chatId: "a",
    text: "",
    attachments: [files[0].id],
    attachmentFiles: files,
  };
  savePending("a", pending, storage);
  assert.deepEqual(readPending("a", storage), pending);
  saveDraftAttachments("a", [], storage);
  assert.deepEqual(readDraftAttachments("a", storage), []);
  assert.deepEqual(readDraftAttachments("a", blocked), []);
  assert.equal(saveDraftAttachments("a", files, blocked), false);
});
