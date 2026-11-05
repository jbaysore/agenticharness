import test from "node:test";
import assert from "node:assert/strict";
import {
  keepPendingMessages,
  readAllPending,
  readPending,
  savePending,
  prepareControlAction,
} from "../src/ui/outbox.mjs";
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

test("control retries keep their exact action ID across reloads and prevent ambiguous model changes", () => {
  const storage = memory();
  const choice = { chatId: "chat", provider: "claude", model: "m", effort: null, permissions: "auto", mode: "goal", continueAfterUsage: true };
  const first = prepareControlAction(choice, storage);
  assert.equal(prepareControlAction(choice, storage).actionId, first.actionId);
  const reloaded = memory(Object.fromEntries(storage.data));
  assert.equal(prepareControlAction(choice, reloaded).actionId, first.actionId);
  assert.throws(() => prepareControlAction({ ...choice, model: "another" }, reloaded), /awaiting confirmation/);
  assert.equal(readPending("chat", reloaded).model, "m");
  savePending("chat", null, reloaded);
  assert.notEqual(prepareControlAction(choice, reloaded).actionId, first.actionId);
});
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

test("a local send stays until the snapshot has that same message", () => {
  const pending = {
    id: "pending:action-1",
    pending: true,
    actionId: "action-1",
    role: "user",
    content: "CI failed on two",
    run_id: null,
  };
  const kept = keepPendingMessages(
    { messages: [pending], queue: [] },
    { messages: [{ id: "older", role: "user", content: "earlier", run_id: "run-0" }], queue: [], runs: [] },
  );
  assert.deepEqual(kept.messages.at(-1), pending);
  const confirmed = keepPendingMessages(
    { messages: [{ ...pending, run_id: "run-1" }], queue: [] },
    {
      messages: [
        {
          id: "saved",
          role: "user",
          content: "CI failed on two",
          run_id: "run-1",
        },
      ],
      queue: [],
      runs: [{ id: "run-1", action_id: "action-1" }],
    },
  );
  assert.equal(confirmed.messages.some((message) => message.pending), false);
  const matchedByAction = keepPendingMessages(
    { messages: [pending], queue: [] },
    {
      messages: [
        {
          id: "saved",
          role: "user",
          content: "CI failed on two",
          run_id: "run-1",
        },
      ],
      queue: [],
      runs: [{ id: "run-1", action_id: "action-1" }],
    },
  );
  assert.equal(matchedByAction.messages.some((message) => message.pending), false);
});

test("a local queued send stays until that action is in the snapshot", () => {
  const pending = {
    id: "pending:action-2",
    pending: true,
    actionId: "action-2",
    text: "next",
  };
  const waiting = keepPendingMessages(
    { messages: [], queue: [pending] },
    { messages: [], queue: [], runs: [] },
  );
  assert.deepEqual(waiting.queue, [pending]);
  const queued = keepPendingMessages(
    { messages: [], queue: [pending] },
    { messages: [], queue: [{ id: "q1", action_id: "action-2", text: "next" }], runs: [] },
  );
  assert.equal(queued.queue.some((item) => item.pending), false);
  const started = keepPendingMessages(
    { messages: [], queue: [pending] },
    {
      messages: [{ id: "saved", role: "user", content: "next", run_id: "run-2" }],
      queue: [],
      runs: [{ id: "run-2", action_id: "action-2" }],
    },
  );
  assert.equal(started.queue.some((item) => item.pending), false);
});
