import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeUsageMonitor } from "../src/security/claude-usage.mjs";
import { runClaude } from "../src/providers/claude.mjs";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import {
  usageGlance,
  usageWindows,
  usageVerificationLabel,
} from "../src/ui/status.mjs";

const auth = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "pro",
};
const reading = (percent = 26) => ({
  rate_limits_available: true,
  rate_limits: {
    extra_usage: { is_enabled: false, user_disabled: true },
    limits: [{ kind: "five_hour", percent }],
  },
});
// The actual incomplete response recorded immediately before the old stops.
const incomplete = { rate_limits_available: true, rate_limits: {} };

test("native Claude meters show separate session and weekly header bars", () => {
  const monitor = createClaudeUsageMonitor(auth);
  const provider = {
    id: "claude",
    connected: true,
    usage: monitor.update({
      ...reading(),
      rate_limits: {
        ...reading().rate_limits,
        limits: [
          {
            kind: "weekly_scoped", group: "weekly", percent: 94,
            scope: { model: { display_name: "Sonnet" } },
          },
          { kind: "session", group: "session", percent: 26 },
          { kind: "weekly_all", group: "weekly", percent: 27 },
          {
            kind: "weekly_scoped", group: "weekly", percent: 10,
            scope: { surface: { display_name: "Claude Code" } },
          },
        ],
      },
    }).usage,
  };
  assert.deepEqual(usageGlance(provider), {
    remaining: 6,
    level: "low",
    bars: [
      { name: "5-hour limit", short: "5h", remaining: 74, level: "ok" },
      { name: "Weekly limit", short: "wk", remaining: 73, level: "ok" },
    ],
  });
  assert.deepEqual(usageWindows(provider).map((w) => w.name), [
    "Sonnet · Weekly limit",
    "5-hour limit",
    "Weekly limit",
    "Claude Code · Weekly limit",
  ]);
  provider.usage = monitor.update(null).usage;
  assert.deepEqual(usageGlance(provider).bars.map((b) => [b.short, b.remaining]), [
    ["5h", null],
    ["wk", null],
  ]);
});

test("missing telemetry keeps the original confirmation time and recovers automatically", () => {
  let now = "2026-10-21T20:38:36.000Z";
  const monitor = createClaudeUsageMonitor(auth, () => now);
  const initial = monitor.update(reading());
  assert.equal(initial.reason, null);
  assert.equal(initial.usage.verificationStatus, "confirmed");
  now = "2026-10-21T20:38:56.000Z";
  for (const value of [incomplete, null, { rate_limits_available: false }]) {
    const stale = monitor.update(value);
    assert.equal(stale.reason, null);
    assert.equal(stale.usage.verificationStatus, "unknown");
    assert.equal(stale.usage.authoritative, false);
    assert.equal(stale.usage.extraUsageEnabled, null);
    assert.equal(stale.usage.lastConfirmedAt, initial.usage.lastConfirmedAt);
    assert.deepEqual(stale.usage.windows, initial.usage.windows);
  }
  const recovered = monitor.update(reading(27));
  assert.equal(recovered.usage.authoritative, true);
  assert.equal(recovered.usage.verificationStatus, "confirmed");
  assert.equal(recovered.usage.lastConfirmedAt, now);
  assert.equal(recovered.usage.windows[0].usedPercent, 27);
});

test("a new turn still requires complete subscription verification", () => {
  for (const value of [
    incomplete,
    null,
    {
      ...reading(),
      rate_limits: { ...reading().rate_limits, limits: [] },
    },
  ]) {
    const result = createClaudeUsageMonitor(auth).update(value);
    assert.ok(result.reason);
    assert.equal(result.usage.lastConfirmedAt, null);
    assert.equal(result.usage.authoritative, false);
  }
  assert.match(
    createClaudeUsageMonitor({ ...auth, authMethod: "console" }).update(
      reading(),
    ).reason,
    /Sign in/,
  );
});

test("confirmed unsafe fields stop a verified turn even in an otherwise partial response", () => {
  for (const [limits, expected] of [
    [{ extra_usage: { is_enabled: true } }, /extra usage is enabled/],
    [{ extra_usage: { user_disabled: false } }, /account level/],
    [{ limits: [{ percent: 100 }] }, /exhausted/],
  ]) {
    const monitor = createClaudeUsageMonitor(auth);
    monitor.update(reading());
    assert.match(monitor.update({ rate_limits: limits }).reason, expected);
  }
});

test("unknown usage labels its cached values and does not advertise them as current", () => {
  const monitor = createClaudeUsageMonitor(auth);
  monitor.update(reading());
  const provider = {
    id: "claude",
    connected: true,
    usage: monitor.update(null).usage,
  };
  assert.equal(usageGlance(provider).level, "unknown");
  assert.equal(usageGlance(provider).remaining, null);
  assert.equal(usageGlance(provider).bars[0].remaining, null);
  assert.equal(usageWindows(provider)[0].remaining, 74);
  assert.match(
    usageVerificationLabel(provider),
    /Unknown · last confirmed at .*\d+:\d+:\d+/,
  );
  provider.usage = monitor.update(reading(28)).usage;
  assert.equal(usageVerificationLabel(provider), null);
  assert.equal(usageGlance(provider).remaining, 72);
});

