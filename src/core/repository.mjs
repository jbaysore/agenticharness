import {
  realpath,
  readFile,
  stat,
  mkdtemp,
  writeFile,
  rm,
  lstat,
  readlink,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { resolve, relative, isAbsolute, sep, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const exec = promisify(execFile);

// Read-only evidence, never a guarantee about ignored configuration or services.
// Incomplete/racing reads have no hash and cannot certify a workspace match.
export async function workspaceFingerprint(
  root,
  { maxBytes = 64 * 1024 * 1024, maxFiles = 12000 } = {},
) {
  const observedAt = new Date().toISOString();
  try {
    root = await realpath(root);
    const deadline = Date.now() + 10000;
    const header = async () =>
      Promise.all([
        git(root, ["rev-parse", "HEAD"], { timeout: 10000 }),
        git(root, ["ls-files", "--stage", "-z"], { timeout: 10000 }),
        git(root, ["ls-files", "-co", "--exclude-standard", "-z"], {
          timeout: 10000,
        }),
      ]);
    const before = await header();
    const files = [...new Set(before[2].split("\0").filter(Boolean))].sort();
    if (files.length > maxFiles)
      throw new Error("Workspace exceeds evidence file limit");
    const hash = createHash("sha256");
    hash.update(JSON.stringify([root, ...before.slice(0, 2)]));
    let bytes = 0;
    for (const file of files) {
      if (Date.now() > deadline)
        throw new Error("Workspace evidence read timed out");
      const target = resolve(root, file);
      const rel = relative(root, target);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep))
        throw new Error("Invalid evidence path");
      hash.update(JSON.stringify(file));
      const info = await lstat(target).catch((e) =>
        e.code === "ENOENT" ? null : Promise.reject(e),
      );
      if (!info) {
        hash.update("deleted");
        continue;
      }
      if (!info.isFile() && !info.isSymbolicLink())
        throw new Error("Directory or submodule evidence is unavailable");
      if ((bytes += info.size) > maxBytes)
        throw new Error("Workspace exceeds evidence byte limit");
      const parent = await realpath(dirname(target));
      const parentRel = relative(root, parent);
      if (
        isAbsolute(parentRel) ||
        parentRel === ".." ||
        parentRel.startsWith(".." + sep)
      )
        throw new Error("Evidence path leaves workspace");
      hash.update(JSON.stringify([info.mode, info.size]));
      if (info.isSymbolicLink()) hash.update(await readlink(target));
      else {
        let size = 0;
        for await (const chunk of createReadStream(target, {
          highWaterMark: 65536,
        })) {
          size += chunk.length;
          if (Date.now() > deadline || bytes - info.size + size > maxBytes)
            throw new Error("Workspace evidence read exceeded its limits");
          hash.update(chunk);
        }
        if (size !== info.size)
          throw new Error("Workspace changed during evidence read");
      }
      const after = await lstat(target);
      if (
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs
      )
        throw new Error("Workspace changed during evidence read");
    }
    if (JSON.stringify(before) !== JSON.stringify(await header()))
      throw new Error("Workspace changed during evidence read");
    return {
      root,
      hash: hash.digest("hex"),
      head: before[0].trim(),
      observedAt,
      state: "ready",
    };
  } catch (error) {
    return { root, state: "unavailable", observedAt, reason: error.message };
  }
}
export async function git(root, args, { timeout = 20000 } = {}) {
  const result = await exec("git", ["-C", root, "--no-pager", ...args], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout;
}
// Two folders share a workspace when they are the same or one holds the other.
export function pathsOverlap(a, b) {
  const holds = (outer, inner) => {
    const path = relative(outer, inner);
    return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
  };
  return holds(a, b) || holds(b, a);
}
export async function projectPath(path) {
  if (!isAbsolute(path)) throw new Error("Choose an absolute project path");
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isDirectory())
    throw new Error("Project path is not a directory");
  return resolved;
}
export async function safeFile(root, file) {
  if (
    typeof file !== "string" ||
    !file ||
    isAbsolute(file) ||
    file.includes("\0")
  )
    throw new Error("Invalid relative file path");
  const normalized = file.replaceAll("\\", "/");
  if (
    normalized.split("/").some((p) => [".git", ".codex", ".ssh"].includes(p)) ||
    /(^|\/)\.env($|\.(?!example$|sample$))/.test(normalized)
  )
    throw new Error("Private configuration is not available in the file panel");
  const base = await realpath(root),
    target = await realpath(resolve(base, file));
  const path = relative(base, target);
  if (path === ".." || path.startsWith(".." + sep) || isAbsolute(path))
    throw new Error("File is outside this repository");
  return target;
}
export async function readRepositoryFile(root, file) {
  const path = await safeFile(root, file),
    info = await stat(path);
  if (!info.isFile() || info.size > 2 * 1024 * 1024)
    throw new Error("Choose a text file smaller than 2 MB");
  const bytes = await readFile(path);
  if (bytes.includes(0))
    throw new Error("Binary file; use its native application to view it");
  return {
    file,
    content: bytes.toString("utf8"),
    modifiedAt: info.mtime.toISOString(),
  };
}
// A repository-relative path, whether the caller gave one or an absolute path
// inside the repository.
export function relativePath(root, file) {
  return typeof file === "string" && isAbsolute(file)
    ? relative(root, file)
    : file;
}
// What changed in one file since `before`, as a unified diff. Used to show a
// chat exactly what a worker's edit did, whatever else is uncommitted.
export async function changeDiff(root, file, before) {
  const directory = await mkdtemp(join(tmpdir(), "harness-diff-")),
    earlier = join(directory, "before");
  try {
    await writeFile(earlier, before);
    const diff = await exec(
      "git",
      [
        "--no-pager",
        "diff",
        "--no-index",
        "--no-color",
        "-U2",
        "--",
        earlier,
        await safeFile(root, file),
      ],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 20000 },
    ).then(
      () => "",
      // Exit code 1 is how git reports that the two files differ.
      (error) => {
        if (error.code === 1) return error.stdout;
        throw error;
      },
    );
    return diff
      .split("\n")
      .filter((line) => !/^(diff --git|index |--- |\+\+\+ )/.test(line))
      .join("\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function repositoryState(root) {
  const [status, branch, head, files] = await Promise.all([
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    git(root, ["branch", "--show-current"]),
    git(root, ["rev-parse", "HEAD"]).catch(() => ""),
    git(root, ["ls-files", "-co", "--exclude-standard", "-z"]),
  ]);
  const entries = status.split("\0"),
    changes = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const code = entry.slice(0, 2),
      file = entry.slice(3);
    const change = { status: code, file };
    if (/[RC]/.test(code)) change.oldFile = entries[++i];
    changes.push(change);
  }
  return {
    root,
    branch: branch.trim() || "Detached HEAD",
    head: head.trim(),
    changes,
    files: [...new Set(files.split("\0").filter(Boolean))].slice(0, 12000),
  };
}
export async function repositoryDiff(root, file) {
  if (
    typeof file !== "string" ||
    file.startsWith("-") ||
    file.includes("\0") ||
    isAbsolute(file) ||
    file.split(/[\\/]/).includes("..")
  )
    throw new Error("Invalid diff path");
  const [unstaged, staged] = await Promise.all([
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--", file]),
    git(root, [
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      file,
    ]),
  ]);
  let diff = [staged, unstaged].filter(Boolean).join("\n");
  if (!diff) {
    const untracked = await git(root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      file,
    ]);
    if (untracked.trim()) {
      const { content } = await readRepositoryFile(root, file);
      const lines = content.split("\n");
      diff =
        `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n` +
        lines.map((l) => "+" + l).join("\n");
    }
  }
  return {
    file,
    diff,
    revision: createHash("sha256").update(diff).digest("hex").slice(0, 16),
  };
}
