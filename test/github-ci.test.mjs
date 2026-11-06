import test from "node:test";
import assert from "node:assert/strict";
import { GitHubCI, ciResult, pullOutcome } from "../src/core/github-ci.mjs";

const sha = "a".repeat(40),
  merge = "b".repeat(40);
const check = (id, state, extra = {}) => ({
  id,
  name: "tests",
  status: state === "pending" ? "in_progress" : "completed",
  conclusion: state,
  head_sha: sha,
  app: { id: 1, slug: "github-actions" },
  check_suite: { id: 10 },
  html_url: `https://github.com/owner/repo/runs/${id}`,
  ...extra,
});
const workflow = (id, state, extra = {}) => ({
  id,
  workflow_id: 12,
  name: "CI",
  event: "push",
  head_branch: "main",
  check_suite_id: 10,
  run_attempt: 1,
  status: state === "pending" ? "in_progress" : "completed",
  conclusion: state,
  ...extra,
});

test("all CI sources must finish; old workflow attempts cannot override their replacement", () => {
  assert.equal(ciResult({}).status, "pending");
  assert.equal(
    ciResult({
      checks: [check(1, "success")],
      workflows: [workflow(1, "pending")],
    }).status,
    "pending",
  );
  assert.equal(
    ciResult({
      checks: [check(1, "success")],
      statuses: [{ id: 1, context: "external", state: "pending" }],
    }).status,
    "pending",
  );
  assert.equal(
    ciResult({
      checks: [check(1, "success")],
      statuses: [{ id: 1, context: "external", state: "error" }],
    }).status,
    "failure",
  );
  assert.equal(
    ciResult({ checks: [check(1, "cancelled")] }).status,
    "cancelled",
  );
  assert.equal(ciResult({ checks: [check(1, "skipped")] }).status, "skipped");
  assert.equal(ciResult({ checks: [check(1, "neutral")] }).status, "skipped");
  assert.equal(
    ciResult({ checks: [check(1, "action_required")] }).status,
    "failure",
  );
  assert.equal(
    ciResult({ checks: [check(1, "unknown-new-state")] }).status,
    "pending",
  );
  const retried = ciResult({
    workflows: [
      workflow(1, "failure"),
      workflow(2, "success", { check_suite_id: 20 }),
    ],
    checks: [
      check(1, "failure"),
      check(2, "success", { check_suite: { id: 20 } }),
    ],
  });
  assert.equal(retried.status, "success");
  assert.equal(retried.items.length, 2);
  assert.equal(
    ciResult({
      statuses: [
        { id: 1, context: "external", state: "failure" },
        { id: 2, context: "external", state: "success" },
      ],
    }).status,
    "success",
  );
});

test("pagination and authenticated conditional requests retain complete data on 304", async () => {
  let calls = [],
    phase = 0;
  const github = new GitHubCI({
    request: async (endpoint, etag) => {
      calls.push({ endpoint, etag });
      if (phase) return { status: 304, headers: {} };
      if (endpoint.includes("check-runs")) {
        if (endpoint.includes("page=2"))
          return {
            status: 200,
            headers: { etag: '"page2"' },
            body: { check_runs: [check(2, "success", { name: "lint" })] },
          };
        return {
          status: 200,
          headers: {
            etag: '"page1"',
            link:
              "<https://api.github.com/repos/owner/repo/commits/" +
              sha +
              '/check-runs?per_page=100&filter=latest&page=2>; rel="next"',
          },
          body: { check_runs: [check(1, "success")] },
        };
      }
      return {
        status: 200,
        headers: { etag: '"empty"', "x-poll-interval": "120" },
        body: endpoint.includes("actions/runs")
          ? { workflow_runs: [] }
          : { statuses: [] },
      };
    },
  });
  const target = { cache: {} },
    watch = { repository: "owner/repo", commit: sha };
  const first = await github.read(watch, target);
  assert.equal(first.status, "success");
  assert.equal(first.items.length, 2);
  assert.equal(first.pollInterval, 120_000);
  phase = 1;
  calls = [];
  const unchanged = await github.read(watch, target);
  assert.deepEqual(unchanged, first);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.etag));
});

test("PR snapshots include the head and test-merge CI instead of following a moving branch", async () => {
  const seen = [];
  const github = new GitHubCI({
    request: async (endpoint) => {
      seen.push(endpoint);
      if (endpoint.includes("/pulls/"))
        return {
          status: 200,
          headers: {},
          body: {
            head: { sha },
            merge_commit_sha: merge,
            state: "open",
            html_url: "https://github.com/owner/repo/pull/1",
          },
        };
      if (endpoint.includes("check-runs"))
        return {
          status: 200,
          headers: {},
          body: {
            check_runs: endpoint.includes(merge)
              ? [check(2, "pending")]
              : [check(1, "success")],
          },
        };
      return {
        status: 200,
        headers: {},
        body: endpoint.includes("actions/runs")
          ? { workflow_runs: [] }
          : { statuses: [] },
      };
    },
  });
  const result = await github.read(
    { repository: "owner/repo", pr: 1 },
    { cache: {} },
  );
  assert.equal(result.identity, `${sha}:${merge}`);
  assert.equal(result.status, "pending");
  assert.ok(seen.some((url) => url.includes(merge)));
});

