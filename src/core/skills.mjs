// Named instructions the user writes once. A message invokes a skill by its
// slash command. The host then includes the full text in the instruction block
// every agent already receives. No Node builtin: the composer imports this file.

export const MAX_SKILLS = 40,
  MAX_NAME = 60,
  MAX_INSTRUCTIONS = 8000,
  MAX_PER_CHAT = 6;
const SKILLS_KEY = "skills";

// Built-in commands that switch the chat's mode instead of naming a skill.
export const MODE_COMMANDS = [
  { command: "default", mode: "default", name: "Default mode" },
  { command: "ask", mode: "ask", name: "Ask mode" },
  { command: "plan", mode: "plan", name: "Plan mode" },
  { command: "goal", mode: "goal", name: "Goal mode" },
];
// /queue waits for the current turn. /steer redirects that turn.
export const DELIVERY_COMMANDS = [
  {
    command: "queue",
    name: "Queue",
    description: "Send this after the current turn finishes",
  },
  {
    command: "steer",
    name: "Steer",
    description: "Redirect the turn that is running now",
  },
];
const modeFor = (command) =>
  MODE_COMMANDS.find((entry) => entry.command === command.toLowerCase());
const deliveryFor = (command) =>
  DELIVERY_COMMANDS.find((entry) => entry.command === command.toLowerCase());

// "Review notes" becomes /review-notes. Letters and digits stay; the rest
// becomes a single hyphen, so the command is something a person can type.
export function skillCommand(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

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

const withCommand = (skill) => {
  const row = clean(skill);
  return row && { ...row, command: skillCommand(row.name) };
};

export function listSkills(store) {
  const saved = store.setting(SKILLS_KEY);
  return Array.isArray(saved) ? saved.map(withCommand).filter(Boolean) : [];
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
    throw new Error(`A skill name can be at most ${MAX_NAME} characters`);
  if (!/^[a-z][a-z0-9-]*$/.test(skillCommand(text)))
    throw new Error(
      "Use a name that starts with a letter, so it can be a /command",
    );
  if (modeFor(skillCommand(text)))
    throw new Error(
      `/${skillCommand(text)} switches the chat's mode, so a skill cannot use that name`,
    );
  if (deliveryFor(skillCommand(text)))
    throw new Error(
      `/${skillCommand(text)} sends a message now or later, so a skill cannot use that name`,
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
const commandClash = (skills, name, except) =>
  skills.find(
    (skill) => skill.id !== except && skill.command === skillCommand(name),
  );

export function createSkill(store, input) {
  const skills = listSkills(store);
  if (skills.length >= MAX_SKILLS)
    throw new Error(`You can keep up to ${MAX_SKILLS} skills`);
  const name = nameOf(input?.name);
  if (taken(skills, name))
    throw new Error("A skill with that name already exists");
  const clash = commandClash(skills, name);
  if (clash)
    throw new Error(
      `That name uses the same slash command as ${clash.name} (/${clash.command})`,
    );
  const skill = withCommand({
    id: crypto.randomUUID(),
    name,
    instructions: bodyOf(input?.instructions),
  });
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
  const clash = commandClash(skills, name, id);
  if (clash)
    throw new Error(
      `That name uses the same slash command as ${clash.name} (/${clash.command})`,
    );
  const skill = withCommand({
      id,
      name,
      instructions: bodyOf(input?.instructions),
    }),
    next = skills.slice();
  next[index] = skill;
  writeSkills(store, next);
  return skill;
}

export function deleteSkill(store, id) {
  const skills = listSkills(store);
  if (!skills.some((skill) => skill.id === id))
    throw new Error("That skill no longer exists");
  writeSkills(
    store,
    skills.filter((skill) => skill.id !== id),
  );
  return { id };
}

// The /command being typed at the caret, if the caret is still inside it.
export function slashToken(text, caret) {
  const slice = String(text ?? "").slice(0, caret ?? 0);
  const match = slice.match(/(?:^|\s)(\/([a-z0-9-]*))$/i);
  if (!match) return null;
  return {
    query: match[2].toLowerCase(),
    start: slice.length - match[1].length,
  };
}

// Replace the command being typed with /command and a trailing space.
export function applyCommand(text, caret, command) {
  const token = slashToken(text, caret);
  if (!token) return { text, cursor: caret ?? 0 };
  const insert = "/" + command + " ";
  return {
    text:
      String(text).slice(0, token.start) + insert + String(text).slice(caret),
    cursor: token.start + insert.length,
  };
}

// Remove the command being typed, keeping the text around it.
export function dropCommand(text, caret) {
  const token = slashToken(text, caret);
  if (!token) return { text, cursor: caret ?? 0 };
  const rest = String(text).slice(caret).replace(/^ /, "");
  return {
    text: String(text).slice(0, token.start) + rest,
    cursor: token.start,
  };
}

// A message that opens with /ask, /plan, /goal or /default switches to that mode,
// and the rest of the message is sent in it.
export function leadingMode(text) {
  const match = String(text ?? "").match(/^\s*\/([a-z]+)(?:$|\s+)/i);
  const entry = match && modeFor(match[1]);
  return entry
    ? { mode: entry.mode, text: String(text).slice(match[0].length) }
    : null;
}

// A message that opens with /queue or /steer says when to deliver the rest.
export function leadingDelivery(text) {
  const match = String(text ?? "").match(/^\s*\/(queue|steer)(?:$|\s+)/i);
  const entry = match && deliveryFor(match[1]);
  return entry
    ? { delivery: entry.command, text: String(text).slice(match[0].length) }
    : null;
}

// Delivery first, then a mode command, so /steer /ask still changes mode.
export function prepareMessage(text) {
  const delivery = leadingDelivery(text);
  const body = delivery ? delivery.text : String(text ?? "");
  const mode = leadingMode(body);
  return {
    delivery: delivery?.delivery ?? null,
    mode: mode?.mode ?? null,
    text: mode ? mode.text : body,
  };
}

// Skills whose /command appears as its own word. A path such as src/review-notes
// does not count. The same command twice counts once. At most six.
export function invokedSkills(skills, text) {
  const byCommand = new Map(skills.map((skill) => [skill.command, skill])),
    found = [];
  const seen = new Set();
  for (const match of String(text ?? "").matchAll(
    /(?:^|\s)\/([a-z0-9-]+)(?=$|\s)/gi,
  )) {
    const skill = byCommand.get(match[1].toLowerCase());
    if (!skill || seen.has(skill.id)) continue;
    if (found.length >= MAX_PER_CHAT) break;
    seen.add(skill.id);
    found.push(skill);
  }
  return found;
}

export function skillInstructions(skills) {
  if (!skills.length) return "";
  return (
    "\nSkills the user invoked in this message with slash commands. Follow each one. The same text is given to Codex, Claude Code and Cursor.\n\n" +
    skills
      .map((skill) => `Skill: ${skill.name}\n${skill.instructions}`)
      .join("\n\n")
  );
}
