// Opt-in included-usage checks. Uses the existing disposable acceptance repository.
import { createHarness } from "../src/server.mjs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
const app = await createHarness({
    dataDir: resolve(".local/acceptance"),
    port: 0,
    startProviders: false,
  }),
  results = [];
try {
  await app.controller.refreshProviders();
  const chat = app.store
    .conversations()
    .find(
      (c) =>
        Object.keys(c.sessions).length === 3 &&
        app.store.messages(c.id).some((m) => m.content.includes("4 of 4")),
    );
  if (!chat) throw new Error("Run the three-provider acceptance first");
  app.controller.on("event", (e) => {
    if (e.type === "approval") {
      const r = e.payload.request,
        allow =
          r.kind === "permission" &&
          (/Agent|Task|Read|Glob|Grep/.test(r.title) ||
            r.details?.kind === "read" ||
            /history_search|history_read/.test(r.title));
      console.log(JSON.stringify({ approval: r.title, allow }));
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
  });
  for (const provider of ["codex", "claude", "cursor"]) {
    const p = app.controller.providers.find((p) => p.id === provider);
    if (p.blockReason) throw new Error(p.blockReason);
    const model =
      p.models.find((m) => m.isDefault && !m.disabled) ??
      p.models.find((m) => !m.disabled);
    const before = app.store.conversation(chat.id).sessions[provider]?.id;
    const start = app.store.latestEventId();
    const run = app.controller.send(chat.id, {
      actionId: randomUUID(),
      provider,
      model: model.id,
      effort: model.defaultEffort,
      text: 'Acceptance check: use the Harness history_search tool for issueTitle and use history_read on one result. Cite its conversation source. Then delegate ONE tiny read-only native subagent task: explain in one sentence why trimming a blank string yields the fallback in `prefix.trim() || "Task"`. Give the subagent that expression directly; no shell commands or files are needed. Wait for the subagent and summarize its result. Do not change files or commit.',
    });
    const deadline = Date.now() + 180000;
    while (app.controller.active.has(chat.id)) {
      if (Date.now() > deadline) {
        app.controller.cancel(chat.id);
        throw new Error(provider + " native test timed out");
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const saved = app.store.run(run.id),
      events = app.store.events(start, 2000).filter((e) => e.runId === run.id),
      response = app.store
        .messages(chat.id)
        .filter((m) => m.run_id === run.id && m.role === "assistant")
        .map((m) => m.content)
        .join("\n");
    const result = {
      provider,
      status: saved.status,
      error: saved.error,
      nativeSessionPreserved:
        app.store.conversation(chat.id).sessions[provider]?.id === before,
      historyTools: events
        .filter((e) => e.payload.kind === "history-tool")
        .map((e) => e.payload.name),
      nativeSubagentEvents: events.filter(
        (e) => e.payload.kind === "native-subagent",
      ).length,
      response,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    if (saved.status !== "completed")
      throw new Error(provider + " native continuation failed");
  }
} finally {
  await writeFile(
    ".local/native-acceptance.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        type: "real-provider-native-sessions-history-delegation",
        results,
      },
      null,
      2,
    ),
  );
  await app.close();
}