function fixture(
  values,
  { nativeBoundary = false, readAuth = async () => auth } = {},
) {
  let release;
  const done = new Promise((resolve) => {
    release = resolve;
  });
  const events = [];
  let reads = 0,
    interrupted = false,
    closed = false,
    inputSeen = false;
  const q = {
    close() {
      closed = true;
      release();
    },
    async interrupt() {
      interrupted = true;
      release();
    },
    async *[Symbol.asyncIterator]() {
      inputSeen = !(await q.prompt.next()).done;
      if (nativeBoundary) {
        yield {
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected" },
        };
      } else {
        await done;
      }
      yield {
        type: "result",
        is_error: interrupted,
        errors: interrupted ? ["opaque SDK diagnostic"] : [],
      };
    },
  };
  const run = () =>
    runClaude(
      {
        project: { path: process.cwd() },
        text: "Synthetic task",
        signal: new AbortController().signal,
        emit(type, payload) {
          events.push({ type, payload });
          if (type === "usage" && reads >= values.length) release();
        },
      },
      {
        queryFn: ({ prompt }) => {
          q.prompt = prompt;
          return q;
        },
        readAuth,
        baseOptions: () => ({}),
        readUsage: async () => {
          const value = values[Math.min(reads++, values.length - 1)];
          if (value instanceof Error) throw value;
          return value;
        },
        pollIntervalMs: 2,
      },
    );
  return {
    run,
    events,
    get interrupted() {
      return interrupted;
    },
    get closed() {
      return closed;
    },
    get inputSeen() {
      return inputSeen;
    },
  };
}

test(
  "the SDK turn continues across missing and failed polls, then completes normally",
  { timeout: 3000 },
  async () => {
    const f = fixture([
      reading(),
      incomplete,
      new Error("lookup failed"),
      reading(27),
    ]);
    const result = await f.run();
    assert.equal(result.status, "completed");
    assert.equal(f.interrupted, false);
    assert.equal(f.closed, true);
    assert.deepEqual(
      f.events
        .filter((e) => e.type === "usage")
        .map((e) => e.payload.verificationStatus),
      ["confirmed", "unknown", "unknown", "confirmed"],
    );
    assert.equal(
      f.events.some((e) => e.payload.kind === "billing-stop"),
      false,
    );
  },
);

test(
  "a turn can finish while verification remains unknown",
  { timeout: 3000 },
  async () => {
    const f = fixture([reading(), incomplete, incomplete]);
    assert.equal((await f.run()).status, "completed");
    assert.equal(f.interrupted, false);
    assert.equal(
      f.events.filter((e) => e.type === "usage").at(-1).payload
        .verificationStatus,
      "unknown",
    );
  },
);

test(
  "a confirmed quota stop returns the billing reason as a visible failure",
  { timeout: 3000 },
  async () => {
    const f = fixture([reading(), reading(100)]);
    const result = await f.run();
    assert.equal(result.status, "failed");
    assert.match(result.error, /included-usage limit is exhausted/);
    assert.equal(f.interrupted, true);
  },
);

test(
  "native subscription boundary events still interrupt the turn",
  { timeout: 3000 },
  async () => {
    const f = fixture([reading()], { nativeBoundary: true });
    const result = await f.run();
    assert.equal(result.status, "failed");
    assert.match(result.error, /usage boundary/);
    assert.equal(f.interrupted, true);
  },
);

test("missing initial verification fails before sending a prompt to Claude", async () => {
  const f = fixture([incomplete]);
  await assert.rejects(f.run(), /could not verify/);
  assert.equal(f.inputSeen, false);
  assert.equal(f.closed, true);
});

test("the host retains unknown status and confirmation time for a browser reload", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  try {
    controller.providers = [
      { id: "claude", models: [{ id: "test", efforts: [] }] },
    ];
    const project = store.addProject("fixture", process.cwd());
    const chat = store.createConversation({ projectId: project.id });
    const monitor = createClaudeUsageMonitor(auth);
    monitor.update(reading());
    const usage = monitor.update(incomplete).usage;
    controller.runners.claude = async (ctx) => {
      ctx.emit("usage", usage);
      return { status: "completed" };
    };
    controller.send(chat.id, {
      actionId: "stale-usage-reload-check",
      text: "fixture",
      provider: "claude",
      model: "test",
    });
    await controller.active.get(chat.id).task;
    assert.deepEqual(controller.providers[0].usage, usage);
    assert.equal(controller.providers[0].usage.verificationStatus, "unknown");
  } finally {
    await controller.close();
    store.close();
  }
});
