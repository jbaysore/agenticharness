import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeContent, claudeGoalContext } from "../src/providers/attachments.mjs";

test("new Claude Goals do not duplicate their objective as feedback", async () => {
  for (const goalObjective of [undefined, "Ship the release"]) {
    const prompt = await claudeContent({ mode: "goal", text: "Ship the release", goalObjective });
    assert.equal(prompt.split("Ship the release").length - 1, 1);
    assert.doesNotMatch(prompt, /Latest message/);
  }
});

test("restoring a Claude Goal without a message adds no empty feedback", async () => {
  for (const text of [undefined, ""]) {
    const prompt = await claudeContent({ mode: "goal", goalObjective: "Ship the release", text });
    assert.match(prompt, /Full Harness Goal \(binding objective\):\nShip the release/);
    assert.doesNotMatch(prompt, /Latest message/);
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
    const ctx = {
      mode: "goal",
      resumeGoal: true,
      text,
      goalObjective: "Ship the release",
      addendum: "Memory and skill instructions",
      handoff: "Earlier work from another provider",
      attachments: [{ type: "image/png", path }],
    };
    const content = await claudeContent(ctx);
    assert.equal(content.length, 2);
    assert.match(content[0].text, /Full Harness Goal \(binding objective\):\nShip the release/);
    assert.ok(content[0].text.includes(`Latest message for this Goal:\n${text}`));
    assert.equal(claudeGoalContext(ctx), `Full Harness Goal (binding objective):\nShip the release\n\nMemory and skill instructions\n\nEarlier work from another provider\n\nLatest message for this Goal:\n${text}`);
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
  assert.match(
    await claudeContent({
      mode: "goal",
      continuing: true,
      goalObjective: "Ship the release",
      text,
    }),
    /Latest message for this Goal:\nPermissions changed/,
  );
});

test("resumed Claude prompts replace stale native questions with the canonical Goal and identity", async () => {
  const objective = "Launch the whole product and verify customer delivery and rollback.";
  const prompt = await claudeContent({
    mode: "goal", session: { id: "old-session", goal: { objective: "How will I know when it is done?" } },
    goalObjective: objective, goalProgress: () => ({ goalId: "canonical-goal" }),
    text: "Resume the paused goal.",
  });
  assert.match(prompt, /Current Harness Goal ID: canonical-goal/);
  assert.ok(prompt.includes(`Full Harness Goal (binding objective):\n${objective}`));
  assert.match(prompt, /Latest message for this Goal:\nResume the paused goal\./);
  assert.match(prompt, /earlier native Goal condition or status question is superseded/);
  assert.doesNotMatch(prompt, /How will I know/);
});
