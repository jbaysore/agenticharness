import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { subscriptionEnvironment } from "../src/security/environment.mjs";

test("provider commands find bundled ripgrep while keeping user tools and credential filtering", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-command-env-"));
  try {
    const resources = (version) =>
      join(
        root,
        "WindowsApps",
        `OpenAI.Codex_${version}_x64__2p2nqsd0c76g0`,
        "app",
        "resources",
      );
    for (const version of ["26.9.1.0", "26.10.1.0"]) {
      await mkdir(resources(version), { recursive: true });
      await writeFile(join(resources(version), "rg.exe"), "fixture");
    }
    const source = {
      ProgramFiles: root,
      Path: "user-tools;system-tools",
      OPENAI_API_KEY: "blocked",
      USERPROFILE: root,
    };
    const env = subscriptionEnvironment(source, { platform: "win32" });
    assert.equal(env.Path, `user-tools;system-tools;${resources("26.10.1.0")}`);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(source.Path, "user-tools;system-tools");
    assert.deepEqual(subscriptionEnvironment(env, { platform: "win32" }), env);
    assert.equal(
      subscriptionEnvironment(source, { platform: "linux" }).Path,
      source.Path,
    );
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI-only installations keep their existing command PATH", () => {
  const env = subscriptionEnvironment(
    { Path: "user-tools", USERPROFILE: "C:\\no-claude-fixture" },
    { platform: "win32" },
  );
  assert.equal(env.Path, "user-tools");
  assert.equal(env.PSExecutionPolicyPreference, "Bypass");
});

test("child shells find a standalone Claude install and preserve an explicit process policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-claude-path-"));
  try {
    const bin = join(root, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude.exe"), "fixture");
    const env = subscriptionEnvironment(
      {
        USERPROFILE: root,
        Path: "user-tools",
        PSExecutionPolicyPreference: "RemoteSigned",
      },
      { platform: "win32" },
    );
    assert.equal(env.Path, `user-tools;${bin}`);
    assert.equal(env.PSExecutionPolicyPreference, "RemoteSigned");
    assert.deepEqual(subscriptionEnvironment(env, { platform: "win32" }), env);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
