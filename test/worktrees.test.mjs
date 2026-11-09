import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
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
  restoreWorktree,
  syncWorktree,
  tidyWorktree,
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

async function holdDirectory(path) {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    cwd: path, stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
  });
  await once(child, "spawn");
  return async () => {
    const exited = once(child, "exit");
    child.stdin.end();
    await exited;
  };
}

test("Windows cleanup leaves a checkout intact while a process holds its directory", {
  skip: process.platform !== "win32",
}, async () => {
  const f = fixture();
  let release;
  try {
    const worktree = await createWorktree({ projectPath: f.project, root: f.root, chatId: "busy-checkout" });
    release = await holdDirectory(worktree.path);
    assert.equal(await tidyWorktree(f.project, worktree), false);
    assert.equal(git(worktree.path, "branch", "--show-current"), worktree.branch);
    assert.equal(readFileSync(join(worktree.path, "a.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(worktree.path, "node_modules", "dep", "index.js"), "utf8"), "1");
    assert.deepEqual(readdirSync(f.root), [worktree.path.split(/[\\/]/).at(-1)]);
    await release(); release = null;
    assert.equal(await tidyWorktree(f.project, worktree), true);
    assert.deepEqual(readdirSync(f.root), []);
    assert.equal(readFileSync(join(f.project, "node_modules", "dep", "index.js"), "utf8"), "1");
  } finally { await release?.(); f.done(); }
});

test("cleanup rolls back intact when Git refuses an explicitly locked checkout", async () => {
  const f = fixture();
  try {
    const worktree = await createWorktree({ projectPath: f.project, root: f.root, chatId: "locked-checkout" });
    git(f.project, "worktree", "lock", worktree.path);
    assert.equal(await tidyWorktree(f.project, worktree), false);
    assert.equal(git(worktree.path, "branch", "--show-current"), worktree.branch);
    assert.equal(readFileSync(join(worktree.path, "a.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(worktree.path, "node_modules", "dep", "index.js"), "utf8"), "1");
    assert.equal(await restoreWorktree(f.project, worktree), undefined);
    git(f.project, "worktree", "unlock", worktree.path);
    assert.equal(await tidyWorktree(f.project, worktree), true);
    assert.deepEqual(readdirSync(f.root), []);
  } finally { f.done(); }
});

test("an empty partial checkout is restored while a process holds its directory", async () => {
  const f = fixture();
  let release;
  try {
    const worktree = await createWorktree({ projectPath: f.project, root: f.root, chatId: "empty-checkout" });
    commit(worktree.path, "saved.txt", "committed work", "Unlanded work");
    const head = git(worktree.path, "rev-parse", "HEAD");
    release = await holdDirectory(worktree.path);
    unlinkSync(join(worktree.path, "node_modules"));
    for (const file of readdirSync(worktree.path)) rmSync(join(worktree.path, file));
    assert.equal(await restoreWorktree(f.project, worktree), undefined);
    assert.equal(git(worktree.path, "branch", "--show-current"), worktree.branch);
    assert.equal(git(worktree.path, "rev-parse", "HEAD"), head);
    assert.equal(readFileSync(join(worktree.path, "a.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(worktree.path, "saved.txt"), "utf8"), "committed work");
    assert.equal(readFileSync(join(worktree.path, "node_modules", "dep", "index.js"), "utf8"), "1");
  } finally { await release?.(); f.done(); }
});

test("local command and file watches hold their checkout against idle cleanup", async () => {
  const f = fixture(), store = new Store(":memory:"), controller = new Controller(store, {});
  try {
    const project = store.addProject("Watched", f.project);
    const chat = store.createConversation({ projectId: project.id });
    const worktree = await createWorktree({ projectPath: f.project, root: f.root, chatId: chat.id });
    store.updateConversation(chat.id, { worktree });
    for (const kind of ["command", "file"]) {
      store.watchStore.save({ id: "local-watch", chatId: chat.id, kind, status: "pending" });
      assert.equal(controller.tidy(chat.id), undefined);
      assert.ok(existsSync(join(worktree.path, ".git")));
    }
    store.watchStore.save({ id: "local-watch", chatId: chat.id, kind: "file", status: "success" });
    await controller.tidy(chat.id);
    assert.equal(existsSync(worktree.path), false);
  } finally { await controller.close(); store.close(); f.done(); }
});

test("a partial worktree is restored on its saved branch with residual work preserved", async () => {
  const f = fixture();
  try {
    const worktree = await createWorktree({ projectPath: f.project, root: f.root, chatId: "partial-checkout" });
    commit(worktree.path, "saved.txt", "committed work", "Unlanded work");
    writeFileSync(join(worktree.path, "draft.txt"), "uncommitted draft");
    rmSync(join(worktree.path, ".git"));
    rmSync(join(worktree.path, "a.txt"));
    const recovered = await restoreWorktree(f.project, worktree);
    assert.ok(recovered.recoveryPath);
    assert.equal(readFileSync(join(recovered.recoveryPath, "draft.txt"), "utf8"), "uncommitted draft");
    assert.equal(git(worktree.path, "branch", "--show-current"), worktree.branch);
    assert.equal(readFileSync(join(worktree.path, "saved.txt"), "utf8"), "committed work");
    assert.equal(readFileSync(join(worktree.path, "a.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(f.project, "node_modules", "dep", "index.js"), "utf8"), "1");
    assert.equal(await restoreWorktree(f.project, worktree), undefined);
  } finally { f.done(); }
});

test("a Git failure other than a missing repository never moves the checkout aside", async () => {
  const f = fixture();
  try {
    const worktree = await createWorktree({ projectPath: f.project, root: f.root, chatId: "unreadable" });
    rmSync(join(worktree.path, ".git"), { force: true });
    writeFileSync(join(worktree.path, ".git"), "nonsense");
    await assert.rejects(restoreWorktree(f.project, worktree), /Git could not read the assigned checkout/);
    assert.equal(readFileSync(join(worktree.path, "a.txt"), "utf8"), "one\n");
    assert.deepEqual(readdirSync(f.root).filter((name) => name.includes(".recovery-")), []);
  } finally { f.done(); }
});

test("restoration refuses a valid checkout on the wrong branch", async () => {
  const f = fixture();
  try {
    const worktree = await createWorktree({ projectPath: f.project, root: f.root, chatId: "wrong-branch" });
    git(worktree.path, "switch", "-c", "other-branch");
    await assert.rejects(restoreWorktree(f.project, worktree), /different branch.*branch "other-branch", expected "harness\/wrongbra"/);
    assert.equal(git(worktree.path, "branch", "--show-current"), "other-branch");
  } finally { f.done(); }
});

test("an unfinished worktree prevents moving the chat and automatic continuation", async () => {
  const f = fixture(),
    store = new Store(":memory:"),
    controller = new Controller(store, { worktreeRoot: f.root });
  const destination = join(f.dir, "destination");
  mkdirSync(destination);
  const project = store.addProject("Source", f.project);
  const chat = store.createConversation({
    projectId: project.id, provider: "codex", model: "m",
  });
  const worktree = await createWorktree({
    projectPath: f.project, root: f.root, chatId: chat.id,
  });
  store.updateConversation(chat.id, { worktree });
  writeFileSync(join(worktree.path, "unfinished.txt"), "Work in progress");
  controller.providers = [{ id: "codex", models: [{ id: "m", efforts: [] }] }];
  const events = [];
  controller.on("event", (event) => events.push(event));
  let attempts = 0;
  controller.runners.codex = async (ctx) => {
    attempts++;
    await ctx.history("move_chat", { directory: destination });
    return { status: "completed" };
  };
  try {
    controller.send(chat.id, {
      actionId: crypto.randomUUID(), text: "Move this chat", provider: "codex", model: "m",
    });
    await controller.active.get(chat.id).task;
    assert.equal(attempts, 1);
    assert.equal(store.conversation(chat.id).project_id, project.id);
    assert.ok(events.some((e) => e.payload.kind === "chat-move-failed"));
    assert.equal(
      readFileSync(join(worktree.path, "unfinished.txt"), "utf8"), "Work in progress",
    );
    assert.equal(
      store.messages(chat.id).filter((m) => m.source === "chat-move").length, 0,
    );
  } finally {
    await controller.close();
    store.close();
    f.done();
  }
});

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

test("a fully landed worktree is removed and comes back at the same path", async () => {
  const f = fixture();
  try {
    const worktree = await createWorktree({
      projectPath: f.project,
      root: f.root,
      chatId: "1234abcd-0000-0000-0000-000000000000",
    });
    const branches = () => git(f.project, "branch", "--list", "harness/*");
    // Uncommitted, untracked or unlanded work keeps the folder.
    writeFileSync(join(worktree.path, "a.txt"), "unsaved\n");
    assert.equal(await tidyWorktree(f.project, worktree), false);
    git(worktree.path, "checkout", "-q", "a.txt");
    writeFileSync(join(worktree.path, "new.txt"), "draft\n");
    assert.equal(await tidyWorktree(f.project, worktree), false);
    commit(worktree.path, "new.txt", "draft\n");
    assert.equal(await tidyWorktree(f.project, worktree), false);
    assert.ok(existsSync(worktree.path));

    const landed = await landWorktree({
      projectPath: f.project,
      worktree,
      check: "",
      run: passing,
    });
    assert.equal(landed.landed, true, landed.reason);
    assert.equal(await tidyWorktree(f.project, worktree), true);
    assert.ok(!existsSync(worktree.path));
    assert.equal(branches(), "");
    // The shared dependencies survive the removal.
    assert.ok(existsSync(join(f.project, "node_modules", "dep", "index.js")));

    await restoreWorktree(f.project, worktree);
    assert.equal(
      git(worktree.path, "branch", "--show-current"),
      worktree.branch,
    );
    assert.ok(existsSync(join(worktree.path, "new.txt")));
    assert.ok(existsSync(join(worktree.path, "node_modules", "dep")));
    assert.equal(git(worktree.path, "status", "--porcelain"), "");
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
    await Promise.all(controller.tidying.values());
    // Once idle with everything landed, only the project folder is left.
    assert.ok(!existsSync(own.path));
    assert.ok(!existsSync(worktree.path));
    assert.ok(existsSync(f.project));
    // The chat keeps its worktree path on later turns.
    const later = await start(second, "And another");
    assert.equal(later.project.path, worktree.path);
    assert.ok(existsSync(join(worktree.path, "b.txt")));
    finish[second.id]();
    while (controller.active.size) await new Promise((r) => setTimeout(r, 5));
    await Promise.all(controller.tidying.values());
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

test("plan review restores an idle worktree and holds it through concurrent reviews", async (t) => {
  for (const removing of [false, true]) await t.test(removing ? "cleanup in progress" : "already removed", async () => {
    const f = fixture(),
      store = new Store(":memory:"),
      controller = new Controller(store, { worktreeRoot: f.root });
    let finishCleanup, finishReviews;
    try {
      commit(f.project, "AGENTS.md", "Instructions from the chat's branch\n");
      const project = store.addProject("fixture", f.project),
        chat = store.createConversation({ projectId: project.id }),
        worktree = await createWorktree({ projectPath: f.project, root: f.root, chatId: chat.id });
      store.updateConversation(chat.id, { worktree });
      if (removing) {
        // Simulate removal already past tidy's busy check when review starts.
        const gate = new Promise((resolve) => { finishCleanup = resolve; });
        controller.tidying.set(chat.id, gate.then(() => tidyWorktree(f.project, worktree)));
      } else {
        await controller.tidy(chat.id);
        assert.equal(existsSync(worktree.path), false);
      }
      // Restoring the chat's branch must not review another chat's dirty files.
      writeFileSync(join(f.project, "AGENTS.md"), "Other chat's unfinished instructions\n");
      controller.providers = [{
        id: "codex", connected: true,
        models: [{ id: "m", name: "Fixture", isDefault: true, efforts: [] }],
      }];
      const reviewing = new Promise((resolve) => { finishReviews = resolve; }),
        calls = [], plans = [];
      controller.workers.codex = async (job) => {
        calls.push(job);
        assert.equal(job.cwd, worktree.path);
        assert.equal(job.project.home, f.project);
        assert.match(job.task, /Instructions from the chat's branch/);
        assert.doesNotMatch(job.task, /Other chat's unfinished instructions/);
        await reviewing;
        assert.equal(existsSync(job.cwd), true);
        return { text: JSON.stringify({ assessment: "sound", summary: "Ready.", concerns: [], improvements: [], questions: [] }) };
      };
      for (let n = 0; n < 2; n++) {
        const run = store.createRun({ conversationId: chat.id, actionId: "review-" + n, provider: "claude", model: "m", text: "Plan a change" });
        store.setRun(run.id, "completed");
        const approval = store.addApproval(chat.id, run.id, "claude", { kind: "plan", plan: "Change a.txt" });
        plans.push({ run, approval });
        controller.reviewPlan({ chatId: chat.id, runId: run.id, approvalId: approval.id });
      }
      assert.equal(controller.tidy(chat.id), undefined);
      if (removing) {
        assert.equal(calls.length, 0);
        finishCleanup();
      }
      const deadline = Date.now() + 10000;
      while (calls.length < 2) {
        assert.ok(Date.now() < deadline, "Reviews did not start in the restored worktree");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await controller.tidyAll();
      assert.equal(existsSync(worktree.path), true);
      finishReviews();
      await Promise.all(controller.planReviewTasks);
      await Promise.all(controller.tidying.values());
      for (const { run, approval } of plans) {
        assert.equal(store.planReview(chat.id, run.id).status, "done");
        assert.equal(store.approval(approval.id).status, "pending");
      }
      assert.equal(controller.planReviewFolders.size, 0);
      assert.equal(existsSync(worktree.path), false);
    } finally {
      finishCleanup?.();
      finishReviews?.();
      await controller.close();
      await Promise.all(controller.tidying.values());
      store.close();
      f.done();
    }
  });
});

test("an unavailable review folder fails before either provider launches", async () => {
  const f = fixture(), store = new Store(":memory:"), controller = new Controller(store, {});
  try {
    const project = store.addProject("fixture", f.project),
      chat = store.createConversation({ projectId: project.id }),
      run = store.createRun({ conversationId: chat.id, actionId: "bad-review-folder", provider: "codex", model: "m", text: "Plan a change" });
    store.updateConversation(chat.id, { worktree: { path: join(f.dir, "missing"), branch: "harness/missing", base: "missing-base" } });
    store.setRun(run.id, "completed");
    const approval = store.addApproval(chat.id, run.id, "codex", { kind: "plan", plan: "Change a.txt" });
    controller.workers = {
      codex: async () => assert.fail("Codex must not launch"),
      claude: async () => assert.fail("Claude must not launch"),
    };
    controller.reviewPlan({ chatId: chat.id, runId: run.id, approvalId: approval.id });
    await Promise.all(controller.planReviewTasks);
    const review = store.planReview(chat.id, run.id);
    assert.equal(review.status, "failed");
    assert.match(review.error, /plan review folder could not be prepared/);
    assert.doesNotMatch(review.error, /ENOENT|libc|binary/);
    assert.equal(store.approval(approval.id).status, "pending");
  } finally {
    await controller.close();
    await Promise.all(controller.tidying.values());
    store.close();
    f.done();
  }
});
