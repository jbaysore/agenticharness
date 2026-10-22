import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { workspacePeers as uiPeers } from "../src/ui/status.mjs";
import {
  createWorktree,
  landWorktree,
  syncWorktree,
} from "../src/core/worktrees.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
const commit = (cwd, file, text, message = "Change " + file) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
};

// A project folder on main with a pushed upstream and a node_modules folder.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "harness-worktree-")),
    remote = join(dir, "remote.git"),
    project = join(dir, "project");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(dir, "init", "-q", "-b", "main", project);
  git(project, "config", "user.email", "test@example.com");
  git(project, "config", "user.name", "Test");
  git(project, "config", "core.autocrlf", "false");
  writeFileSync(join(project, ".gitignore"), "node_modules/\n");
  commit(project, "a.txt", "one\n", "Start");
  git(project, "add", ".gitignore");
  git(project, "commit", "-q", "-m", "Ignore dependencies");
  git(project, "remote", "add", "origin", remote);
  git(project, "push", "-q", "-u", "origin", "main");
  mkdirSync(join(project, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(project, "node_modules", "dep", "index.js"), "1");
  return {
    dir,
    remote,
    project,
    root: join(dir, "worktrees"),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const passing = async () => ({ exitCode: 0, output: "ok" });

test("a worktree starts from the project's branch and shares its dependencies", async () => {
  const f = fixture();
  try {
    const worktree = await createWorktree({
      projectPath: f.project,
      root: f.root,
      chatId: "1234abcd-0000-0000-0000-000000000000",
    });
    assert.equal(worktree.branch, "harness/1234abcd");
    assert.equal(worktree.base, "main");
    assert.equal(
      git(worktree.path, "branch", "--show-current"),
      worktree.branch,
    );
    assert.equal(
      await readFile(
        join(worktree.path, "node_modules", "dep", "index.js"),
        "utf8",
      ),
      "1",
    );
    assert.equal(git(worktree.path, "status", "--porcelain"), "");
    await assert.rejects(
      createWorktree({
        projectPath: join(f.project, "node_modules"),
        root: f.root,
        chatId: "ffffffff",
      }),
      /inside a larger Git repository/,
    );
  } finally {
    f.done();
  }
});

test("landing rebases onto work landed meanwhile, checks, moves main and pushes", async () => {
  const f = fixture();
  try {
    const worktree = await createWorktree({
      projectPath: f.project,
      root: f.root,
      chatId: "aaaaaaaa",
    });
    commit(worktree.path, "b.txt", "mine\n");
    // Another chat lands a commit to a different file first.
    commit(f.project, "c.txt", "theirs\n");
    const checked = [];
    const result = await landWorktree({
      projectPath: f.project,
      worktree,
      check: "npm test",
      run: async (options) => {
        checked.push(options);
        return passing();
      },
    });
    assert.equal(result.landed, true, result.reason);
    assert.equal(result.commits, 1);
    assert.equal(result.pushed, true);
    assert.equal(checked[0].command, "npm test");
    assert.equal(checked[0].cwd, worktree.path);
    assert.equal(git(f.project, "rev-parse", "HEAD"), result.commit);
    assert.equal(git(f.remote, "rev-parse", "main"), result.commit);
    assert.ok(existsSync(join(f.project, "b.txt")));
    assert.ok(existsSync(join(worktree.path, "c.txt")));
    const again = await landWorktree({
      projectPath: f.project,
      worktree,
      run: passing,
    });
    assert.equal(again.landed, false);
    assert.match(again.reason, /Nothing to land/);
  } finally {
    f.done();
  }
});

test("landing refuses conflicts, failing checks and uncommitted work, leaving main alone", async () => {
  const f = fixture();
  try {
    const worktree = await createWorktree({
      projectPath: f.project,
      root: f.root,
      chatId: "bbbbbbbb",
    });
    const before = git(f.project, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "a.txt"), "unsaved\n");
    const dirty = await landWorktree({
      projectPath: f.project,
      worktree,
      run: passing,
    });
    assert.equal(dirty.landed, false);
    assert.deepEqual(dirty.uncommitted, ["a.txt"]);
    commit(worktree.path, "a.txt", "mine\n");

    const failing = await landWorktree({
      projectPath: f.project,
      worktree,
      check: "npm test",
      run: async () => ({ exitCode: 1, output: "1 test failed" }),
    });
    assert.equal(failing.landed, false);
    assert.match(failing.reason, /exit code 1/);
    assert.equal(failing.output, "1 test failed");
    assert.equal(git(f.project, "rev-parse", "HEAD"), before);

    commit(f.project, "a.txt", "theirs\n");
    const conflict = await landWorktree({
      projectPath: f.project,
      worktree,
      run: passing,
    });
    assert.equal(conflict.landed, false);
    assert.deepEqual(conflict.conflicts, ["a.txt"]);
    assert.match(conflict.reason, /git rebase main/);
    // The rebase was undone, so the chat finds its branch as it left it.
    assert.equal(
      git(worktree.path, "branch", "--show-current"),
      worktree.branch,
    );
    assert.equal(git(worktree.path, "status", "--porcelain"), "");
  } finally {
    f.done();
  }
});

test("a worktree with nothing of its own catches up before a turn", async () => {
  const f = fixture();
  try {
    const worktree = await createWorktree({
      projectPath: f.project,
      root: f.root,
      chatId: "cccccccc",
    });
    commit(f.project, "c.txt", "landed elsewhere\n");
    assert.deepEqual(await syncWorktree(worktree), {
      ahead: 0,
      behind: 1,
      updated: true,
    });
    assert.ok(existsSync(join(worktree.path, "c.txt")));
    commit(worktree.path, "d.txt", "mine\n");
    commit(f.project, "e.txt", "more\n");
    assert.equal((await syncWorktree(worktree)).updated, false);
  } finally {
    f.done();
  }
});

test("every new chat gets its own worktree and land_changes", async () => {
  const f = fixture(),
    store = new Store(":memory:"),
    controller = new Controller(store, { worktreeRoot: f.root });
  try {
    controller.providers = [
      { id: "codex", models: [{ id: "m", efforts: [] }] },
    ];
    const seen = {},
      finish = {};
    controller.runners.codex = async (ctx) => {
      seen[ctx.chat.id] = ctx;
      await new Promise((resolve) => (finish[ctx.chat.id] = resolve));
      return { status: "completed" };
    };
    const project = store.addProject("fixture", f.project);
    const chat = (title) =>
      store.createConversation({ projectId: project.id, title });
    let sent = 0;
    const start = async (target, text) => {
      controller.send(target.id, {
        actionId: "worktree-action-" + ++sent,
        text,
        provider: "codex",
        model: "m",
      });
      while (!seen[target.id]) await new Promise((r) => setTimeout(r, 5));
      const ctx = seen[target.id];
      delete seen[target.id];
      return ctx;
    };
    const first = chat("First"),
      second = chat("Second"),
      // A chat that began in the project folder before worktrees stays there.
      older = chat("Older");
    store.updateConversation(older.id, { sessions: { codex: "native-1" } });
    const alone = await start(first, "Refactor"),
      beside = await start(second, "Add a test"),
      shared = await start(older, "Tidy up");

    const own = store.conversation(first.id).worktree,
      worktree = store.conversation(second.id).worktree;
    assert.equal(alone.project.path, own.path);
    assert.notEqual(own.path, worktree.path);
    assert.ok(alone.tools.some((t) => t.name === "land_changes"));
    assert.equal(beside.project.path, worktree.path);
    assert.equal(beside.project.home, f.project);
    assert.ok(beside.tools.some((t) => t.name === "land_changes"));
    assert.match(beside.instructions, /Own worktree/);
    assert.match(beside.instructions, /call land_changes/);
    assert.doesNotMatch(beside.instructions, /never with git add -A/);
    // Neither chat is told the other shares its folder.
    assert.equal(beside.handoff, "");
    assert.equal(
      (await beside.history("workspace_activity", {}))[0].title,
      "First",
    );
    assert.equal(shared.project.path, f.project);
    assert.equal(store.conversation(older.id).worktree, null);

    commit(worktree.path, "b.txt", "mine\n");
    const landed = await beside.history("land_changes", {});
    assert.equal(landed.landed, true, landed.reason);
    assert.equal(git(f.project, "rev-parse", "HEAD"), landed.commit);
    assert.equal(
      (await shared.history("land_changes", {})).error,
      "This chat works in the shared project folder.",
    );

    finish[first.id]();
    finish[second.id]();
    finish[older.id]();
    while (controller.active.size) await new Promise((r) => setTimeout(r, 5));
    // The chat keeps its worktree on later turns.
    const later = await start(second, "And another");
    assert.equal(later.project.path, worktree.path);
    finish[second.id]();
    while (controller.active.size) await new Promise((r) => setTimeout(r, 5));
  } finally {
    store.close();
    f.done();
  }
});

test("the shared-folder banner leaves out chats working in their own worktree", () => {
  const busy = (id, worktree = null) => ({
    id,
    project_id: "p",
    status: "running",
    worktree,
  });
  const chats = [
    busy("shared"),
    busy("other-shared"),
    busy("own", { path: "C:\wt", branch: "harness/own", base: "main" }),
  ];
  assert.deepEqual(
    uiPeers(chats, "p", "shared").map((c) => c.id),
    ["other-shared"],
  );
  assert.deepEqual(uiPeers(chats, "p", "own"), []);
});
