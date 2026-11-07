import {
  mkdir,
  readFile,
  appendFile,
  realpath,
  symlink,
  lstat,
  unlink,
  rename,
  readdir,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { git } from "./repository.mjs";

// Every new chat gets its own Git worktree, so no chat edits, builds or commits
// on top of another's unfinished work. Between turns, a worktree whose work has
// all landed is removed and comes back at the same path on the next turn. Its commits reach the project's branch through land_changes.

export const landTool = {
  name: "land_changes",
  description:
    "Deliver this chat's committed work: Harness rebases this worktree's branch onto the project's branch, runs the project's check command, fast-forwards the project's branch and pushes it. Commit first. Returns the landed commit, or the conflicts or failing check to fix before calling it again.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const samePath = (a, b) =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
const count = async (cwd, range) =>
  Number((await git(cwd, ["rev-list", "--count", range])).trim());
const isAncestor = (cwd, older, newer) =>
  git(cwd, ["merge-base", "--is-ancestor", older, newer]).then(
    () => true,
    () => false,
  );
const reason = (error) =>
  String(error.stderr || error.message)
    .trim()
    .split("\n")
    .slice(0, 6)
    .join("\n");

// Dependencies are shared with the project folder through a junction rather
// than installed again for every chat.
async function linkDependencies(projectPath, path) {
  const modules = join(projectPath, "node_modules");
  if (!existsSync(modules) || existsSync(join(path, "node_modules"))) return;
  await symlink(modules, join(path, "node_modules"), "junction");
  // Git may not treat a junction as the folder `node_modules/` ignores.
  const common = resolve(
      path,
      (await git(path, ["rev-parse", "--git-common-dir"])).trim(),
    ),
    exclude = join(common, "info", "exclude");
  const current = await readFile(exclude, "utf8").catch(() => "");
  if (!/^\/?node_modules$/m.test(current)) {
    await mkdir(join(common, "info"), { recursive: true });
    await appendFile(
      exclude,
      (current && !current.endsWith("\n") ? "\n" : "") + "/node_modules\n",
    );
  }
}

export async function createWorktree({ projectPath, root, chatId }) {
  const top = (
    await git(projectPath, ["rev-parse", "--show-toplevel"]).catch(() => "")
  ).trim();
  if (!top) throw new Error("The project folder is not a Git repository.");
  if (!samePath(top, projectPath))
    throw new Error("The project folder is inside a larger Git repository.");
  const base = (await git(projectPath, ["branch", "--show-current"])).trim();
  if (!base)
    throw new Error("The project folder is not on a branch (detached HEAD).");
  const id = chatId.replace(/-/g, "").slice(0, 8),
    branch = `harness/${id}`,
    path = join(root, `${basename(projectPath)}-${id}`);
  await mkdir(root, { recursive: true });
  await git(projectPath, ["worktree", "add", "-b", branch, path, base], {
    timeout: 120000,
  });
  await linkDependencies(projectPath, path);
  return { path: await realpath(path), branch, base };
}

// Brings back a worktree whose folder was removed, on the chat's own branch,
// starting that branch again from the project's branch if it was deleted.
export async function restoreWorktree(projectPath, worktree) {
  const { path, branch, base } = worktree;
  let recoveryPath;
  if (existsSync(path)) {
    const top = (await git(path, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
    if (top && samePath(top, path)) {
      const actualBranch = (await git(path, ["branch", "--show-current"])).trim();
      const common = resolve(path, (await git(path, ["rev-parse", "--git-common-dir"])).trim());
      const expected = resolve(projectPath, (await git(projectPath, ["rev-parse", "--git-common-dir"])).trim());
      if (actualBranch !== branch || !samePath(common, expected))
        throw new Error(`The assigned checkout is on a different branch or belongs to another repository: ${path}`);
      return;
    }
    // A failed Git removal can leave ignored files and no .git file. Keep any
    // residual files, but restore an empty directory in place: a detached
    // service may still hold its working directory open on Windows.
    if ((await readdir(path)).length) {
      recoveryPath = `${path}.recovery-${Date.now()}-${process.pid}`;
      await rename(path, recoveryPath);
    }
  }
  await git(projectPath, ["worktree", "prune"]);
  const kept = await git(projectPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]).then(
    () => true,
    () => false,
  );
  await git(
    projectPath,
    [
      "worktree",
      "add",
      ...(kept ? [path, branch] : ["-b", branch, path, base]),
    ],
    { timeout: 120000 },
  );
  await linkDependencies(projectPath, path);
  return recoveryPath ? { recoveryPath } : undefined;
}

// Removes a worktree and its branch once nothing in them is missing from the
// project's branch: no uncommitted or untracked files and no unlanded commits.
// Anything else is left alone. Returns whether the folder is gone.
export async function tidyWorktree(projectPath, worktree) {
  const { path, branch, base } = worktree;
  if (!existsSync(path)) return true;
  try {
    if ((await git(path, ["branch", "--show-current"])).trim() !== branch)
      return false;
    if ((await git(path, ["status", "--porcelain"])).trim()) return false;
    if (await count(path, `${base}..HEAD`)) return false;
  } catch {
    return false;
  }
  // Acquire the directory before deleting anything. Git's recursive removal
  // can delete the checkout and only then discover that Windows will not
  // release its root because a detached process still uses it as its cwd.
  const removalPath = `${path}.cleanup-${Date.now()}-${process.pid}`;
  try {
    await rename(path, removalPath);
  } catch (error) {
    if (["EBUSY", "EPERM", "EACCES"].includes(error.code)) return false;
    throw error;
  }
  try {
    // The registered path is now absent. Git unregisters it without touching
    // the files we moved aside; an explicitly locked worktree still refuses.
    await git(projectPath, ["worktree", "remove", path], { timeout: 120000 });
  } catch {
    await rename(removalPath, path);
    return false;
  }
  try {
    // Never traverse the shared dependencies. A failed deletion may leave a
    // cleanup sibling, but cannot damage the chat's assigned checkout path.
    const modules = join(removalPath, "node_modules");
    const linked = await lstat(modules).then(
      (s) => s.isSymbolicLink(),
      () => false,
    );
    if (linked) await unlink(modules);
    await rm(removalPath, { recursive: true, force: true, maxRetries: 3 });
  } catch { /* Keep undeletable residual files in the cleanup sibling. */ }
  await git(projectPath, ["branch", "-d", branch]).catch(() => {});
  return true;
}

// Before a turn, a worktree with nothing of its own moves up to the project's
// branch so the chat starts from everything already landed.
export async function syncWorktree(worktree) {
  const { path, base } = worktree;
  const dirty = (
    await git(path, ["status", "--porcelain", "--untracked-files=no"])
  ).trim();
  const [ahead, behind] = await Promise.all([
    count(path, `${base}..HEAD`),
    count(path, `HEAD..${base}`),
  ]);
  if (!behind || ahead || dirty) return { ahead, behind, updated: false };
  await git(path, ["merge", "--ff-only", base]);
  return { ahead, behind, updated: true };
}

// One landing at a time per project folder.
const landings = new Map();
export function landWorktree(options) {
  const key = resolve(options.projectPath).toLowerCase(),
    result = (landings.get(key) ?? Promise.resolve()).then(() =>
      landNow(options),
    );
  landings.set(
    key,
    result.catch(() => {}),
  );
  return result;
}

async function landNow({ projectPath, worktree, check, run, signal }) {
  const { path, branch, base } = worktree;
  const refuse = (text, extra = {}) => ({
    landed: false,
    reason: text,
    ...extra,
  });
  if ((await git(path, ["branch", "--show-current"])).trim() !== branch)
    return refuse(
      `This worktree is not on ${branch}. Switch back to it, then call land_changes again.`,
    );
  const dirty = (
    await git(path, ["status", "--porcelain", "--untracked-files=no"])
  )
    .split("\n")
    .filter(Boolean);
  if (dirty.length)
    return refuse(
      "Commit or discard your uncommitted changes, then call land_changes again.",
      { uncommitted: dirty.slice(0, 40).map((l) => l.slice(3)) },
    );
  const home = (await git(projectPath, ["branch", "--show-current"])).trim();
  if (home !== base)
    return refuse(
      `The project folder is on ${home || "a detached HEAD"}, not ${base}, so nothing can land until the user switches it back.`,
    );
  for (let attempt = 0; attempt < 3; attempt++) {
    const ahead = await count(path, `${base}..HEAD`);
    if (!ahead)
      return refuse(
        `Nothing to land: ${branch} has no commits that are not already on ${base}.`,
      );
    if (await count(path, `HEAD..${base}`))
      try {
        await git(path, ["rebase", base], { timeout: 120000 });
      } catch (error) {
        const conflicts = (
          await git(path, ["diff", "--name-only", "--diff-filter=U"]).catch(
            () => "",
          )
        )
          .split("\n")
          .filter(Boolean);
        await git(path, ["rebase", "--abort"]).catch(() => {});
        return refuse(
          `Your commits conflict with work already on ${base}. Run \`git rebase ${base}\` in this worktree, resolve the conflicts, finish the rebase, and call land_changes again.`,
          { conflicts, detail: conflicts.length ? undefined : reason(error) },
        );
      }
    const head = (await git(path, ["rev-parse", "HEAD"])).trim();
    if (check) {
      const result = await run({ command: check, cwd: path, signal });
      if (result.exitCode !== 0)
        return refuse(
          `The project's check command ${result.timedOut ? "timed out" : `failed with exit code ${result.exitCode}`}. Fix it here, commit, and call land_changes again.`,
          { check, output: result.output.slice(-6000) },
        );
    }
    try {
      await git(projectPath, ["merge", "--ff-only", head], { timeout: 120000 });
    } catch (error) {
      // Another chat or the user committed to the branch meanwhile.
      if (!(await isAncestor(projectPath, base, head))) continue;
      return refuse(
        `The project folder could not move ${base} forward, usually because it has uncommitted changes in the same files. Try again after they are committed.`,
        { detail: reason(error) },
      );
    }
    const pushed = await push(projectPath, base);
    return {
      landed: true,
      branch: base,
      commit: head,
      commits: ahead,
      checked: check || null,
      ...pushed,
    };
  }
  return refuse(`${base} kept moving while landing. Call land_changes again.`);
}

async function push(projectPath, base) {
  const upstream = (
    await git(projectPath, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      `${base}@{upstream}`,
    ]).catch(() => "")
  ).trim();
  if (!upstream) return { pushed: false, pushNote: `${base} has no upstream.` };
  const remote = (
      await git(projectPath, ["config", `branch.${base}.remote`])
    ).trim(),
    target = upstream.slice(remote.length + 1);
  try {
    await git(projectPath, ["push", remote, `${base}:${target}`], {
      timeout: 120000,
    });
    return { pushed: true, pushedTo: upstream };
  } catch (error) {
    return {
      pushed: false,
      pushNote: `Landed locally, but pushing to ${upstream} failed: ${reason(error)}`,
    };
  }
}
