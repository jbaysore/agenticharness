import test from "node:test";
import assert from "node:assert/strict";
import { codexServerArgs } from "../src/providers/codex.mjs";

test("Windows Codex launch keeps commands on the elevated private desktop", () => {
  const args = codexServerArgs("win32");
  assert.ok(args.includes("features.prefer_mxc=false"));
  assert.ok(args.includes('windows.sandbox="elevated"'));
  assert.equal(
    args.some(
      (arg) =>
        arg === "features.prefer_mxc=true" ||
        arg.includes("unelevated") ||
        arg.includes("sandbox_private_desktop"),
    ),
    false,
  );
});

test("non-Windows Codex launch does not select a Windows sandbox", () => {
  const args = codexServerArgs("linux");
  assert.equal(
    args.some(
      (arg) => arg.includes("prefer_mxc") || arg.includes("windows.sandbox"),
    ),
    false,
  );
});
