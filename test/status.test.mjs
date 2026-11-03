import test from "node:test";
import assert from "node:assert/strict";
import {
  activeChats,
  attentionCount,
  chatMarker,
  chatMarkerLabel,
  continuationProviders,
  continuationUnavailableTitle,
  pinnedChats,
  providerStatusLabel,
  recentChats,
  cursorMonthlyReset,
  cursorResetDay,
  cursorResetLabel,
  resetCountdown,
  resetLabel,
  resetTimestamp,
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
  assert.equal(
    chatMarker({ status: "idle", unread: false, watching: true }),
    "watching",
  );
  assert.equal(
    chatMarker({ status: "idle", unread: true, watching: true }),
    "watching",
  );
  assert.equal(
    chatMarker({ status: "failed", unread: true, watching: true }),
    "failed",
  );
  assert.equal(
    chatMarker({ status: "running", unread: false, watching: true }),
    "running",
  );
  assert.equal(
    chatMarker({
      status: "idle",
      unread: false,
      watching: true,
      usage_stopped_at: "2026-01-02T00:00:00.000Z",
    }),
    "usage",
  );
  assert.equal(
    chatMarker({
      status: "failed",
      unread: false,
      usage_stopped_at: "2026-01-02T00:00:00.000Z",
    }),
    "usage",
  );
  assert.equal(
    chatMarker({
      status: "needs-approval",
      unread: false,
      usage_stopped_at: "2026-01-02T00:00:00.000Z",
    }),
    "approval",
  );
  assert.equal(
    chatMarker({
      status: "running",
      usage_stopped_at: "2026-01-02T00:00:00.000Z",
    }),
    "running",
  );
  assert.equal(chatMarker(undefined), null);
  for (const marker of ["approval", "running", "watching", "usage", "failed", "unread"])
    assert.ok(chatMarkerLabel(marker));
  assert.equal(chatMarkerLabel("watching"), "Watching CI");
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
    chat("ci", "idle", true, { watching: true }),
    chat("broken", "failed", true),
    chat("asking", "needs-approval", false),
    chat("limited", "failed", false, {
      usage_stopped_at: "2026-01-02T00:00:00.000Z",
    }),
    chat("shelved", "idle", true, { archived_at: "2026-01-02T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    activeChats(conversations).map((c) => c.id),
    ["asking", "limited", "broken", "finished", "ci", "working"],
  );
  assert.equal(attentionCount(conversations), 4);
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

test("recent chats follow activity time across projects and leave out archived ones", () => {
  const chat = (id, updated_at, extra = {}) => ({ id, updated_at, ...extra });
  assert.deepEqual(
    recentChats([
      chat("old", "2026-01-01T00:00:00.000Z", { project_id: "a" }),
      chat("fresh", "2026-01-04T00:00:00.000Z", { project_id: "b" }),
      chat("held", "2026-01-02T00:00:00.000Z", {
        project_id: "a",
        pinned_at: "2026-01-09T00:00:00.000Z",
      }),
      chat("shelved", "2026-01-08T00:00:00.000Z", {
        project_id: "b",
        archived_at: "2026-01-08T00:00:00.000Z",
      }),
      chat("undated", undefined, { project_id: "a" }),
    ]).map((c) => c.id),
    ["fresh", "held", "old", "undated"],
  );
  assert.deepEqual(recentChats([]), []);
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
      { name: "5-hour limit", short: "5h", remaining: 60, level: "ok", resetsAt: 1800000000000 },
      { name: "Weekly limit", short: "wk", remaining: 12, level: "low", resetsAt: null },
    ],
  });
  const cursorNow = new Date(2026, 9, 23, 15, 26).getTime();
  const cursorGlance = usageGlance({
    id: "cursor",
    connected: true,
    usage: { authoritative: false, windows: [] },
  }, cursorNow);
  assert.equal(cursorGlance.remaining, null);
  assert.equal(cursorGlance.level, "unknown");
  assert.equal(cursorGlance.bars[0].dateOnly, true);
  assert.equal(cursorGlance.bars[0].remaining, null);
  assert.equal(cursorGlance.bars[0].resetsAt, cursorMonthlyReset(cursorNow));
  const cursorReset = new Date(cursorGlance.bars[0].resetsAt);
  assert.equal(cursorReset.getFullYear(), 2026);
  assert.equal(cursorReset.getMonth(), 10);
  assert.equal(cursorReset.getDate(), 14);
  assert.equal(cursorReset.getHours(), 12);
  assert.equal(cursorReset.getMinutes(), 0);
  assert.equal(cursorResetDay(cursorGlance.bars[0].resetsAt), cursorReset.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  }));
  assert.match(cursorResetLabel(cursorGlance.bars[0].resetsAt), /^Resets /);
  const atNoon = new Date(2026, 10, 14, 12, 0, 0, 0).getTime();
  const justBefore = new Date(cursorMonthlyReset(atNoon - 1));
  assert.equal(justBefore.getMonth(), 10);
  assert.equal(justBefore.getDate(), 14);
  const nextMonth = new Date(cursorMonthlyReset(atNoon));
  assert.equal(nextMonth.getFullYear(), 2026);
  assert.equal(nextMonth.getMonth(), 11);
  assert.equal(nextMonth.getDate(), 14);
  assert.equal(nextMonth.getHours(), 12);
  const nextYear = new Date(cursorMonthlyReset(new Date(2026, 11, 14, 12).getTime()));
  assert.equal(nextYear.getFullYear(), 2027);
  assert.equal(nextYear.getMonth(), 0);
  assert.equal(nextYear.getDate(), 14);
  assert.equal(nextYear.getHours(), 12);
  assert.equal(
    usageGlance({
      id: "cursor",
      connected: true,
      usage: {
        windows: [{ bucket: "cursor", usedPercent: 10, windowMinutes: 43200 }],
      },
    }).bars[0].dateOnly,
    undefined,
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
        authoritative: false,
        windows: [
          { bucket: "session", usedPercent: 100 },
          { bucket: "weekly_all", usedPercent: 40 },
        ],
      },
    }).map((w) => [w.name, w.remaining]),
    [
      ["5-hour limit", 0],
      ["Weekly limit", 60],
    ],
  );
  assert.deepEqual(
    usageWindows({
      id: "claude",
      connected: true,
      blockReason: "The Claude CLI could not verify that paid extra usage is disabled.",
      usage: { authoritative: false, windows: [] },
    }),
    [],
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
  const now = 1_800_000_000_000;
  assert.equal(resetLabel(now + 135 * 60000 + 1000, now), "Resets in 2h 16m");
});

