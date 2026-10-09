import test from "node:test";
import assert from "node:assert/strict";
import {
  activeChats,
  attentionCount,
  chatMarker,
  chatMarkerLabel,
  providerStatusLabel,
} from "../src/ui/status.mjs";

test("a usage block is labeled separately from setup", () => {
  assert.equal(
    providerStatusLabel({
      connected: true,
      blockReason:
        "Included Codex usage is exhausted. Wait for the provider to restore it.",
    }),
    "Out of usage",
  );
  assert.equal(
    providerStatusLabel({
      connected: true,
      blockReason: "Included Codex quota is exhausted.",
    }),
    "Out of usage",
  );
  assert.equal(
    providerStatusLabel({
      connected: true,
      blockReason: "A provider usage limit has been reached.",
    }),
    "Out of usage",
  );
  assert.equal(
    providerStatusLabel({
      connected: true,
      blockReason: "A Claude included-usage limit is exhausted.",
    }),
    "Out of usage",
  );
  assert.equal(
    providerStatusLabel({
      connected: true,
      blockReason:
        "Recheck the provider paid-usage setting. The previous verification is over 24 hours old.",
    }),
    "Setup needed",
  );
  assert.equal(
    providerStatusLabel({
      connected: false,
      blockReason: "Sign in with Cursor CLI browser login.",
    }),
    "Setup needed",
  );
  assert.equal(providerStatusLabel({ connected: true }), "Connected");
  assert.equal(providerStatusLabel({ connected: false }), "Checking…");
});

test("a chat is marked by what it needs, and a seen result is no longer marked", () => {
  assert.equal(
    chatMarker({ status: "needs-approval", unread: false }),
    "approval",
  );
  assert.equal(chatMarker({ status: "running", unread: false }), "running");
  assert.equal(chatMarker({ status: "failed", unread: true }), "failed");
  assert.equal(chatMarker({ status: "interrupted", unread: true }), "failed");
  assert.equal(chatMarker({ status: "failed", unread: false }), null);
  assert.equal(chatMarker({ status: "idle", unread: true }), "unread");
  assert.equal(chatMarker({ status: "idle", unread: false }), null);
  assert.equal(chatMarker(undefined), null);
  for (const marker of ["approval", "running", "failed", "unread"])
    assert.ok(chatMarkerLabel(marker));
  assert.equal(chatMarkerLabel(null), "");
});

test("the active list puts chats that need you first and leaves out archived ones", () => {
  const chat = (id, status, unread, extra = {}) => ({
    id,
    status,
    unread,
    updated_at: "2026-01-01T00:00:0" + id.length + ".000Z",
    ...extra,
  });
  const conversations = [
    chat("quiet", "idle", false),
    chat("working", "running", false),
    chat("finished", "idle", true),
    chat("broken", "failed", true),
    chat("asking", "needs-approval", false),
    chat("shelved", "idle", true, { archived_at: "2026-01-02T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    activeChats(conversations).map((c) => c.id),
    ["asking", "broken", "finished", "working"],
  );
  assert.equal(attentionCount(conversations), 3);
  assert.equal(attentionCount([]), 0);
});
