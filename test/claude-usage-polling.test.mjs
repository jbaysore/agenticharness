import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeUsageTracker } from "../src/security/claude-usage.mjs";
import { inspectClaude, usageOf } from "../src/providers/claude.mjs";

const auth = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "pro",
  email: "polling@example.test",
  orgId: "fixture-org",
};
const reading = (percent = 26) => ({
  rate_limits_available: true,
  rate_limits: {
    extra_usage: { is_enabled: false, user_disabled: true },
    limits: [{ kind: "session", percent }],
  },
});
const incomplete = { rate_limits_available: true, rate_limits: {} };

function fixture() {
  let time = Date.parse("2026-10-22T13:00:00Z");
  const usageForAccount = createClaudeUsageTracker(
    () => new Date(time).toISOString(),
    { clock: () => time },
  );
  return {
    usageForAccount,
    advance(ms) {
      time += ms;
    },
  };
}

test("concurrent callers share one lookup and cached reads retain the actual confirmation time", async () => {
  const f = fixture();
  let reads = 0,
    release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const fetchUsage = () => {
    reads++;
    return pending;
  };
  const first = f.usageForAccount(auth).read(fetchUsage);
  const second = f.usageForAccount({ ...auth }).read(fetchUsage);
  await Promise.resolve();
  assert.equal(reads, 1);
  release(reading());
  const confirmed = await first;
  assert.deepEqual(await second, confirmed);
  f.advance(59_999);
  assert.deepEqual(await f.usageForAccount(auth).read(fetchUsage), confirmed);
  assert.equal(reads, 1);
  f.advance(1);
  const next = await f.usageForAccount(auth).read(async () => {
    reads++;
    return reading(27);
  });
  assert.equal(reads, 2);
  assert.equal(next.usage.lastConfirmedAt, "2026-10-22T13:01:00.000Z");
  assert.equal(next.usage.windows[0].usedPercent, 27);
});

test("incomplete and rejected lookups back off five, ten, then fifteen minutes, and recovery resets backoff", async () => {
  const f = fixture(),
    monitor = f.usageForAccount(auth);
  const initial = await monitor.read(async () => reading());
  f.advance(60_000);
  let reads = 0;
  for (const [value, delay] of [
    [incomplete, 300_000],
    [new Error("private SDK diagnostic"), 600_000],
    [null, 900_000],
    [incomplete, 900_000],
  ]) {
    const fetchUsage = async () => {
      reads++;
      if (value instanceof Error) throw value;
      return value;
    };
    const before = reads;
    const unknown = await monitor.read(fetchUsage);
    assert.equal(unknown.reason, null);
    assert.equal(unknown.usage.verificationStatus, "unknown");
    assert.equal(unknown.usage.lastConfirmedAt, initial.usage.lastConfirmedAt);
    assert.deepEqual(unknown.usage.windows, initial.usage.windows);
    assert.ok(unknown.usage.lookupProblem);
    assert.doesNotMatch(JSON.stringify(unknown), /private SDK diagnostic/);
    assert.equal(
      Date.parse(unknown.usage.nextCheckAt) -
        Date.parse(unknown.usage.lastAttemptAt),
      delay,
    );
    f.advance(delay - 1);
    assert.deepEqual(await monitor.read(fetchUsage), unknown);
    assert.equal(reads, before + 1);
    f.advance(1);
  }
  const recovered = await monitor.read(async () => reading(29));
  assert.equal(recovered.usage.verificationStatus, "confirmed");
  assert.equal(recovered.usage.lookupProblem, null);
  f.advance(60_000);
  const unknown = await monitor.read(async () => incomplete);
  assert.equal(
    Date.parse(unknown.usage.nextCheckAt) -
      Date.parse(unknown.usage.lastAttemptAt),
    300_000,
  );
});

for (const header of ["1200", "Thu, 22 Oct 2026 13:20:00 GMT"]) {
  test(`HTTP 429 retains a safe diagnostic and honors Retry-After: ${header}`, async () => {
    const f = fixture(),
      monitor = f.usageForAccount(auth);
    const error = Object.assign(new Error("Bearer private-token"), {
      response: { status: 429, headers: { "retry-after": header } },
    });
    const result = await monitor.read(async () => {
      throw error;
    });
    assert.ok(result.reason);
    assert.equal(
      result.usage.lookupProblem,
      "Claude usage lookup failed (HTTP 429).",
    );
    assert.equal(result.usage.nextCheckAt, "2026-10-22T13:20:00.000Z");
    assert.doesNotMatch(JSON.stringify(result), /private-token/);
    let reads = 0;
    f.advance(1_199_999);
    await monitor.read(async () => {
      reads++;
      return reading();
    });
    assert.equal(reads, 0);
    f.advance(1);
    assert.equal((await monitor.read(async () => reading())).reason, null);
  });
}

test("native boundaries discard cached and in-flight verification before another turn can reuse it", async () => {
  const f = fixture(),
    monitor = f.usageForAccount(auth);
  await monitor.read(async () => reading());
  f.advance(60_000);
  let release;
  const pending = monitor.read(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  monitor.invalidate();
  release(reading());
  assert.ok((await pending).reason);
  let reads = 0;
  const next = await monitor.read(async () => {
    reads++;
    return incomplete;
  });
  assert.equal(reads, 1);
  assert.ok(next.reason);
  assert.equal(next.usage.verificationStatus, "blocked");
});

test("a confirmed quota or paid-usage boundary remains blocked when reads are shared", async () => {
  for (const value of [
    reading(100),
    { rate_limits: { extra_usage: { is_enabled: true } } },
    { rate_limits: { extra_usage: { user_disabled: false } } },
  ]) {
    const f = fixture(),
      monitor = f.usageForAccount(auth);
    await monitor.read(async () => reading());
    f.advance(60_000);
    const result = await monitor.read(async () => value);
    assert.ok(result.reason);
    assert.equal(result.usage.verificationStatus, "blocked");
    assert.deepEqual(await monitor.read(async () => reading()), result);
  }
});

test("account changes cannot reuse a different account's cached or pending reading", async () => {
  const f = fixture();
  let release;
  const first = f.usageForAccount(auth).read(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const other = f.usageForAccount({ ...auth, orgId: "other-org" });
  release(reading());
  assert.ok((await first).reason);
  assert.ok((await other.read(async () => incomplete)).reason);
  assert.ok(
    (await f.usageForAccount(auth).read(async () => incomplete)).reason,
  );
});

test("connection refreshes reuse the account lookup instead of creating another request", async () => {
  const f = fixture();
  const first = await f.usageForAccount(auth).read(async () => reading());
  let reads = 0,
    closed = false;
  f.advance(30_000);
  const provider = await inspectClaude(process.cwd(), {
    readAuth: async () => ({ ...auth }),
    readUsage: async () => {
      reads++;
      return incomplete;
    },
    baseOptions: () => ({}),
    usageForAccount: f.usageForAccount,
    queryFn: () => ({
      supportedModels: async () => [{ value: "opus", displayName: "Opus" }],
      close() {
        closed = true;
      },
    }),
  });
  assert.equal(reads, 0);
  assert.equal(provider.blockReason, null);
  assert.deepEqual(provider.usage, first.usage);
  assert.equal(closed, true);
});

test("native usage errors reach the shared backoff instead of being discarded", async () => {
  const error = Object.assign(new Error("lookup failed"), { status: 429 });
  await assert.rejects(
    usageOf({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        throw error;
      },
    }),
    (actual) => actual === error,
  );
});
