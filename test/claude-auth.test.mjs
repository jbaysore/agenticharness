import test from "node:test";
import assert from "node:assert/strict";
import { claudeAuth, runClaude } from "../src/providers/claude.mjs";

for (const stdout of ["", '{"loggedIn":', "null", "{}"])
  test(`sign-in check retries malformed status ${JSON.stringify(stdout)}`, async () => {
    let calls = 0;
    const auth = await claudeAuth({
      path: "fixture-claude",
      run: async (path, args, options) => {
        assert.equal(path, "fixture-claude");
        assert.deepEqual(args, ["auth", "status"]);
        assert.equal(options.windowsHide, true);
        return { stdout: ++calls === 1 ? stdout : '{"loggedIn":true}' };
      },
    });
    assert.equal(auth.loggedIn, true);
    assert.equal(calls, 2);
  });

test("repeated bad sign-in output fails clearly without exposing it", async () => {
  let calls = 0;
  await assert.rejects(claudeAuth({
    path: "fixture-claude",
    run: async () => { calls++; return { stdout: "private diagnostic" }; },
  }), (error) => {
    assert.match(error.message, /sign-in check.*twice/);
    assert.doesNotMatch(error.message, /private diagnostic/);
    return true;
  });
  assert.equal(calls, 2);
});

test("signed-out status is returned immediately and command failures are not retried", async () => {
  assert.deepEqual(await claudeAuth({
    path: "fixture-claude", run: async () => ({ stdout: '{"loggedIn":false}' }),
  }), { loggedIn: false });
  let calls = 0;
  const failure = new Error("command timed out");
  await assert.rejects(claudeAuth({
    path: "fixture-claude", run: async () => { calls++; throw failure; },
  }), (error) => error === failure);
  assert.equal(calls, 1);
});

test("a broken session stream reports its stage, closes, and never replays the turn", async () => {
  let starts = 0, closed = false;
  const cause = new SyntaxError("Unexpected end of JSON input");
  await assert.rejects(runClaude({
    project: { path: process.cwd() }, text: "fixture",
    signal: new AbortController().signal, emit() {},
  }, {
    baseOptions: () => ({}),
    readAuth: async () => ({ loggedIn: true }),
    usageForAccount: () => ({ read: async () => ({ usage: {}, reason: null }) }),
    queryFn: () => {
      starts++;
      return {
        close() { closed = true; },
        async *[Symbol.asyncIterator]() { throw cause; },
      };
    },
  }), (error) => {
    assert.match(error.message, /JSON during its session stream/);
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(starts, 1);
  assert.equal(closed, true);
});
