import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeContent } from "../src/providers/attachments.mjs";

test("new Claude Goals do not duplicate their objective as feedback", async () => {
  for (const goalObjective of [undefined, "Ship the release"]) {
    assert.equal(
      await claudeContent({ mode: "goal", text: "Ship the release", goalObjective }),
      "/goal Ship the release",
    );
  }
});

test("restoring a Claude Goal without a message adds no empty feedback", async () => {
  for (const text of [undefined, ""]) {
    assert.equal(
      await claudeContent({ mode: "goal", goalObjective: "Ship the release", text }),
      "/goal Ship the release",
    );
  }
});

test("Claude Goal feedback preserves context, attachment descriptions and image blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-goal-feedback-"));
  const path = join(dir, "error.png");
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  try {
    await writeFile(path, pixel);
    const text = "The command failed.\nSee attached error.png and output.txt.";
    const content = await claudeContent({
      mode: "goal",
      resumeGoal: true,
      text,
      goalObjective: "Ship the release",
      addendum: "Memory and skill instructions",
      handoff: "Earlier work from another provider",
      attachments: [{ type: "image/png", path }],
    });
    assert.equal(content.length, 2);
    assert.equal(
      content[0].text,
      `Memory and skill instructions\n\nEarlier work from another provider\n\nCurrent request:\nLatest message for this Goal:\n${text}\n\n/goal Ship the release`,
    );
    assert.deepEqual(content[1], {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: pixel.toString("base64"),
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude permission continuations carry feedback without recreating the Goal", async () => {
  const text =
    "Permissions changed. Continue from saved progress. Owner said the command failed.";
  assert.equal(
    await claudeContent({
      mode: "goal",
      continuing: true,
      goalObjective: "Ship the release",
      text,
    }),
    text,
  );
});
