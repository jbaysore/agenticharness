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
  assert.deepEqual(
    subscriptionEnvironment({ Path: "user-tools" }, { platform: "win32" }),
    { Path: "user-tools" },
  );
});
