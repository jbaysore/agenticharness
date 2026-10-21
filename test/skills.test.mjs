import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { createHarness } from "../src/server.mjs";
import {
  MAX_INSTRUCTIONS,
  MAX_NAME,
  MAX_PER_CHAT,
  MAX_SKILLS,
  applyCommand,
  createSkill,
  deleteSkill,
  invokedSkills,
  listSkills,
  skillInstructions,
  slashToken,
  updateSkill,
} from "../src/core/skills.mjs";

const providers = ["codex", "claude", "cursor"].map((id) => ({
  id,
  name: id,
  connected: true,
  models: [{ id: "m", name: "M", efforts: [] }],
}));

test("a skill is named text, kept once, and dropped from chats when deleted", () => {
  const store = new Store(":memory:");
  assert.deepEqual(listSkills(store), []);
  assert.equal(skillInstructions([]), "");
  assert.throws(() => createSkill(store, { name: "  ", instructions: "x" }), /name/);
  assert.throws(
    () => createSkill(store, { name: "Notes", instructions: "  " }),
    /instructions/,
  );
  assert.throws(
    () =>
      createSkill(store, {
        name: "n".repeat(MAX_NAME + 1),
        instructions: "x",
      }),
    /name/,
  );
  assert.throws(
    () =>
      createSkill(store, {
        name: "Too long",
        instructions: "x".repeat(MAX_INSTRUCTIONS + 1),
      }),
    /instructions/,
  );
  const notes = createSkill(store, {
      name: "  Review   notes ",
      instructions: "  Write the decision down.\nKeep the source.  ",
    }),
    other = createSkill(store, {
      name: "Release notes",
      instructions: "Draft from the diff.",
    });
  assert.equal(notes.name, "Review notes");
  assert.equal(notes.command, "review-notes");
  assert.throws(
    () => createSkill(store, { name: "123", instructions: "x" }),
    /letter/,
  );
  assert.throws(
    () => createSkill(store, { name: "Release-notes", instructions: "Again." }),
    /slash command/,
  );
  assert.equal(notes.instructions, "Write the decision down.\nKeep the source.");
  assert.throws(
    () => createSkill(store, { name: "review notes", instructions: "Again." }),
    /already exists/,
  );
  const renamed = updateSkill(store, notes.id, {
    name: "Decisions",
    instructions: "Record the decision and the file it came from.",
  });
  assert.equal(renamed.id, notes.id);
  assert.throws(
    () =>
      updateSkill(store, notes.id, {
        name: "Release notes",
        instructions: "x",
      }),
    /already exists/,
  );
  assert.throws(() => updateSkill(store, "missing", { name: "A", instructions: "B" }), /no longer exists/);
  const listed = listSkills(store);
  assert.deepEqual(
    invokedSkills(listed, "/decisions look at src/release-notes").map(
      (skill) => skill.name,
    ),
    ["Decisions"],
  );
  assert.deepEqual(
    invokedSkills(listed, "See /Release-notes and /decisions again").map(
      (skill) => skill.command,
    ),
    ["release-notes", "decisions"],
  );
  assert.deepEqual(invokedSkills(listed, "no command here"), []);
  assert.match(skillInstructions(invokedSkills(listed, "/decisions")), /Skill: Decisions/);
  const token = slashToken("Please /rev", "Please /rev".length);
  assert.equal(token.query, "rev");
  assert.equal(
    applyCommand("Please /rev", "Please /rev".length, "decisions").text,
    "Please /decisions ",
  );
  deleteSkill(store, notes.id);
  assert.deepEqual(invokedSkills(listSkills(store), "/decisions"), []);
  assert.throws(() => deleteSkill(store, notes.id), /no longer exists/);
  const many = [other];
  for (let i = 1; i <= MAX_PER_CHAT; i++)
    many.push(createSkill(store, { name: "Skill " + i, instructions: "Do " + i }));
  assert.equal(
    invokedSkills(
      listSkills(store),
      many.map((skill) => "/" + skill.command).join(" "),
    ).length,
    MAX_PER_CHAT,
  );
  for (let i = listSkills(store).length; i < MAX_SKILLS; i++)
    createSkill(store, { name: "Extra " + i, instructions: "Do " + i });
  assert.throws(
    () => createSkill(store, { name: "One more", instructions: "No." }),
    /up to/,
  );
  store.setting("skills", [{ id: "", name: "Broken" }, null, other]);
  assert.deepEqual(listSkills(store), [other]);
  store.close();
});

