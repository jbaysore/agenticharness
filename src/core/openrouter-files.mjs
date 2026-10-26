import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const contains = (root, file) => {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
};
const privatePath = (path) =>
  path
    .split(/[\\/]/)
    .some(
      (part) =>
        [".git", ".codex", ".aws", ".ssh", "secrets"].includes(
          part.toLowerCase(),
        ) || /^\.env(?:$|\.(?!example$|sample$))/i.test(part),
    );
const schema = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const pathFields = {
  path: { type: "string", minLength: 1, maxLength: 1000 },
  repository: { type: "integer", minimum: 0 },
};
export const openRouterFileTools = [
  {
    name: "read_file",
    description:
      "Read numbered UTF-8 text lines inside this chat's worktree or a read-only upstream repository. repository=0 is the worktree; 1 and above select upstream references in their listed order.",
    inputSchema: schema(
      {
        ...pathFields,
        startLine: { type: "integer", minimum: 1 },
        lineCount: { type: "integer", minimum: 1, maximum: 500 },
      },
      ["path"],
    ),
  },
  {
    name: "list_files",
    description:
      "List up to 1,000 files under a repository directory. Omits private configuration, dependencies, build output and symlinks.",
    inputSchema: schema(pathFields, ["path"]),
  },
  {
    name: "search_files",
    description:
      "Find a literal string in repository text files. Returns up to 100 numbered matches; truncated results do not prove absence.",
    inputSchema: schema(
      {
        ...pathFields,
        query: { type: "string", minLength: 1, maxLength: 500 },
        caseSensitive: { type: "boolean" },
      },
      ["path", "query"],
    ),
  },
  {
    name: "edit_file",
    description:
      "Replace exactly one occurrence of oldText in a worktree text file through Harness permission review. Read the file first. For a new file only, supply empty oldText. Upstream references and private configuration are read-only.",
    inputSchema: schema(
      {
        ...pathFields,
        oldText: { type: "string", maxLength: 200000 },
        newText: { type: "string", maxLength: 200000 },
      },
      ["path", "oldText", "newText"],
    ),
  },
];

export async function openRouterFilePath(
  project,
  input,
  { write = false } = {},
) {
  const index = input.repository ?? 0;
  const source =
    index === 0 ? project.path : project.repositories?.[index - 1]?.path;
  if (!source || (write && index !== 0))
    throw new Error(
      "Upstream repositories are read-only. Edit only this chat's worktree.",
    );
  const root = await realpath(source),
    file = resolve(root, input.path),
    rel = relative(root, file);
  if (
    !contains(root, file) ||
    (!rel && write) ||
    rel.includes(":") ||
    rel.split(/[\\/]/).some((part) => /[. ]$/.test(part)) ||
    privatePath(rel) ||
    (write &&
      rel
        .split(/[\\/]/)
        .some((part) =>
          [".agents", "node_modules"].includes(part.toLowerCase()),
        ))
  )
    throw new Error(
      "Choose a repository file outside private configuration and linked dependencies.",
    );
  let ancestor = file;
  while (true) {
    try {
      const actual = await realpath(ancestor);
      if (!contains(root, actual))
        throw new Error("The path resolves outside this repository.");
      if (privatePath(relative(root, actual)))
        throw new Error("The path resolves to private configuration.");
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || !write || ancestor === root) throw error;
      ancestor = dirname(ancestor);
    }
  }
  if (write) {
    const info = await lstat(file).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink > 1))
      throw new Error("Editing linked or non-regular files is unavailable.");
  }
  return file;
}

async function textFile(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new Error("Read a text file no larger than 1 MB.");
  const bytes = await readFile(file);
  if (bytes.includes(0)) throw new Error("This file is binary.");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function callOpenRouterFile(ctx, name, input) {
  // This consent is a user choice in the setup UI; agents cannot grant it.
  ctx.openrouter.check(ctx.model);
  const write = name === "edit_file";
  if (write && ["ask", "plan"].includes(ctx.mode))
    throw new Error(
      "File changes are unavailable in Ask or Plan mode. Approve the plan before implementation.",
    );
  const file = await openRouterFilePath(ctx.project, input, { write });
  ctx.signal.throwIfAborted();
  if (name === "read_file") {
    const text = await textFile(file),
      lines = text.split(/\r?\n/),
      start = (input.startLine ?? 1) - 1;
    return {
      path: input.path,
      totalLines: lines.length,
      text: lines
        .slice(start, start + (input.lineCount ?? 200))
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join("\n")
        .slice(0, 60000),
    };
  }
  if (write) {
    let before = null;
    try {
      before = await textFile(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (input.oldText === "" && before !== null)
      throw new Error("Empty oldText is only valid when creating a new file.");
    if (
      input.oldText !== "" &&
      (before === null ||
        !before.includes(input.oldText) ||
        before.indexOf(input.oldText) !== before.lastIndexOf(input.oldText))
    )
      throw new Error(
        "oldText must match exactly once. Read the current file and try again.",
      );
    const after =
      before === null
        ? input.newText
        : before.replace(input.oldText, () => input.newText);
    const answer = await ctx.approve({
      kind: "permission",
      title: `Edit ${input.path}`,
      details: {
        tool: name,
        path: file,
        oldText: input.oldText,
        newText: input.newText,
      },
    });
    if (!answer.allow)
      return {
        declined: true,
        reason: answer.reason ?? "The edit was declined. Do not retry it.",
      };
    ctx.signal.throwIfAborted();
    ctx.openrouter.check(ctx.model);
    await openRouterFilePath(ctx.project, input, { write: true });
    const current = await readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current !== before)
      throw new Error(
        "The file changed during review. Read it again before editing.",
      );
    await mkdir(dirname(file), { recursive: true });
    await openRouterFilePath(ctx.project, input, { write: true });
    ctx.signal.throwIfAborted();
    ctx.openrouter.check(ctx.model);
    await writeFile(file, after, {
      encoding: "utf8",
      ...(before === null ? { flag: "wx" } : {}),
    });
    return { path: input.path, changed: true };
  }
  const root = file,
    files = [];
  let visited = 0,
    truncated = false,
    bytesRead = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      ctx.signal.throwIfAborted();
      if (++visited > 10000 || files.length >= 1000) {
        truncated = true;
        return;
      }
      if (
        entry.isSymbolicLink() ||
        privatePath(entry.name) ||
        ["node_modules", "dist", ".local"].includes(entry.name)
      )
        continue;
      const target = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push(target);
      if (truncated) return;
    }
  }
  if ((await stat(root)).isDirectory()) await walk(root);
  else files.push(root);
  if (name === "list_files")
    return {
      files: files.map((f) => relative(root, f) || input.path),
      truncated,
    };
  const matches = [],
    needle = input.caseSensitive ? input.query : input.query.toLowerCase();
  for (const target of files) {
    let text;
    try {
      text = await textFile(target);
    } catch {
      continue;
    }
    bytesRead += Buffer.byteLength(text);
    if (bytesRead > 10 * 1024 * 1024) {
      truncated = true;
      break;
    }
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      if ((input.caseSensitive ? line : line.toLowerCase()).includes(needle))
        matches.push({
          file: relative(root, target) || input.path,
          line: i + 1,
          text: line.slice(0, 500),
        });
      if (matches.length >= 100) {
        truncated = true;
        break;
      }
    }
    if (matches.length >= 100) break;
  }
  return { matches, truncated };
}
