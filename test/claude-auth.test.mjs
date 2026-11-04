import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CLAUDE_SIGN_IN,
  claudeAuth,
  inspectClaude,
  runClaude,
  startClaudeLogin,
} from "../src/providers/claude.mjs";

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

test("a signed-out status on a failing exit is returned without retry", async () => {
  let calls = 0;
  const failure = Object.assign(new Error("Command failed: claude auth status\n"), {
    code: 1,
    stdout: JSON.stringify({
      loggedIn: false,
      authMethod: "none",
      apiProvider: "firstParty",
    }),
  });
  const auth = await claudeAuth({
    path: "fixture-claude",
    run: async () => {
      calls++;
      throw failure;
    },
  });
  assert.equal(calls, 1);
  assert.equal(auth.loggedIn, false);
  assert.equal(auth.authMethod, "none");
});

test("a buffer status on a failing exit is accepted", async () => {
  const failure = Object.assign(new Error("Command failed"), {
    stdout: Buffer.from('{"loggedIn":true}'),
  });
  const auth = await claudeAuth({
    path: "fixture-claude",
    run: async () => {
      throw failure;
    },
  });
  assert.equal(auth.loggedIn, true);
});

test("a failing sign-in command without status is not retried or echoed", async () => {
  for (const stdout of ["private diagnostic", undefined, 12]) {
    let calls = 0;
    const failure = Object.assign(new Error("command timed out"), { stdout });
    await assert.rejects(
      claudeAuth({
        path: "fixture-claude",
        run: async () => {
          calls++;
          throw failure;
        },
      }),
      (error) => {
        assert.equal(error, failure);
        assert.doesNotMatch(error.message, /private diagnostic/);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
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

test("a signed-out connection asks for the subscription login", async () => {
  const provider = await inspectClaude(process.cwd(), {
    readAuth: async () => ({ loggedIn: false }),
    baseOptions: () => {
      throw new Error("signed-out status does not start a session");
    },
  });
  assert.equal(provider.connected, false);
  assert.equal(provider.signIn, CLAUDE_SIGN_IN);
  assert.equal(provider.signIn.command, "claude auth login --claudeai");
  assert.doesNotMatch(provider.signIn.command, /--console/);
});

test("a connected Claude account has no sign-in request", async () => {
  let closed = false;
  const provider = await inspectClaude(process.cwd(), {
    readAuth: async () => ({ loggedIn: true, subscriptionType: "pro" }),
    baseOptions: () => ({}),
    usageForAccount: () => ({
      read: async () => ({ reason: null, usage: {} }),
    }),
    queryFn: () => ({
      supportedModels: async () => [],
      close() {
        closed = true;
      },
    }),
  });
  assert.equal(provider.connected, true);
  assert.equal(provider.plan, "pro");
  assert.equal("signIn" in provider, false);
  assert.equal(closed, true);
});

function loginChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit("close", null);
  return child;
}

test("subscription login uses a fixed command, one start, and returns only the URL", async () => {
  const gate = { current: null };
  const child = loginChild();
  let args;
  const login = startClaudeLogin({
    path: "fixture-claude",
    gate,
    spawnFn: (path, command, options) => {
      args = { path, command, windowsHide: options.windowsHide };
      assert.deepEqual(command, ["auth", "login", "--claudeai"]);
      assert.equal(options.windowsHide, true);
      return child;
    },
  });
  assert.throws(
    () => startClaudeLogin({ path: "fixture-claude", gate, spawnFn: () => loginChild() }),
    /already in progress/,
  );
  child.stdout.emit(
    "data",
    "token=secret-value\nhttps://claude.ai/login).\n",
  );
  const status = await login.result;
  assert.deepEqual(status, { url: "https://claude.ai/login", pending: true });
  assert.equal(JSON.stringify(status).includes("secret-value"), false);
  assert.equal(args.path, "fixture-claude");
  child.emit("close", 0);
  await login.done;
  const again = loginChild();
  const next = startClaudeLogin({
    path: "fixture-claude",
    gate,
    spawnFn: () => again,
  });
  again.emit("close", 1);
  const finished = await next.result;
  assert.equal(finished.pending, false);
  assert.equal(finished.url, null);
  assert.equal("stdout" in finished, false);
});
