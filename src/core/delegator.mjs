// Carries out the delegation tools for one turn. Every call is settled by the
// host: it measures what it can for free, compares the cost of a worker with
// the cost of the chat's own model, and either hands the work to a worker or
// does the plain part itself (reading a file, running a command, an exact
// search). A chat is never failed by its worker.
import { glob, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { READ_PURPOSES, estimate, tokensOf } from "./delegation.mjs";
import { cost } from "./prices.mjs";
import {
  changeDiff,
  git,
  readRepositoryFile,
  relativePath,
  safeFile,
} from "./repository.mjs";
import { measuredRuns, recordRun, workerName } from "./rules.mjs";

const MAX_WORKER_RUNS = 12,
  MAX_PARALLEL = 3,
  MAX_FILES = 40,
  // About 90,000 tokens: under the size at which small-model prices step up.
  MAX_MATERIAL = 360_000,
  MAX_EXACT_MATCHES = 40,
  MAX_DIFF = 24_000;

const numbered = (text) =>
  text
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n");
const count = (n) => n.toLocaleString("en-US");
const READ_TASK = {
  read: "Return the parts of the material that answer the question, verbatim with their line numbers.",
  extract:
    "Extract what the question asks for as a compact list, with the file and line of each item.",
  triage:
    "Sort the items by how relevant they are to the question, most relevant first, with one line of reason and a file and line for each.",
  summarise:
    "Summarise the material for orientation in a few sentences, giving a file and line for each claim.",
};
const DRAFT_TASK = {
  commit:
    "Write a commit message for this diff: a subject line of at most 72 characters in the imperative, a blank line, then a short body saying what changed and why. Describe only what the diff shows. Reply with the message alone.",
  changelog:
    "Write a changelog entry for this diff: a few plain bullet points a user of the project would understand. Describe only what the diff shows. Reply with the entry alone.",
};

export class Delegator {
  constructor({ controller, run, project, plan, signal, approve = null }) {
    Object.assign(this, { controller, run, project, plan, signal, approve });
    this.workers = [...plan.workers];
    this.running = 0;
    this.started = 0;
    this.reasons = plan.skipped.map(
      (s) => `${this.name(s.worker)}: ${s.reason}`,
    );
  }
  name(worker) {
    return workerName(worker, this.controller.providers);
  }
  note(kind, item, extra = {}) {
    this.controller.event(this.run.conversation_id, this.run.id, "work", {
      kind,
      item,
      ...extra,
    });
  }
  decline(reason) {
    return { declined: true, reason, instruction: "Do this yourself." };
  }
  alone(error) {
    return {
      error,
      reasons: this.reasons,
      instruction: this.workers.length
        ? "Do this yourself."
        : "Do this yourself and do not use the delegate tools again this turn.",
    };
  }
  handle(name, args) {
    const action = {
      delegate_read: this.read,
      delegate_locate: this.locate,
      delegate_edit: this.edit,
      delegate_run: this.command,
      delegate_draft: this.draft,
    }[name];
    return action
      ? action.call(this, args ?? {})
      : this.alone("That tool is not available.");
  }

  // Tries each worker that is estimated to be cheaper than the chat's own
  // model for this job. Returns its answer, or why no worker answered:
  // "cheaper" (the chat's model costs less), "busy" or "failed".
  async viaWorker({ action, job, mode, task, editPath, check, undo }) {
    const { store } = this.controller,
      main = this.plan.mainPrice,
      candidates = [...this.workers];
    // With every worker dropped this turn, the reason is that none could run.
    let why = candidates.length ? "cheaper" : "failed";
    for (const [index, worker] of candidates.entries()) {
      const prices = { main, worker: worker.price },
        expected = estimate(job, prices, measuredRuns(store, worker, action));
      if (!expected.cheaper) continue;
      if (
        this.started >= MAX_WORKER_RUNS ||
        this.running >= MAX_PARALLEL ||
        !this.workers.includes(worker)
      ) {
        why = "busy";
        continue;
      }
      why = "failed";
      const name = this.name(worker),
        limit = new AbortController(),
        stop = () => limit.abort(),
        timer = setTimeout(stop, this.controller.workerTimeoutMs);
      this.signal.addEventListener("abort", stop, { once: true });
      this.started++;
      this.running++;
      this.note("delegated-task", {
        title: `Delegated to ${name}`,
        description: task.slice(0, 300),
      });
      try {
        if (this.signal.aborted) throw new Error("The turn was stopped");
        const result = await this.controller.workers[worker.provider]({
          cwd: this.project.path,
          model: worker.model,
          effort: worker.effort,
          task,
          mode,
          editPath,
          signal: limit.signal,
        });
        const extra = check ? await check(result) : {},
          usage = result.usage ?? { input: 0, output: 0 };
        recordRun(store, worker, action, {
          ...usage,
          content: job.content ?? 0,
        });
        const spent =
            cost(worker.price, usage.input, usage.output) +
            cost(main, tokensOf(result.text.length), 0),
          tokens = usage.input + usage.output;
        this.note(
          "delegated-task",
          {
            title: `${name} answered`,
            description: `${count(tokens)} tokens, about ${Math.round((100 * spent) / expected.self)}% of the estimated cost on this chat's model`,
            text: extra.diff ?? result.text,
          },
          { tokens, estimate: expected, spent },
        );
        return { text: result.text, name, extra };
      } catch (error) {
        if (this.signal.aborted) throw error;
        await undo?.();
        const reason = limit.signal.aborted
          ? `no answer within ${Math.round(this.controller.workerTimeoutMs / 60000)} minutes`
          : error.message;
        this.reasons.push(`${name}: ${reason}`);
        // A provider that is out of usage stays out for the rest of the turn.
        if (error.unavailable) {
          this.workers = this.workers.filter((w) => w !== worker);
          this.controller.refreshProviders().catch(() => {});
        }
        const next = candidates[index + 1];
        this.note("delegation-fallback", {
          title: `${name} could not run`,
          description:
            reason +
            (next
              ? ` Trying ${this.name(next)}.`
              : " The chat or the host does this instead."),
        });
      } finally {
        this.running--;
        clearTimeout(timer);
        this.signal.removeEventListener("abort", stop);
      }
    }
    return { why };
  }

  // Files named by path or glob, inside the project, as text.
  async collect(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 20)
      throw new Error("Give between 1 and 20 paths or globs.");
    const root = this.project.path,
      names = new Map();
    for (const entry of paths) {
      const path = relativePath(root, String(entry)).replaceAll("\\", "/");
      if (!/[*?[{]/.test(path)) names.set(path, true);
      else
        for await (const match of glob(path, { cwd: root })) {
          const name = match.replaceAll("\\", "/");
          if (/(^|\/)(node_modules|\.git)(\/|$)/.test(name)) continue;
          if (!names.has(name)) names.set(name, false);
          if (names.size > MAX_FILES) break;
        }
    }
    if (names.size > MAX_FILES)
      throw new Error(`More than ${MAX_FILES} files match; narrow the paths.`);
    const files = [];
    let size = 0;
    for (const [path, named] of names) {
      try {
        const { content } = await readRepositoryFile(root, path);
        files.push({ path, text: content });
        size += content.length;
      } catch (error) {
        // A glob can match folders and binaries; a file named outright must exist.
        if (named) throw new Error(`${path}: ${error.message}`);
      }
    }
    if (!files.length) throw new Error("No readable text file matches.");
    if (size > MAX_MATERIAL)
      throw new Error(
        `Those files hold about ${count(tokensOf(size))} tokens together. Narrow the paths.`,
      );
    return files;
  }

  async read(args) {
    const purpose = READ_PURPOSES.includes(args.purpose)
      ? args.purpose
      : "read";
    let files;
    try {
      files = await this.collect(args.paths);
    } catch (error) {
      return { error: error.message };
    }
    const material = files
        .map((f) => `=== ${f.path} ===\n${numbered(f.text)}`)
        .join("\n\n"),
      size = tokensOf(material.length),
      outcome = this.plan.actions[purpose]
        ? await this.viaWorker({
            action: purpose,
            job: { action: purpose, content: size },
            mode: "inline",
            task: `${READ_TASK[purpose]}\n\nQuestion: ${String(args.question ?? "").slice(0, 2000)}\n\n${material}`,
          })
        : { why: "cheaper" };
    if (outcome.text) return { answer: outcome.text, by: outcome.name };
    this.note("delegation-direct", {
      title: "Returned the file text itself",
      description: `${files.length} ${files.length === 1 ? "file" : "files"}, about ${count(size)} tokens. ${outcome.why === "cheaper" ? "A worker was not estimated to be cheaper." : "No worker could take it."}`,
    });
    return { files };
  }

  async locate(args) {
    const query = String(args.query ?? "")
      .trim()
      .slice(0, 500);
    if (!query) return { error: "Say what to find." };
    let exact = null;
    // A name can be found by an exact search, with no model at all.
    if (/^[\w.$#:<>()-]{3,80}$/.test(query))
      exact = await git(this.project.path, [
        "grep",
        "-n",
        "-I",
        "-F",
        "-e",
        query,
      ]).then(
        (out) => out.split("\n").filter(Boolean),
        (error) => (error.code === 1 ? [] : null),
      );
    if (exact?.length && exact.length <= MAX_EXACT_MATCHES) {
      this.note("delegation-direct", {
        title: "Found by exact search",
        description: `${exact.length} ${exact.length === 1 ? "line" : "lines"} contain ${query}. No model was used.`,
      });
      return {
        matches: exact.map((line) => line.slice(0, 240)),
        note: "Exact text matches only.",
      };
    }
    const outcome = await this.viaWorker({
      action: "locate",
      job: { action: "locate" },
      mode: "search",
      task:
        `Find where this lives in the repository and report paths with line numbers: ${query}` +
        (exact?.length
          ? `\nThe exact text appears on ${exact.length} lines, so say which of them matter.`
          : ""),
    });
    if (outcome.text) return { answer: outcome.text, by: outcome.name };
    return outcome.why === "cheaper"
      ? this.decline(
          "Searching on your own model is estimated to be cheaper than a worker.",
        )
      : this.alone("No worker could search.");
  }

  async edit(args) {
    const root = this.project.path,
      file = relativePath(root, String(args.path ?? "")).replaceAll("\\", "/"),
      instruction = String(args.instruction ?? "")
        .trim()
        .slice(0, 4000),
      lines = Math.min(2000, Math.max(1, Math.round(Number(args.lines)) || 1));
    if (!instruction) return { error: "State the change to make." };
    let before, target;
    try {
      before = (await readRepositoryFile(root, file)).content;
      target = await safeFile(root, file);
    } catch (error) {
      return { error: error.message };
    }
    const current = async () => (await readRepositoryFile(root, file)).content,
      outcome = await this.viaWorker({
        action: "edit",
        job: {
          action: "edit",
          content: tokensOf(before.length),
          lines,
          haveRead: args.have_read === true,
        },
        mode: "edit",
        editPath: resolve(root, file),
        task: `File: ${file}\nChange: ${instruction}`,
        check: async () => {
          if ((await current()) === before)
            throw new Error("it made no change to the file");
          const diff = await changeDiff(root, file, before);
          return {
            diff:
              diff.length > MAX_DIFF
                ? diff.slice(0, MAX_DIFF) +
                  "\n[The diff is longer than this. Read the file to review the rest.]"
                : diff,
          };
        },
        // A worker that fails part-way must not leave a half-made change behind.
        undo: async () => {
          if ((await current().catch(() => before)) !== before)
            await writeFile(target, before);
        },
      });
    if (outcome.text)
      return {
        diff: outcome.extra.diff,
        by: outcome.name,
        said: outcome.text.slice(0, 300),
      };
    return outcome.why === "cheaper"
      ? this.decline("Making this edit yourself is estimated to be cheaper.")
      : this.alone("No worker could make the edit. The file is unchanged.");
  }

  async command(args) {
    const command = String(args.command ?? "").trim();
    if (!command || command.length > 4000)
      return { error: "Give one command." };
    const cwd = this.project.path,
      request = {
        kind: "permission",
        title: command,
        details: { command, cwd, requestedThrough: "delegate_run" },
      },
      approval = this.approve
        ? await this.approve(request)
        : await this.controller.waitApproval(this.run, request, this.signal);
    if (!approval.allow)
      return {
        declined: true,
        reason:
          approval.reason ||
          "The user declined this command. Do not retry it.",
      };
    let result;
    try {
      result = await this.controller.runCommand({
        command,
        cwd,
        signal: this.signal,
        limit: 240_000,
      });
    } catch (error) {
      if (this.signal.aborted) throw error;
      return { error: `The command could not be started: ${error.message}` };
    }
    const head = {
        exitCode: result.exitCode,
        ...(result.timedOut && { timedOut: true }),
      },
      size = tokensOf(result.output.length),
      outcome = this.plan.actions.run
        ? await this.viaWorker({
            action: "run",
            job: { action: "run", content: size },
            mode: "inline",
            task: `Return the lines of this command output that matter, verbatim, in order, with their line numbers. Wanted: ${String(args.want ?? "errors, failures and the final summary").slice(0, 500)}. Do not paraphrase or summarise the lines. End with one line stating the overall result.\n\nCommand: ${command}\nExit code: ${result.exitCode}\n\n${numbered(result.output)}`,
          })
        : { why: "cheaper" };
    if (outcome.text)
      return {
        ...head,
        relevant: outcome.text,
        by: outcome.name,
        note: `The full output was about ${count(size)} tokens.`,
      };
    return { ...head, output: result.output };
  }

  async draft(args) {
    const kind = args.kind === "changelog" ? "changelog" : "commit",
      diff = await git(this.project.path, [
        "diff",
        "--no-ext-diff",
        args.staged === true ? "--cached" : "HEAD",
      ]).catch(() => null);
    if (diff === null)
      return { error: "No Git diff is available in this project." };
    if (!diff.trim())
      return { error: "There is no uncommitted change to describe." };
    if (diff.length > MAX_MATERIAL)
      return this.decline("The diff is too large to hand off.");
    const outcome = await this.viaWorker({
      action: "draft",
      job: { action: "draft", content: tokensOf(diff.length), kind },
      mode: "inline",
      task: `${DRAFT_TASK[kind]}\n\n${diff}`,
    });
    if (outcome.text) return { draft: outcome.text, by: outcome.name };
    return outcome.why === "cheaper"
      ? this.decline("Writing this yourself is estimated to be cheaper.")
      : this.alone("No worker could write the draft.");
  }
}