test("reset countdowns stay compact and round up", () => {
  const now = 1_000_000_000_000;
  assert.equal(resetCountdown(null, now), "");
  assert.equal(resetCountdown(now - 60000, now), "0m");
  assert.equal(resetCountdown(now + 30000, now), "1m");
  assert.equal(resetCountdown(now + 44 * 60000 + 1000, now), "45m");
  assert.equal(resetCountdown(now + 60 * 60000, now), "1h");
  assert.equal(resetCountdown(now + 60 * 60000 + 1, now), "1h 1m");
  assert.equal(resetCountdown(now + 219 * 60000 + 1000, now), "3h 40m");
  assert.equal(resetCountdown(now + 1439 * 60000 + 1000, now), "1d");
  assert.equal(resetCountdown(now + (4 * 24 + 5) * 3600000 + 60000, now), "4d 6h");
  assert.equal(resetCountdown(now + (2 * 24 + 23) * 3600000 + 60000, now), "3d");
  for (const at of [NaN, Infinity, "invalid"])
    assert.equal(resetCountdown(at, now), "");
});

test("reset timestamps accept seconds, milliseconds and ISO dates without inventing invalid resets", () => {
  const at = 1_800_000_000_000;
  for (const value of [at / 1000, at, String(at / 1000), String(at), new Date(at).toISOString()]) {
    assert.equal(resetTimestamp(value), at);
    const provider = { id: "codex", usage: { authoritative: true, windows: [
      { bucket: "codex", usedPercent: 10, resetsAt: value },
    ] } };
    assert.equal(usageWindows(provider)[0].resetsAt, at);
  }
  for (const value of [null, undefined, "", "invalid", 0, -1, "-1", NaN, Infinity, 9e15, false, {}])
    assert.equal(resetTimestamp(value), null);
});

test("a usage continuation offers other connected agents, and not the one that stopped", () => {
  const providers = [
    { id: "codex", connected: true, models: [{ id: "gpt" }] },
    {
      id: "claude",
      connected: true,
      models: [{ id: "haiku" }, { id: "retired", disabled: true }],
    },
    { id: "cursor", connected: true, models: [{ id: "composer" }] },
    { id: "openrouter", connected: true, models: [{ id: "free" }] },
    { id: "offline", connected: false, models: [{ id: "x" }] },
  ];
  const ids = (mode) =>
    continuationProviders(providers, { stoppedProvider: "codex", mode }).map(
      (provider) => provider.id,
    );
  assert.deepEqual(ids("default"), ["claude", "cursor", "openrouter"]);
  assert.deepEqual(ids("goal"), ["claude"]);
  assert.equal(
    continuationUnavailableTitle(providers, {
      stoppedProvider: "codex",
      mode: "default",
    }),
    "",
  );
  const blocked = [
    providers[0],
    { ...providers[1], blockReason: "A Claude included-usage limit is exhausted." },
  ];
  assert.deepEqual(
    continuationProviders(blocked, { stoppedProvider: "codex", mode: "default" }),
    [],
  );
  assert.equal(
    continuationUnavailableTitle(blocked, {
      stoppedProvider: "codex",
      mode: "default",
    }),
    "No other connected agent has usage left.",
  );
  const disabled = [
    providers[0],
    { id: "claude", connected: true, models: [{ id: "haiku", disabled: true }] },
  ];
  assert.deepEqual(
    continuationProviders(disabled, { stoppedProvider: "codex", mode: "ask" }),
    [],
  );
  const cursorOnly = [providers[0], providers[2], providers[3]];
  assert.equal(
    continuationUnavailableTitle(cursorOnly, {
      stoppedProvider: "codex",
      mode: "goal",
    }),
    "Cursor and OpenRouter cannot take a Goal.",
  );
});