test("a slash command includes the skill on that message for every agent", async () => {
  const store = new Store(":memory:"),
    controller = new Controller(store, {});
  controller.providers = providers;
  const project = store.addProject("fixture", "C:\\skills-turn"),
    notes = createSkill(store, {
      name: "Review notes",
      instructions: "Write the decision down.",
    });
  const seen = {},
    events = [];
  controller.on("event", (event) => events.push(event));
  for (const provider of providers) {
    controller.runners[provider.id] = async (ctx) => {
      seen[ctx.chat.id] = ctx.instructions;
      return { status: "completed" };
    };
    const chat = store.createConversation({
      projectId: project.id,
      provider: provider.id,
      model: "m",
      title: provider.id,
    });
    controller.send(chat.id, {
      actionId: "skills-turn-" + provider.id + "-check",
      text:
        provider.id === "cursor"
          ? "Look at the parser"
          : "/review-notes Look at the parser",
      provider: provider.id,
      model: "m",
    });
    await controller.active.get(chat.id).task;
    if (provider.id === "cursor")
      assert.doesNotMatch(seen[chat.id], /Skill: Review notes/);
    else {
      assert.match(seen[chat.id], /Skill: Review notes/);
      assert.match(seen[chat.id], /Write the decision down\./);
    }
  }
  const logged = events.filter((event) => event.payload.kind === "skills");
  assert.equal(logged.length, 2);
  assert.match(logged[0].payload.item.title, /Skill · Review notes/);
  updateSkill(store, notes.id, {
    name: "Review notes",
    instructions: "Name the file the decision came from.",
  });
  const again = store.conversations().find((chat) => chat.title === "codex");
  controller.send(again.id, {
    actionId: "skills-turn-codex-updated",
    text: "/review-notes Look again",
    provider: "codex",
    model: "m",
  });
  await controller.active.get(again.id).task;
  assert.match(seen[again.id], /Name the file the decision came from\./);
  assert.doesNotMatch(seen[again.id], /Write the decision down/);
  store.close();
});

test("skill routes create, edit and delete, and publish the slash command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-skills-")),
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false });
  try {
    const headers = {
        "Content-Type": "application/json",
        "X-Harness-Client": "1",
      },
      call = async (path, body, method = "GET") => {
        const response = await fetch(app.runtime.origin + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
    assert.deepEqual((await call("/api/state")).body.skills, []);
    const missing = await call(
      "/api/skills",
      { name: "Notes", instructions: "" },
      "POST",
    );
    assert.equal(missing.status, 400);
    const created = await call(
      "/api/skills",
      { name: "Review notes", instructions: "Write the decision down." },
      "POST",
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.command, "review-notes");
    const edited = await call(
      "/api/skills/" + created.body.id,
      { name: "Decisions", instructions: "Name the file." },
      "PATCH",
    );
    assert.equal(edited.status, 200);
    assert.equal(edited.body.name, "Decisions");
    assert.equal(edited.body.command, "decisions");
    const clash = await call(
      "/api/skills",
      { name: "Decisions!", instructions: "Again." },
      "POST",
    );
    assert.equal(clash.status, 400);
    assert.match(clash.body.error, /slash command/);
    const removed = await call("/api/skills/" + created.body.id, undefined, "DELETE");
    assert.equal(removed.status, 200);
    assert.deepEqual((await call("/api/state")).body.skills, []);
    const exported = await call("/api/export");
    assert.deepEqual(exported.body.skills, []);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
