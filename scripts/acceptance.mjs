// Real providers. This is opt-in and consumes included subscription usage.
// All agent writes are requested in a disposable, ignored fixture repository.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createHarness } from "../src/server.mjs";
import { cursorAuth } from "../src/providers/cursor.mjs";
const exec = promisify(execFile),
  fixture = resolve(".local/dogfood-project");
await mkdir(fixture, { recursive: true });
await writeFile(
  join(fixture, "title.mjs"),
  "export function issueTitle(prefix, title) { return `${prefix}: ${title}`; }\n",
);
await writeFile(
  join(fixture, "title.test.mjs"),
  `import test from 'node:test';import assert from 'node:assert/strict';import {issueTitle} from './title.mjs';
test('trims both fields',()=>assert.equal(issueTitle(' Fix ',' login '),'Fix: login'));
test('blank prefix uses Task',()=>assert.equal(issueTitle(' ','login'),'Task: login'));
test('blank title uses Untitled task',()=>assert.equal(issueTitle('Fix',' '),'Fix: Untitled task'));
`,
);
await exec("git", ["init", "-b", "main", fixture], { windowsHide: true });
await exec("git", ["-C", fixture, "add", "title.mjs", "title.test.mjs"], {
  windowsHide: true,
});
await exec(
  "git",
  [
    "-C",
    fixture,
    "-c",
    "user.name=Harness Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "Acceptance fixture",
  ],
  { windowsHide: true },
);
const app = await createHarness({
  dataDir: resolve(".local/acceptance"),
  port: 0,
  startProviders: false,
  seedProject: fixture,
});
const confirmation = await cursorAuth();
app.store.setting("cursor-billing", {
  fingerprint: confirmation.fingerprint,
  disabled: true,
  verifiedAt: Date.now(),
  source:
    "Product owner confirmed disabled on-demand usage in this goal chat on 2026-10-06",
});
const inside = (path) => {
  const rel = relative(fixture, resolve(path));
  return rel !== ".." && !rel.startsWith("..") && !isAbsolute(rel);
};
const results = [];
app.controller.on("event", (e) => {
  if (e.type === "approval") {
    const r = e.payload.request,
      d = r.details ?? {};
    const safeFile =
      ["Edit", "Write"].includes(r.title) &&
      typeof d.file_path === "string" &&
      inside(d.file_path);
    const command = d.command ?? (d.kind === "execute" ? d.title : "") ?? "";
    const safeCommand =
      (!d.cwd || inside(d.cwd)) &&
      /\b(node --test|Get-Content|Get-ChildItem|Get-Location|git (status|diff)|cat title|ls|pwd|rg)\b/.test(
        command,
      ) &&
      !/Remove-Item|Invoke-|curl|wget|Set-Content|Start-Process|git (push|commit|reset)|https?:/i.test(
        command,
      );
    const allow = !!(safeFile || safeCommand);
    console.log(
      JSON.stringify({
        approval: r.title,
        allow,
        details: allow ? undefined : d,
      }),
    );
    app.controller.answer(e.payload.id, { allow });
  }
  if (e.type === "run")
    console.log(
      JSON.stringify({
        provider: e.payload.provider,
        status: e.payload.status,
        error: e.payload.error,
      }),
    );
  if (e.type === "work" && e.payload.kind === "billing-stop")
    console.log(JSON.stringify(e.payload));
});
async function turn(chat, provider, text) {
  const p = app.controller.providers.find((p) => p.id === provider);
  if (p.blockReason) throw new Error(`${provider}: ${p.blockReason}`);
  const model =
    p.models.find((m) => m.isDefault && !m.disabled) ??
    p.models.find((m) => !m.disabled);
  const run = app.controller.send(chat.id, {
    actionId: randomUUID(),
    provider,
    model: model.id,
    effort: model.defaultEffort,
    text,
  });
  const deadline = Date.now() + 180000;
  while (app.controller.active.has(chat.id)) {
    if (Date.now() > deadline) {
      app.controller.cancel(chat.id);
      throw new Error("Acceptance turn exceeded three minutes");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const final = app.store.run(run.id),
    messages = app.store
      .messages(chat.id)
      .filter((m) => m.run_id === run.id && m.role === "assistant");
  const result = {
    provider,
    model: model.id,
    status: final.status,
    response: messages.map((m) => m.content).join("\n"),
  };
  results.push(result);
  console.log(JSON.stringify(result));
  if (final.status !== "completed")
    throw new Error(`${provider} acceptance failed`);
}
try {
  await app.controller.refreshProviders();
  console.log(
    JSON.stringify(
      app.controller.providers.map((p) => ({
        provider: p.id,
        connected: p.connected,
        blocked: p.blockReason,
        models: p.models.length,
      })),
    ),
  );
  const project = app.store.projects()[0],
    chat = app.store.createConversation({
      projectId: project.id,
      title: "Real three-agent acceptance",
    });
  await turn(
    chat,
    "codex",
    "Fix issueTitle in title.mjs so it trims both arguments, uses Task for a blank prefix and Untitled task for a blank title. Run node --test. Keep changes only in this fixture repository. Do not commit. Report verification.",
  );
  await exec(process.execPath, ["--test"], { cwd: fixture, windowsHide: true });
  await turn(
    chat,
    "claude",
    "Review the implementation from the preceding Codex turn. Read title.mjs and title.test.mjs and run node --test. Do not change files or commit. Cite any correctness issue, or say no issues found. This is a real handoff; inspect files before trusting the earlier report.",
  );
  await turn(
    chat,
    "cursor",
    "Review title.mjs and the preceding agents’ work. Add a test for normal inputs without extra whitespace and run node --test. Keep changes only in this fixture. Do not commit. Report exactly which test you added and the final test count.",
  );
  const verification = await exec(process.execPath, ["--test"], {
    cwd: fixture,
    windowsHide: true,
  });
  const evidence = {
    at: new Date().toISOString(),
    type: "real-provider-acceptance",
    results,
    verification: verification.stdout,
    historySearch: app.store.search("issueTitle", { projectId: project.id }),
    code: await readFile(join(fixture, "title.mjs"), "utf8"),
  };
  await writeFile(
    ".local/acceptance-result.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log("Real cross-provider acceptance passed. Evidence saved locally.");
} finally {
  await app.close();
}
