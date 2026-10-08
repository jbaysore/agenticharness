import test from "node:test";
import assert from "node:assert/strict";
import { providerStatusLabel } from "../src/ui/status.mjs";

test("a usage block is labeled separately from setup", () => {
  assert.equal(
    providerStatusLabel({
      connected: true,
      blockReason:
        "Included Codex usage is exhausted. Wait for the provider to restore it.",
    }),
    "Out of usage",
  );
  assert.equal(
    providerStatusLabel({
      connected: true,
      blockReason: "Included Codex quota is exhausted.",
    }),
    "Out of usage",
  );
  assert.equal(
    providerStatusLabel({
      connected: true,
      blockReason: "A provider usage limit has been reached.",
    }),
    "Out of usage",
  );
  assert.equal(
    providerStatusLabel({
      connected: true,
      blockReason: "A Claude included-usage limit is exhausted.",
    }),
    "Out of usage",
  );
  assert.equal(
    providerStatusLabel({
      connected: true,
      blockReason:
        "Recheck the provider paid-usage setting. The previous verification is over 24 hours old.",
    }),
    "Setup needed",
  );
  assert.equal(
    providerStatusLabel({
      connected: false,
      blockReason: "Sign in with Cursor CLI browser login.",
    }),
    "Setup needed",
  );
  assert.equal(providerStatusLabel({ connected: true }), "Connected");
  assert.equal(providerStatusLabel({ connected: false }), "Checking…");
});
