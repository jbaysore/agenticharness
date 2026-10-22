import test from "node:test";
import assert from "node:assert/strict";
import {
  activeChats,
  attentionCount,
  chatMarker,
  chatMarkerLabel,
  pinnedChats,
  providerStatusLabel,
  resetLabel,
  sidebarOrder,
  usageGlance,
  usageWindows,
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

test("pinned chats lead their project and archived pins stay out of the pinned list", () => {
  const chat = (id, updated_at, extra = {}) => ({ id, updated_at, ...extra });
  const conversations = [
    chat("old", "2026-01-03T00:00:00.000Z"),
    chat("fresh", "2026-01-04T00:00:00.000Z"),
    chat("held", "2026-01-01T00:00:00.000Z", {
      pinned_at: "2026-01-02T00:00:00.000Z",
    }),
    chat("kept", "2026-01-01T00:00:00.000Z", {
      pinned_at: "2026-01-05T00:00:00.000Z",
    }),
    chat("shelved", "2026-01-06T00:00:00.000Z", {
      pinned_at: "2026-01-07T00:00:00.000Z",
      archived_at: "2026-01-07T00:00:00.000Z",
    }),
  ];
  assert.deepEqual(
    pinnedChats(conversations).map((c) => c.id),
    ["kept", "held"],
  );
  assert.deepEqual(
    sidebarOrder(conversations.filter((c) => !c.archived_at)).map((c) => c.id),
    ["kept", "held", "fresh", "old"],
  );
  assert.deepEqual(
    sidebarOrder(conversations.filter((c) => c.archived_at)).map((c) => c.id),
    ["shelved"],
  );
});

test("the header shows the tightest usage window for each provider", () => {
  const codex = {
    id: "codex",
    connected: true,
    usage: {
      authoritative: true,
      windows: [
        {
          bucket: "codex",
          usedPercent: 40,
          windowMinutes: 300,
          resetsAt: 1800000000,
        },
        {
          bucket: "codex",
          usedPercent: 88.4,
          windowMinutes: 10080,
          resetsAt: null,
        },
      ],
    },
  };
  assert.deepEqual(
    usageWindows(codex).map((w) => [w.name, w.remaining, w.resetsAt]),
    [
      ["5-hour limit", 60, 1800000000000],
      ["Weekly limit", 12, null],
    ],
  );
  assert.deepEqual(usageGlance(codex), {
    remaining: 12,
    level: "low",
    bars: [
      { name: "5-hour limit", short: "5h", remaining: 60, level: "ok" },
      { name: "Weekly limit", short: "wk", remaining: 12, level: "low" },
    ],
  });
  assert.deepEqual(
    usageGlance({
      id: "cursor",
      connected: true,
      usage: { authoritative: false, windows: [] },
    }),
    {
      remaining: null,
      level: "unknown",
      bars: [{ name: "Usage", short: "", remaining: null, level: "unknown" }],
    },
  );
  assert.equal(
    usageGlance({
      id: "claude",
      connected: true,
      blockReason: "A Claude included-usage limit is exhausted.",
      usage: { authoritative: false, windows: [] },
    }).level,
    "out",
  );
  assert.deepEqual(
    usageWindows({
      id: "claude",
      usage: {
        authoritative: true,
        windows: [
          { bucket: "five_hour", usedPercent: 10 },
          { bucket: "seven_day_opus", usedPercent: 10 },
          { bucket: "seven_day", label: "Sonnet", usedPercent: 10 },
        ],
      },
    }).map((w) => w.name),
    ["5-hour limit", "Opus · Weekly limit", "Sonnet · Weekly limit"],
  );
  assert.equal(resetLabel(Date.now() + 135 * 60000 + 1000), "Resets in 2h 15m");
});