test("requests serialize globally and respect GitHub rate limit resets", async () => {
  let now = 100_000,
    active = 0,
    peak = 0,
    calls = 0;
  const github = new GitHubCI({
    now: () => now,
    request: async () => {
      active++;
      peak = Math.max(peak, active);
      calls++;
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { status: 200, headers: {}, body: {} };
    },
  });
  await Promise.all([
    github.get("one", {}),
    github.get("two", {}),
    github.get("three", {}),
  ]);
  assert.equal(peak, 1);
  github.request = async () => {
    calls++;
    return {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "300" },
      body: { message: "Rate limit exceeded" },
    };
  };
  await assert.rejects(
    github.get("four", {}),
    (error) => error.retryable && error.retryAt === 300_000,
  );
  const before = calls;
  await assert.rejects(github.get("five", {}), /rate limit reset/);
  assert.equal(calls, before);
  now = 300_001;
  github.request = async () => ({ status: 200, headers: {}, body: {} });
  await github.get("six", {});
});

test("access errors and malformed or truncated CI data never turn into passing checks", async () => {
  for (const status of [401, 403, 404, 503]) {
    const github = new GitHubCI({
      request: async () => ({ status, headers: {}, body: {} }),
    });
    await assert.rejects(
      github.read({ repository: "owner/repo", commit: sha }, { cache: {} }),
      (error) => error.retryable === (status === 503),
    );
  }
  const github = new GitHubCI({
    request: async () => ({ status: 200, headers: {}, body: {} }),
  });
  await assert.rejects(
    github.read({ repository: "owner/repo", commit: sha }, { cache: {} }),
    /incomplete CI data/,
  );
  github.request = async () => ({
    status: 200,
    headers: { link: '<https://unrelated.example/next>; rel="next"' },
    body: { check_runs: [] },
  });
  await assert.rejects(
    github.read({ repository: "owner/repo", commit: sha }, { cache: {} }),
    /unexpected pagination/,
  );
});

test("same-named checks in distinct suites remain visible and CI logs are not cached", async () => {
  assert.equal(
    ciResult({
      checks: [
        check(1, "failure"),
        check(2, "success", { check_suite: { id: 20 } }),
      ],
    }).status,
    "failure",
  );
  const github = new GitHubCI({
    request: async () => ({
      status: 200,
      headers: { etag: '"sample"' },
      body: {
        check_runs: [
          {
            ...check(1, "success"),
            output: { text: "Large private log output" },
            irrelevant: "unused",
          },
        ],
      },
    }),
  });
  const cache = {};
  await github.get("repos/owner/repo/commits/abc/check-runs", cache);
  assert.doesNotMatch(JSON.stringify(cache), /Large private|unused/);
  github.request = async () => ({
    status: 304,
    headers: { "x-poll-interval": "180" },
  });
  assert.equal(
    (await github.get("repos/owner/repo/commits/abc/check-runs", cache))
      .pollInterval,
    180_000,
  );
});

test("GitHub Retry-After dates postpone requests until the advertised time", async () => {
  const now = Date.parse("2026-11-02T12:00:00Z"),
    expected = now + 600_000;
  const github = new GitHubCI({
    now: () => now,
    request: async () => ({
      status: 429,
      headers: { "retry-after": new Date(expected).toUTCString() },
      body: {},
    }),
  });
  await assert.rejects(
    github.get("rate", {}),
    (error) => error.retryAt === expected,
  );
});

const view = (extra = {}) => ({
  state: "open",
  merged: false,
  head: sha,
  title: "Add watches",
  reviews: [],
  comments: [{ id: 4, user: "ada", excerpt: "already here" }],
  reviewComments: [],
  ...extra,
});

test("pull request comments already present do not fire, and a later one does", () => {
  const first = pullOutcome(null, view());
  assert.equal(first.status, "pending");
  assert.equal(first.cursor.commentId, 4);
  const same = pullOutcome(first.cursor, view());
  assert.equal(same.status, "pending");
  const commented = pullOutcome(
    first.cursor,
    view({ comments: [...view().comments, { id: 5, user: "bea", excerpt: "new" }] }),
  );
  assert.equal(commented.status, "updated");
  assert.equal(commented.items[0].excerpt, "new");
});

test("an already merged pull request is terminal on the first read", () => {
  const merged = pullOutcome(null, view({ state: "closed", merged: true }));
  assert.equal(merged.status, "success");
  assert.match(merged.reason, /merged/);
});

test("readPull keeps the registration cursor and ignores the old comment", async () => {
  const github = new GitHubCI({
    request: async (endpoint) => {
      if (/\/pulls\/4$/.test(endpoint))
        return {
          status: 200,
          headers: {},
          body: {
            state: "open",
            title: "Add watches",
            html_url: "https://github.com/owner/repo/pull/4",
            head: { sha },
            user: { login: "ada" },
          },
        };
      if (endpoint.includes("/reviews"))
        return { status: 200, headers: {}, body: [] };
      if (endpoint.includes("/comments"))
        return {
          status: 200,
          headers: {},
          body: [{ id: 4, body: "already here", user: { login: "ada" } }],
        };
      throw new Error(endpoint);
    },
  });
  const target = { cache: {} };
  const first = await github.readPull(
    { repository: "owner/repo", pr: 4, createdAt: Date.now(), cursor: null },
    target,
    new AbortController().signal,
  );
  assert.equal(first.status, "pending");
  const second = await github.readPull(
    {
      repository: "owner/repo",
      pr: 4,
      createdAt: Date.now(),
      cursor: first.cursor,
    },
    target,
    new AbortController().signal,
  );
  assert.equal(second.status, "pending");
});
