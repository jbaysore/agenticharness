import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectInstructions } from "../src/providers/claude.mjs";

test("Claude gets AGENTS.md once, plus only the Claude-only part of CLAUDE.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-instructions-"));
  assert.equal(await projectInstructions(dir), "");

  await writeFile(join(dir, "AGENTS.md"), "# Rules\n- Commit and push.\n");
  await writeFile(join(dir, "CLAUDE.md"), "@AGENTS.md\r\n");
  assert.equal(
    await projectInstructions(dir),
    "Project instructions from AGENTS.md:\n# Rules\n- Commit and push.",
  );

  // Repos that keep the two files identical still get one copy.
  await writeFile(join(dir, "CLAUDE.md"), "# Rules\n- Commit and push.\n");
  assert.equal(
    await projectInstructions(dir),
    "Project instructions from AGENTS.md:\n# Rules\n- Commit and push.",
  );

  await writeFile(join(dir, "CLAUDE.md"), "@./AGENTS.md\n\n- Prefer Edit.\n");
  assert.equal(
    await projectInstructions(dir),
    "Project instructions from AGENTS.md:\n# Rules\n- Commit and push.\n\nProject instructions from CLAUDE.md:\n- Prefer Edit.",
  );
});
