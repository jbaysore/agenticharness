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
  chatSkillIds,
  createSkill,
  deleteSkill,
  listSkills,
  setChatSkills,
  skillInstructions,
  skillsForTurn,
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
  const chat = store.createConversation({
      projectId: store.addProject("fixture", "C:\\skills-fixture").id,
    }),
    elsewhere = store.createConversation({
      projectId: store.projects()[0].id,
      title: "Elsewhere",
    });
  assert.deepEqual(setChatSkills(store, chat.id, [other.id, notes.id, other.id]), [
    other.id,
    notes.id,
  ]);
  assert.deepEqual(
    skillsForTurn(store, chat.id).map((skill) => skill.name),
    ["Release notes", "Decisions"],
  );
  assert.deepEqual(chatSkillIds(store, elsewhere.id), []);
  assert.match(skillInstructions(skillsForTurn(store, chat.id)), /Skill: Decisions/);
  assert.match(
    skillInstructions(skillsForTurn(store, chat.id)),
    /Record the decision and the file it came from\./,
  );
  deleteSkill(store, notes.id);
  assert.deepEqual(chatSkillIds(store, chat.id), [other.id]);
  assert.throws(() => deleteSkill(store, notes.id), /no longer exists/);
  assert.deepEqual(setChatSkills(store, chat.id, []), []);
  assert.equal(chatSkillIds(store, chat.id).length, 0);
  const many = [other];
  for (let i = 1; i <= MAX_PER_CHAT; i++)
    many.push(createSkill(store, { name: "Skill " + i, instructions: "Do " + i }));
  assert.throws(
    () =>
      setChatSkills(
        store,
        chat.id,
        many.map((skill) => skill.id),
      ),
    /at most/,
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

test("ticked skills are included on the next turn for every agent, and only for that chat", async () => {
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
    if (provider.id !== "cursor") setChatSkills(store, chat.id, [notes.id]);
    controller.send(chat.id, {
      actionId: "skills-turn-" + provider.id + "-check",
      text: "Look at the parser",
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
    text: "Look again",
    provider: "codex",
    model: "m",
  });
  await controller.active.get(again.id).task;
  assert.match(seen[again.id], /Name the file the decision came from\./);
  assert.doesNotMatch(seen[again.id], /Write the decision down/);
  store.close();
});

test("skill routes create, edit, assign and delete without touching another chat", async () => {
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
    const edited = await call(
      "/api/skills/" + created.body.id,
      { name: "Decisions", instructions: "Name the file." },
      "PATCH",
    );
    assert.equal(edited.status, 200);
    assert.equal(edited.body.name, "Decisions");
    const project = await call(
      "/api/projects",
      { path: dir, name: "Skills" },
      "POST",
    );
    const first = await call(
        "/api/chats",
        { projectId: project.body.id, provider: "codex", model: "m" },
        "POST",
      ),
      second = await call(
        "/api/chats",
        { projectId: project.body.id, provider: "claude", model: "m" },
        "POST",
      );
    const assigned = await call(
      "/api/chats/" + first.body.id + "/skills",
      { skillIds: [created.body.id] },
      "PUT",
    );
    assert.deepEqual(assigned.body.skillIds, [created.body.id]);
    assert.deepEqual((await call("/api/chats/" + first.body.id)).body.skillIds, [
      created.body.id,
    ]);
    assert.deepEqual((await call("/api/chats/" + second.body.id)).body.skillIds, []);
    const removed = await call("/api/skills/" + created.body.id, undefined, "DELETE");
    assert.equal(removed.status, 200);
    assert.deepEqual((await call("/api/chats/" + first.body.id)).body.skillIds, []);
    assert.deepEqual((await call("/api/state")).body.skills, []);
    const exported = await call("/api/export");
    assert.deepEqual(exported.body.skills, []);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
