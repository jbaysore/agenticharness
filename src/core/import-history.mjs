import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, join, resolve } from "node:path";

const TEXT_TYPES = new Set(["text", "input_text", "output_text"]);
const MAX_MESSAGE = 12000;
const MAX_MESSAGES = 400;

export function visibleText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block) =>
        block &&
        typeof block.text === "string" &&
        TEXT_TYPES.has(block.type),
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function clip(text) {
  const clean = text.replace(/\s+\n/g, "\n").trim();
  return clean.length > MAX_MESSAGE
    ? clean.slice(0, MAX_MESSAGE) + "\n…"
    : clean;
}

function titleFrom(text, fallback) {
  const line = text.split("\n").find((part) => part.trim()) ?? fallback;
  return line.replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
}

async function readRows(path, onRow) {
  const rl = createInterface({ input: createReadStream(path) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      onRow(JSON.parse(line));
    } catch {
      /* Skip a damaged transcript line and keep the rest. */
    }
  }
  rl.close();
}

async function filesUnder(dir, accept, found = []) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".tmp") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await filesUnder(path, accept, found);
    else if (accept(path, entry.name)) found.push(path);
  }
  return found;
}

function cursorProjectKey(file) {
  const parts = file.split(/[\\/]/);
  const index = parts.lastIndexOf("agent-transcripts");
  return index > 0 ? parts[index - 1] : "";
}

export function cursorSlug(filePath) {
  const full = resolve(filePath);
  return (full[0] + full.slice(2)).replace(/[^A-Za-z0-9]/g, "-");
}

export async function parseCursorTranscript(file) {
  const messages = [];
  await readRows(file, (row) => {
    if (messages.length >= MAX_MESSAGES) return;
    if (row.role !== "user" && row.role !== "assistant") return;
    const text = clip(visibleText(row.message?.content));
    if (text) messages.push({ role: row.role, content: text });
  });
  if (!messages.length) return null;
  const info = await stat(file);
  const when = info.mtime.toISOString();
  return {
    provider: "cursor",
    cwd: null,
    cursorKey: cursorProjectKey(file),
    title: titleFrom(
      messages.find((message) => message.role === "user")?.content ?? "",
      "Imported Cursor conversation",
    ),
    createdAt: when,
    updatedAt: when,
    messages,
    label: basename(file, ".jsonl"),
  };
}

export async function parseCodexTranscript(file) {
  const messages = [];
  let cwd = null;
  let createdAt = null;
  await readRows(file, (row) => {
    if (row.type === "session_meta") {
      cwd = row.payload?.cwd || cwd;
      createdAt = row.payload?.timestamp || row.timestamp || createdAt;
      return;
    }
    if (messages.length >= MAX_MESSAGES) return;
    if (row.type !== "response_item" || row.payload?.type !== "message") return;
    if (row.payload.role !== "user" && row.payload.role !== "assistant") return;
    const text = clip(visibleText(row.payload.content));
    if (!text) return;
    messages.push({
      role: row.payload.role,
      content: text,
      createdAt: row.timestamp,
    });
  });
  if (!messages.length) return null;
  return {
    provider: "codex",
    cwd,
    title: titleFrom(
      messages.find((message) => message.role === "user")?.content ?? "",
      "Imported Codex conversation",
    ),
    createdAt: createdAt || messages[0].createdAt,
    updatedAt: messages.at(-1).createdAt || createdAt,
    messages,
    label: basename(file, ".jsonl"),
  };
}

