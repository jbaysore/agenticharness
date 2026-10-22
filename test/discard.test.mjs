import test from "node:test";
import assert from "node:assert/strict";
import { unusedClosedChats } from "../src/ui/discard.mjs";
import {
  hasComposerDraft,
  saveDraft,
  saveDraftAttachments,
} from "../src/ui/drafts.mjs";
import { savePending } from "../src/ui/outbox.mjs";

const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => data.get(k),
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
};

test("closing an unused empty chat discards it, and a composer draft keeps it", () => {
  const storage = memory(),
    chats = {
      empty: { id: "empty" },
      draft: { id: "draft" },
      attached: { id: "attached" },
      pending: { id: "pending" },
      messaged: { id: "messaged", messages: [{ id: "m" }] },
      pinned: { id: "pinned", pinned_at: "2026-01-01T00:00:00.000Z" },
      archived: { id: "archived", archived_at: "2026-01-01T00:00:00.000Z" },
      stillOpen: { id: "stillOpen" },
    };
  saveDraft("draft", "half a thought", storage);
  saveDraftAttachments(
    "attached",
    [{ id: "file", name: "note.txt", type: "text/plain", size: 4 }],
    storage,
  );
  savePending(
    "pending",
    { actionId: "retry", chatId: "pending", text: "send me" },
    storage,
  );
  saveDraft("empty", "   ", storage);
  assert.equal(hasComposerDraft("empty", storage), false);
  assert.equal(hasComposerDraft("draft", storage), true);
  assert.equal(hasComposerDraft("attached", storage), true);
  assert.deepEqual(
    unusedClosedChats(
      Object.keys(chats),
      ["stillOpen"],
      (id) => chats[id],
      storage,
    ),
    ["empty"],
  );
});
