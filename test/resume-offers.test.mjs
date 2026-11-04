import test from "node:test";
import assert from "node:assert/strict";
import { resumeOffers } from "../src/core/goals.mjs";

const goal = (status, runId, objective = "Ship the release") => ({
  goal: { status, runId, objective },
});

test("a Goal parked on CI does not keep resume boxes at the bottom", () => {
  const chat = {
    mode: "goal",
    provider: "codex",
    runs: [{ id: "yield" }, { id: "older" }],
    sessions: {
      codex: goal("waiting", "yield"),
      claude: goal("paused", "older", "Earlier objective"),
    },
    watches: [{ armed: true, status: "pending" }],
  };
  assert.deepEqual(resumeOffers(chat), []);
});

test("a waiting Goal can be resumed once automatic continuation will not run", () => {
  const chat = {
    mode: "goal",
    provider: "codex",
    runs: [{ id: "yield" }, { id: "older" }],
    sessions: {
      codex: goal("waiting", "yield"),
      claude: goal("usageLimited", "older", "Earlier objective"),
    },
    watches: [{ armed: false, status: "success", delivery: "blocked" }],
  };
  const offers = resumeOffers(chat);
  assert.deepEqual(
    offers.map((item) => item.provider),
    ["codex"],
  );
  assert.equal(offers[0].status, "waiting");
});

test("an older provider's pause does not follow a Goal that already continued", () => {
  const chat = {
    mode: "goal",
    provider: "claude",
    runs: [{ id: "latest" }, { id: "paused-run" }],
    sessions: {
      codex: goal("paused", "paused-run"),
      claude: goal("unknown", "latest", "Current objective"),
    },
  };
  assert.deepEqual(resumeOffers(chat), []);
});

test("the latest paused Goal is still offered when the chat is idle", () => {
  const chat = {
    mode: "default",
    provider: "codex",
    runs: [{ id: "paused-run" }],
    sessions: { codex: goal("paused", "paused-run") },
  };
  assert.equal(resumeOffers(chat)[0].status, "paused");
});

test("an owner pause uses its own card instead of a resume box", () => {
  const chat = {
    mode: "goal",
    provider: "codex",
    runs: [{ id: "paused-run" }],
    sessions: {
      codex: {
        goal: {
          status: "owner",
          runId: "paused-run",
          objective: "Ship the release",
          ownerPause: { statement: "Merge the pull request." },
        },
      },
    },
  };
  assert.deepEqual(resumeOffers(chat), []);
});

test("a running turn hides resume boxes", () => {
  const chat = {
    mode: "goal",
    provider: "codex",
    activeRun: { id: "live", status: "running" },
    runs: [{ id: "live" }],
    sessions: { codex: goal("paused", "live") },
  };
  assert.deepEqual(resumeOffers(chat), []);
});