export async function parseClaudeTranscript(file) {
  const messages = [];
  let cwd = null;
  let title = "";
  let createdAt = null;
  await readRows(file, (row) => {
    if (row.isSidechain) return;
    if (row.type === "ai-title" || row.type === "custom-title") {
      const next = row.customTitle || row.aiTitle || row.title;
      if (typeof next === "string" && next.trim()) title = next.trim();
      return;
    }
    if (messages.length >= MAX_MESSAGES) return;
    if (row.type !== "user" && row.type !== "assistant") return;
    cwd = row.cwd || cwd;
    createdAt = createdAt || row.timestamp;
    const text = clip(visibleText(row.message?.content));
    if (!text) return;
    messages.push({
      role: row.type,
      content: text,
      createdAt: row.timestamp,
    });
  });
  if (!messages.length) return null;
  return {
    provider: "claude",
    cwd,
    title: titleFrom(
      title,
      titleFrom(
        messages.find((message) => message.role === "user")?.content ?? "",
        "Imported Claude conversation",
      ),
    ),
    createdAt: createdAt || messages[0].createdAt,
    updatedAt: messages.at(-1).createdAt || createdAt,
    messages,
    label: basename(file, ".jsonl"),
  };
}

function projectFor(store, transcript, projects) {
  if (transcript.cwd) {
    const wanted = resolve(transcript.cwd).toLowerCase();
    const match = projects.find(
      (project) => resolve(project.path).toLowerCase() === wanted,
    );
    if (match) return match;
  }
  if (transcript.cursorKey) {
    const match = projects.find(
      (project) => cursorSlug(project.path).toLowerCase() === transcript.cursorKey.toLowerCase(),
    );
    if (match) return match;
  }
  return null;
}

export async function importLocalHistory(
  store,
  {
    cursorRoot,
    codexRoot,
    claudeRoot,
    importedPath,
  },
) {
  const remembered = store.setting("history-imports") ?? {};
  const projects = store.projects().filter((project) => project.path !== importedPath);
  let importedProject = null;
  const result = { imported: 0, skipped: 0, empty: 0, failed: 0 };
  const sources = [
    ...(cursorRoot
      ? (
          await filesUnder(cursorRoot, (path) =>
            path.includes(`${join("agent-transcripts")}`) && path.endsWith(".jsonl"),
          )
        ).map((file) => ["cursor:" + resolve(file), file, parseCursorTranscript])
      : []),
    ...(codexRoot
      ? (
          await filesUnder(
            join(codexRoot, "sessions"),
            (path) => path.endsWith(".jsonl"),
          )
        )
          .concat(
            await filesUnder(
              join(codexRoot, "archived_sessions"),
              (path) => path.endsWith(".jsonl"),
            ),
          )
          .map((file) => ["codex:" + resolve(file), file, parseCodexTranscript])
      : []),
    ...(claudeRoot
      ? (
          await filesUnder(claudeRoot, (path) => path.endsWith(".jsonl"))
        ).map((file) => ["claude:" + resolve(file), file, parseClaudeTranscript])
      : []),
  ];
  for (const [key, file, parse] of sources) {
    const existing = remembered[key];
    if (existing && store.conversation(existing)) {
      result.skipped += 1;
      continue;
    }
    let transcript;
    try {
      transcript = await parse(file);
    } catch {
      result.failed += 1;
      continue;
    }
    if (!transcript) {
      result.empty += 1;
      continue;
    }
    let project = projectFor(store, transcript, projects);
    if (!project) {
      await mkdir(importedPath, { recursive: true });
      importedProject ??= store.addProject("Imported history", importedPath);
      project = importedProject;
    }
    const chat = store.createConversation({
      projectId: project.id,
      title: transcript.title,
      provider: transcript.provider,
      model: "",
      createdAt: transcript.createdAt,
    });
    store.addMessage({
      conversationId: chat.id,
      role: "assistant",
      provider: transcript.provider,
      content: `Imported from ${transcript.provider}. This is a saved transcript, not a resumable native session.\nSource: ${transcript.label}`,
      createdAt: transcript.createdAt,
    });
    for (const message of transcript.messages)
      store.addMessage({
        conversationId: chat.id,
        role: message.role,
        provider: message.role === "assistant" ? transcript.provider : null,
        content: message.content,
        createdAt: message.createdAt || transcript.createdAt,
      });
    store.stampConversation(
      chat.id,
      transcript.createdAt || store.now(),
      transcript.updatedAt || transcript.createdAt || store.now(),
    );
    remembered[key] = chat.id;
    result.imported += 1;
  }
  store.setting("history-imports", remembered);
  return result;
}
