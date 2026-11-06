import { open, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

// A missing file is not an error. Walk to the nearest existing ancestor and
// require that ancestor, and every later component, to stay inside the worktree.
export async function inspectFile(root, inputPath) {
  if (
    typeof inputPath !== "string" ||
    !inputPath.trim() ||
    inputPath.includes("\0") ||
    isAbsolute(inputPath)
  )
    return { error: "Give a path inside this chat's worktree." };
  const parts = inputPath.split(/[\\/]/);
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    return { error: "Give a relative path with no . or .. segments." };
  let base;
  try {
    base = await realpath(root);
  } catch {
    return { error: "The worktree could not be resolved." };
  }
  let cursor = base;
  let index = 0;
  for (; index < parts.length; index++) {
    const next = join(cursor, parts[index]);
    try {
      await lstat(next);
    } catch (error) {
      if (error.code === "ENOENT") break;
      return { error: "That path could not be read." };
    }
    let real;
    try {
      real = await realpath(next);
    } catch {
      return { error: "That path could not be resolved." };
    }
    if (!inside(base, real))
      return { error: "That path escapes the worktree." };
    cursor = real;
  }
  if (index < parts.length)
    return { pending: true, parent: cursor, remaining: parts.slice(index) };
  let info;
  try {
    info = await lstat(cursor);
  } catch {
    return { error: "That path could not be read." };
  }
  if (info.isDirectory()) return { error: "That path is a directory." };
  if (!info.isFile()) return { error: "That path is not a file." };
  return { file: cursor, size: info.size, mtimeMs: info.mtimeMs };
}

export async function tailFile(file, bytes = 8192) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(bytes, info.size);
    const buffer = Buffer.alloc(length);
    if (length) await handle.read(buffer, 0, length, info.size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
