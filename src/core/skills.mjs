// Named instructions the user writes once and turns on for a chat. The host
// includes the full text in the instruction block every agent already receives.
// No Node builtin: the composer imports the limits from this file.

export const MAX_SKILLS = 40,
  MAX_NAME = 60,
  MAX_INSTRUCTIONS = 8000,
  MAX_PER_CHAT = 6;
const SKILLS_KEY = "skills",
  CHAT_SKILLS_KEY = "chat-skills";

const clean = (skill) =>
  skill &&
  typeof skill.id === "string" &&
  skill.id &&
  typeof skill.name === "string" &&
  typeof skill.instructions === "string"
    ? {
        id: skill.id,
        name: skill.name,
        instructions: skill.instructions,
      }
    : null;

export function listSkills(store) {
  const saved = store.setting(SKILLS_KEY);
  return Array.isArray(saved) ? saved.map(clean).filter(Boolean) : [];
}

function writeSkills(store, skills) {
  store.setting(SKILLS_KEY, skills);
  return skills;
}

function nameOf(name) {
  const text = String(name ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!text) throw new Error("Give the skill a name");
  if (text.length > MAX_NAME)
    throw new Error(
      `A skill name can be at most ${MAX_NAME} characters`,
    );
  return text;
}

function bodyOf(instructions) {
  if (typeof instructions !== "string")
    throw new Error("Skill instructions must be text");
  const text = instructions.trim();
  if (!text)
    throw new Error("Write the instructions this skill gives an agent");
  if (text.length > MAX_INSTRUCTIONS)
    throw new Error(
      `Skill instructions can be at most ${MAX_INSTRUCTIONS.toLocaleString("en-US")} characters`,
    );
  return text;
}

const taken = (skills, name, except) =>
  skills.some(
    (skill) =>
      skill.id !== except && skill.name.toLowerCase() === name.toLowerCase(),
  );

export function createSkill(store, input) {
  const skills = listSkills(store);
  if (skills.length >= MAX_SKILLS)
    throw new Error(`You can keep up to ${MAX_SKILLS} skills`);
  const name = nameOf(input?.name);
  if (taken(skills, name))
    throw new Error("A skill with that name already exists");
  const skill = {
    id: crypto.randomUUID(),
    name,
    instructions: bodyOf(input?.instructions),
  };
  writeSkills(store, [...skills, skill]);
  return skill;
}

export function updateSkill(store, id, input) {
  const skills = listSkills(store),
    index = skills.findIndex((skill) => skill.id === id);
  if (index < 0) throw new Error("That skill no longer exists");
  const name = nameOf(input?.name);
  if (taken(skills, name, id))
    throw new Error("A skill with that name already exists");
  const skill = { id, name, instructions: bodyOf(input?.instructions) },
    next = skills.slice();
  next[index] = skill;
  writeSkills(store, next);
  return skill;
}

function chatMap(store) {
  const saved = store.setting(CHAT_SKILLS_KEY);
  return saved && typeof saved === "object" && !Array.isArray(saved)
    ? saved
    : {};
}

function writeChatMap(store, map) {
  store.setting(CHAT_SKILLS_KEY, map);
}

export function deleteSkill(store, id) {
  const skills = listSkills(store);
  if (!skills.some((skill) => skill.id === id))
    throw new Error("That skill no longer exists");
  writeSkills(
    store,
    skills.filter((skill) => skill.id !== id),
  );
  const map = {};
  for (const [chatId, ids] of Object.entries(chatMap(store))) {
    if (!Array.isArray(ids)) continue;
    const kept = ids.filter((skillId) => skillId !== id);
    if (kept.length) map[chatId] = kept;
  }
  writeChatMap(store, map);
  return { id };
}

// Ids the chat still has, in the order the user ticked them. A deleted skill
// is dropped here so a turn never receives a missing body.
export function chatSkillIds(store, conversationId) {
  const ids = chatMap(store)[conversationId],
    known = new Set(listSkills(store).map((skill) => skill.id));
  return Array.isArray(ids)
    ? ids.filter((id) => typeof id === "string" && known.has(id))
    : [];
}

export function setChatSkills(store, conversationId, skillIds) {
  if (!Array.isArray(skillIds)) throw new Error("Choose skills from the list");
  const unique = [];
  for (const id of skillIds) {
    if (typeof id !== "string" || !id)
      throw new Error("Choose skills from the list");
    if (!unique.includes(id)) unique.push(id);
  }
  if (unique.length > MAX_PER_CHAT)
    throw new Error(`A chat can use at most ${MAX_PER_CHAT} skills`);
  const known = new Set(listSkills(store).map((skill) => skill.id));
  if (unique.some((id) => !known.has(id)))
    throw new Error("Choose a skill that still exists");
  const map = { ...chatMap(store) };
  if (unique.length) map[conversationId] = unique;
  else delete map[conversationId];
  writeChatMap(store, map);
  return unique;
}

export function skillsForTurn(store, conversationId) {
  const byId = new Map(listSkills(store).map((skill) => [skill.id, skill]));
  return chatSkillIds(store, conversationId)
    .map((id) => byId.get(id))
    .filter(Boolean);
}

export function skillInstructions(skills) {
  if (!skills.length) return "";
  return (
    "\nSkills the user turned on for this chat. Follow each one. The same text is given to Codex, Claude Code and Cursor.\n\n" +
    skills.map((skill) => `Skill: ${skill.name}\n${skill.instructions}`).join("\n\n")
  );
}
