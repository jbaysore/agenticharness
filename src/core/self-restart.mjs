import {
  mkdir,
  readFile,
  readdir,
  realpath,
  mkdtemp,
  rm,
  open,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { backup } from "node:sqlite";
import { git } from "./repository.mjs";
import { subscriptionEnvironment } from "../security/environment.mjs";
import {
  atomicJson,
  readRestartState,
  writeRestartState,
  samePath,
  inside,
  validateRuntime,
} from "./restart-state.mjs";

const exec = promisify(execFile);
const pending = new Set(["queued", "preparing", "waiting"]);
export const restartTool = {
  name: "restart_harness",
  description:
    "Queue a safe Harness self restart. Only available when working on Harness itself in Default or Goal mode. Returns immediately; finish this turn normally and report that the restart is queued. Harness waits for all chats, unfinished or unconfirmed Goals, queued messages, approvals and terminals running a command (idle shells are closed), prepares and checks the committed version, and restores the previous runtime if startup fails. A continuing Goal can postpone the update indefinitely; never stop a Goal just to apply it. Repeated calls return the pending request. Never claim a queued restart has completed.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
export async function repositoryIdentity(path) {
  path = await realpath(path);
  const top = (await git(path, ["rev-parse", "--show-toplevel"])).trim();
  if (!samePath(path, await realpath(top)))
    throw new Error("Harness source must be a repository root");
  const gitDir = await realpath(
    resolve(path, (await git(path, ["rev-parse", "--git-common-dir"])).trim()),
  );
  const branch = (await git(path, ["branch", "--show-current"])).trim();
  if (!branch) throw new Error("Harness source is on a detached HEAD");
  return { path, gitDir, branch };
}
async function npmCli() {
  const local = join(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (existsSync(local)) return local;
  const { stdout } = await exec(
    process.platform === "win32" ? "where.exe" : "which",
    ["npm"],
    { windowsHide: true },
  );
  for (const path of stdout.trim().split(/\r?\n/)) {
    const candidate = join(
      dirname(path),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (existsSync(candidate)) return candidate;
    const target = await realpath(path).catch(() => "");
    if (target.endsWith("npm-cli.js")) return target;
  }
  throw new Error("Install Node's npm tools before preparing a self restart");
}
export async function prepareRuntime({ source, revision, dataDir, signal }) {
  const runtimes = join(dataDir, "self-runtimes");
  await mkdir(runtimes, { recursive: true });
  const root = await mkdtemp(join(runtimes, revision.slice(0, 12) + "-"));
  const archive = root + ".tar";
  const run = async (command, args) => {
    try {
      const environment = Object.fromEntries(
        Object.entries(subscriptionEnvironment()).filter(
          ([name]) => !/^HARNESS_/i.test(name),
        ),
      );
      await exec(command, args, {
        cwd: root,
        windowsHide: true,
        env: {
          ...environment,
          HARNESS_DATA_DIR: join(root, ".check-data"),
          HARNESS_PORT: "0",
        },
        signal,
        timeout: 10 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      const output = error.stderr || error.stdout || error.message;
      // A test run's useful part is its failure summary, not the passing tests.
      const failures = output.lastIndexOf("✖ failing tests:");
      throw new Error(
        (failures >= 0 ? output.slice(failures) : output).slice(-6000),
      );
    }
  };
  try {
    await git(
      source.path,
      ["archive", "--format=tar", "--output=" + archive, revision],
      { timeout: 120000 },
    );
    // Git Bash's GNU tar reads "C:\..." as a remote host; use Windows' bsdtar.
    const windowsTar = join(process.env.SystemRoot ?? "", "System32", "tar.exe");
    await run(
      process.platform === "win32" && existsSync(windowsTar)
        ? windowsTar
        : "tar",
      ["-xf", archive, "-C", root],
    );
    const npm = await npmCli();
    await run(process.execPath, [
      npm,
      "ci",
      "--include=dev",
      "--no-audit",
      "--no-fund",
    ]);
    await run(process.execPath, [npm, "run", "build"]);
    await run(process.execPath, [npm, "test"]);
    await atomicJson(join(root, "HARNESS-RUNTIME.json"), {
      revision,
      source,
      checked: true,
    });
    return { root, revision };
  } catch (error) {
    // Only remove the newly allocated directory inside our runtime cache.
    if (inside(runtimes, root))
      await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(archive, { force: true });
  }
}

export class SelfRestart {
  constructor({
    root,
    dataDir,
    store,
    controller,
    terminals,
    runtime,
    jobs = () => 0,
    shutdown,
    prepare = prepareRuntime,
    handoff = startRestartHelper,
    idleMs = 5000,
  }) {
    Object.assign(this, {
      root,
      dataDir,
      store,
      controller,
      terminals,
      runtime,
      jobs,
      shutdown,
      prepare,
      handoff,
      idleMs,
    });
    this.writes = Promise.resolve();
    this.abort = new AbortController();
    this.activationRequest = process.env.HARNESS_RESTART_REQUEST;
    this.gated = !!this.activationRequest;
  }
  async init() {
    const saved = await readRestartState(this.dataDir);
    const manifest = await readFile(
      join(this.root, "HARNESS-RUNTIME.json"),
      "utf8",
    )
      .then(JSON.parse)
      .catch(() => null);
    this.source = await repositoryIdentity(manifest?.source.path ?? this.root);
    if (manifest) {
      await validateRuntime(this.dataDir, {
        root: this.root,
        revision: manifest.revision,
      });
      if (!samePath(this.source.gitDir, manifest.source.gitDir))
        throw new Error("Harness source identity changed");
      this.source.branch = manifest.source.branch;
      this.fallback = { root: this.root, revision: manifest.revision };
    }
    this.revision =
      manifest?.revision ??
      (await git(this.source.path, ["rev-parse", "HEAD"])).trim();
    if (
      !manifest &&
      (await git(this.source.path, ["status", "--porcelain"])).trim()
    )
      throw new Error(
        "Start Harness from a clean checkout to enable self delivery",
      );
    if (saved && !samePath(saved.source.path, this.source.path))
      throw new Error("A different Harness source owns self delivery");
    this.state = saved ?? {
      version: 1,
      source: this.source,
      active: { root: this.root, revision: this.revision },
      request: null,
    };
    if (this.gated) {
      if (
        this.state.request?.id !== process.env.HARNESS_RESTART_REQUEST ||
        this.state.request.target !== this.revision
      )
        throw new Error("Restart candidate does not match its saved request");
    } else if (this.state.handoff) {
      // An unfinished handoff is recovered by the launcher/helper, never by
      // silently opening a candidate against possibly migrated live data.
      throw new Error("An unfinished self restart needs launcher recovery");
    } else {
      this.state.active = { root: this.root, revision: this.revision };
      await this.save();
      await this.prune();
    }
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    return this;
  }
  save() {
    const value = structuredClone(this.state);
    this.writes = this.writes
      .catch(() => {})
      .then(() => writeRestartState(this.dataDir, value));
    return this.writes;
  }
  status() {
    const request = this.state?.request;
    return request
      ? {
          id: request.id,
          target: request.target,
          status: request.status,
          blockers: request.blockers ?? [],
          error: request.error ?? null,
          idleTerminals: this.terminals.idle().length,
        }
      : null;
  }
  publish() {
    if (!this.stopped)
      this.controller.event(null, null, "self-restart", this.status());
  }
  assertAdmission() {
    if (this.gated)
      throw new Error(
        "Harness is restarting. Your message can be retried with the same action ID.",
      );
  }
  async eligible(projectPath, mode) {
    if (!["default", "goal"].includes(mode)) return false;
    try {
      const identity = await repositoryIdentity(projectPath);
      return (
        samePath(identity.path, this.source.path) &&
        samePath(identity.gitDir, this.source.gitDir) &&
        identity.branch === this.source.branch
      );
    } catch {
      return false;
    }
  }
  // A failed update is never retried automatically; the user can ask again.
  async retry() {
    if (this.state.request?.status !== "failed") return this.status();
    const head = (await git(this.source.path, ["rev-parse", "HEAD"])).trim();
    if (head === this.revision) {
      this.state.request = null;
      await this.save();
      this.publish();
      return null;
    }
    return this.request(this.source.path, "default");
  }
  // Runtimes and database snapshots from finished handoffs are not reused.
  // Only call this while no preparation is running, so the listing cannot
  // include a runtime that is still being built.
  async prune() {
    const keep = [
      this.root,
      this.state.active?.root,
      this.state.previous?.root,
      this.state.handoff?.candidate?.root,
    ].filter(Boolean);
    const runtimes = join(this.dataDir, "self-runtimes");
    const stale = (await readdir(runtimes).catch(() => []))
      .map((name) => join(runtimes, name))
      .filter((path) => !keep.some((root) => samePath(root, path)));
    const snapshot = this.state.handoff?.snapshot;
    for (const name of await readdir(this.dataDir).catch(() => []))
      if (/^self-restart-[\w-]+\.sqlite$/.test(name)) {
        const path = join(this.dataDir, name);
        if (!snapshot || !samePath(snapshot, path)) stale.push(path);
      }
    // Removal can take a while and is retried at the next start if it fails.
    this.pruning = Promise.all(
      stale.map((path) =>
        rm(path, { recursive: true, force: true, maxRetries: 3 }).catch(
          (error) => console.error("Self restart cleanup: " + error.message),
        ),
      ),
    );
  }
  async request(projectPath, mode, { automatic = false, commit } = {}) {
    if (this.stopped || !(await this.eligible(projectPath, mode)))
      throw new Error(
        "Self restart is only available for Harness's own source in Default or Goal mode",
      );
    this.assertAdmission();
    const target = (await git(this.source.path, ["rev-parse", "HEAD"])).trim();
    if (commit && commit !== target)
      throw new Error(
        "Harness source moved after delivery; wait for the newest delivery",
      );
    if (
      automatic &&
      (target === this.revision ||
        (this.state.request?.target === target &&
          this.state.request.status === "failed"))
    )
      return this.status();
    const current = this.state.request;
    if (current && pending.has(current.status)) {
      if (current.target !== target) {
        current.target = target;
        this.prepared = null;
        this.idleSince = null;
      }
    } else {
      this.state.request = {
        id: randomUUID(),
        target,
        status: "queued",
        requestedAt: new Date().toISOString(),
        blockers: [],
      };
      this.prepared = null;
      this.idleSince = null;
    }
    await this.save();
    this.publish();
    return { ...this.status(), queued: true };
  }
  blockers() {
    const reasons = [];
    if (this.controller.active.size || this.store.activeRuns().length)
      reasons.push("Active chats");
    if (this.store.restartBlockingGoals().length)
      reasons.push("Unfinished or unconfirmed Goal sessions");
    // Delivered steers remain as deduplication receipts, not waiting work.
    if (
      this.store.db
        .prepare("SELECT 1 FROM queued_inputs WHERE status='queued' LIMIT 1")
        .get()
    )
      reasons.push("Queued messages");
    if (
      this.controller.approvalWaiters.size ||
      this.store.db
        .prepare("SELECT 1 FROM approvals WHERE status='pending' LIMIT 1")
        .get()
    )
      reasons.push("Pending approvals");
    // A shell sitting at its prompt does not hold the update; it is closed.
    if (this.terminals.busy().length)
      reasons.push("Terminals running a command");
    if (
      this.controller.refreshing ||
      this.controller.tidying.size ||
      this.jobs()
    )
      reasons.push("Host work finishing");
    return reasons;
  }
  async sourceReady(target) {
    let identity;
    try {
      identity = await repositoryIdentity(this.source.path);
    } catch {
      return "Harness source is unavailable or not on its delivery branch";
    }
    if (
      !samePath(identity.gitDir, this.source.gitDir) ||
      identity.branch !== this.source.branch
    )
      return "Harness source changed repository or branch";
    if ((await git(this.source.path, ["status", "--porcelain"])).trim())
      return "Uncommitted Harness source changes";
    if ((await git(this.source.path, ["rev-parse", "HEAD"])).trim() !== target)
      return "Harness source moved after the selected delivery";
    return null;
  }
  tick() {
    if (
      this.stopped ||
      this.gated ||
      this.ticking ||
      !pending.has(this.state?.request?.status)
    )
      return this.ticking;
    this.ticking = this.advance()
      .catch(async (error) => {
        if (this.stopped) return;
        this.gated = false;
        this.state.request.status = "failed";
        this.state.request.error = error.message;
        delete this.state.handoff;
        await this.save();
        this.publish();
      })
      .finally(() => {
        this.ticking = null;
      });
    // Do not turn a disk failure into an unhandled interval rejection.
    this.ticking.catch((error) =>
      console.error("Self restart: " + error.message),
    );
    return this.ticking;
  }
  async advance() {
    const request = this.state.request,
      target = request.target;
    const wait = async (blockers) => {
      this.idleSince = null;
      if (
        request.status !== "waiting" ||
        JSON.stringify(request.blockers) !== JSON.stringify(blockers)
      ) {
        request.status = "waiting";
        request.blockers = blockers;
        await this.save();
        this.publish();
      }
    };
    const sourceBlock = await this.sourceReady(target);
    if (sourceBlock) return wait([sourceBlock]);
    // Reading the process table takes a moment, so it is not done every tick.
    await this.terminals.checkRunning({ maxAge: 5000 });
    if (!this.prepared) {
      request.status = "preparing";
      // Preparation waits for nothing. Blockers read now would go stale over
      // the minutes it takes, and always include the chat that delivered it.
      request.blockers = [];
      await this.save();
      this.publish();
      // The fallback comes from the revision recorded when this process started,
      // even though its source checkout has since received newer commits.
      this.fallback ??= await this.prepare({
        source: this.source,
        revision: this.revision,
        dataDir: this.dataDir,
        signal: this.abort.signal,
      });
      const prepared =
        target === this.revision
          ? this.fallback
          : await this.prepare({
              source: this.source,
              revision: target,
              dataDir: this.dataDir,
              signal: this.abort.signal,
            });
      if (request.target !== target || this.stopped) return;
      this.prepared = prepared;
    }
    const blockers = this.blockers();
    if (blockers.length) return wait(blockers);
    this.idleSince ??= Date.now();
    if (Date.now() - this.idleSince < this.idleMs)
      return waitForIdle.call(this);
    const changed = await this.sourceReady(target);
    if (request.target !== target || changed)
      return wait([changed ?? "A newer delivery is being prepared"]);
    // Synchronous gate + second check closes the admission race with a new turn.
    this.gated = true;
    if (this.blockers().length) {
      this.gated = false;
      return wait(this.blockers());
    }
    const snapshot = join(
      this.dataDir,
      "self-restart-" + request.id + ".sqlite",
    );
    await backup(this.store.db, snapshot);
    const helper = await this.handoff({
      dataDir: this.dataDir,
      // Use the checked helper belonging to this running version. The source
      // checkout already contains the candidate's newer helper implementation.
      root: this.fallback.root,
      runtime: this.runtime,
      candidate: this.prepared,
      fallback: this.fallback,
      snapshot,
      requestId: request.id,
      environment: this.environment ?? {},
    });
    const finalSourceBlock = await this.sourceReady(target);
    const finalBlockers = this.blockers();
    if (finalSourceBlock || finalBlockers.length || this.stopped) {
      helper.cancel?.();
      this.gated = false;
      if (!this.stopped)
        return wait(finalSourceBlock ? [finalSourceBlock] : finalBlockers);
      return;
    }
    this.state.previous = this.fallback;
    this.state.handoff = {
      pid: helper.pid,
      deadline: Date.now() + 120000,
      requestId: request.id,
      oldPid: this.runtime.pid,
      snapshot,
      candidate: this.prepared,
      environment: this.environment ?? {},
    };
    request.status = "restarting";
    request.blockers = [];
    await this.save();
    this.publish();
    this.handedOff = true;
    try {
      await helper.go();
    } catch (error) {
      this.handedOff = false;
      helper.cancel?.();
      throw error;
    }
    if (this.stopped) {
      helper.cancel?.();
      return;
    }
    await this.shutdown();
    function waitForIdle() {
      if (request.status !== "waiting" || request.blockers.length) {
        request.status = "waiting";
        request.blockers = [];
        return this.save().then(() => this.publish());
      }
    }
  }
  async activate(requestId) {
    if (
      !this.gated ||
      requestId !== this.activationRequest ||
      this.state.request?.id !== requestId
    )
      throw new Error("Invalid restart activation");
    this.state.active = { root: this.root, revision: this.revision };
    this.state.request.status = "updated";
    delete this.state.handoff;
    await this.save();
    this.gated = false;
    delete process.env.HARNESS_RESTART_REQUEST;
    this.publish();
    await this.prune();
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
    if (!this.handedOff) await this.ticking;
    await this.writes;
  }
}

export async function startRestartHelper(spec) {
  const log = await open(join(spec.dataDir, "self-restart.log"), "a");
  const child = fork(join(spec.root, "scripts", "restart-host.mjs"), [], {
    detached: true,
    windowsHide: true,
    env: subscriptionEnvironment(),
    stdio: ["ignore", log.fd, log.fd, "ipc"],
  });
  await log.close();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Restart helper did not become ready")),
        10000,
      );
      child.once("error", fail);
      child.once("exit", () =>
        fail(new Error("Restart helper exited before handoff")),
      );
      child.on("message", (message) => {
        if (message.ready) {
          clearTimeout(timer);
          resolve();
        } else if (message.error) fail(new Error(message.error));
      });
      function fail(error) {
        clearTimeout(timer);
        reject(error);
      }
      child.send(spec);
    });
    return {
      pid: child.pid,
      cancel() {
        child.kill();
      },
      go() {
        return new Promise((resolve, reject) =>
          child.send({ go: true }, (error) => {
            if (child.connected) child.disconnect();
            child.unref();
            error ? reject(error) : resolve();
          }),
        );
      },
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}
