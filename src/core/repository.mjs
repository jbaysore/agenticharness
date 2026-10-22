import {
  realpath,
  readFile,
  stat,
  mkdtemp,
  writeFile,
  rm,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { resolve, relative, isAbsolute, sep, join } from "node:path";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
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
