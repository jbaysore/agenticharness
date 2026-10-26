import test from "node:test";
import assert from "node:assert/strict";
import { turnTiming } from "../src/ui/voice.mjs";

const now = new Date("2026-10-26T20:00:00");

test("a finished turn shows how long it worked and when it ended", () => {
  const today = turnTiming(
    {
      status: "completed",
      created_at: new Date("2026-10-26T14:00:00").toISOString(),
      ended_at: new Date("2026-10-26T14:03:12").toISOString(),
    },
    now,
  );
  assert.match(today.label, /^Worked for 3m 12s · \d{1,2}:03\b/);
  assert.doesNotMatch(today.label, /Oct/);
  const earlier = turnTiming(
    {
      status: "failed",
      created_at: new Date("2026-10-21T09:00:00").toISOString(),
      ended_at: new Date("2026-10-21T09:00:09").toISOString(),
    },
    now,
  );
  assert.match(earlier.label, /^Failed after 9s · Oct 21, /);
  assert.match(
    turnTiming(
      {
        status: "cancelled",
        created_at: now.toISOString(),
        ended_at: now.toISOString(),
      },
      now,
    ).label,
    /^Stopped after 0s/,
  );
});

test("a turn still running or without a run has no timing", () => {
  assert.equal(turnTiming(undefined, now), null);
  assert.equal(
    turnTiming({ status: "running", created_at: now.toISOString() }, now),
    null,
  );
});
