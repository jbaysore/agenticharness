// One real Codex turn is deliberately interrupted by an abrupt host-process exit.
import { fork } from "node:child_process";
import { once } from "node:events";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
const dir = resolve(".local/restart-acceptance");
let child, origin, headers, chat, run, body;
async function start() {
  child = fork(resolve("scripts/fixture-host.mjs"), [], {
    env: {
      ...process.env,
      HARNESS_DATA_DIR: dir,
      HARNESS_INITIAL_PROJECT: resolve(".local/dogfood-project"),
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const [{ runtime }] = await once(child, "message");
  origin = runtime.origin;
  const launch = await fetch(origin + "/internal/launch", {
    method: "POST",
    headers: { Authorization: "Bearer " + runtime.controlToken },
  }).then((r) => r.json());
  const paired = await fetch(origin + "/api/pair", {
    method: "POST",
    headers: { "X-Harness-Client": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ code: new URL(launch.url).hash.slice(6) }),
  });
  headers = {
    "X-Harness-Client": "1",
    "Content-Type": "application/json",
    Cookie: paired.headers.get("set-cookie").split(";")[0],
  };
}
async function api(path, data) {
  const response = await fetch(origin + path, {
    headers,
    method: data === undefined ? "GET" : "POST",
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error);
  return json;
}
try {
  await start();
  const state = await api("/api/state"),
    provider = state.providers.find((p) => p.id === "codex");
  if (provider.blockReason) throw new Error(provider.blockReason);
  const model = provider.models.find((m) => m.isDefault);
  chat = await api("/api/chats", { projectId: state.projects[0].id });
  body = {
    actionId: randomUUID(),
    provider: "codex",
    model: model.id,
    effort: "low",
    text: "Explain JavaScript promises in five paragraphs. No tools or file changes. The test host will disconnect during your first response.",
  };
  run = await api("/api/chats/" + chat.id + "/messages", body);
  const deadline = Date.now() + 60000;
  let snapshot;
  do {
    if (Date.now() > deadline)
      throw new Error("No real streaming response before timeout");
    await new Promise((r) => setTimeout(r, 80));
    snapshot = await api("/api/chats/" + chat.id);
  } while (
    !snapshot.messages.some((m) => m.role === "assistant" && m.content.length)
  );
  if (!snapshot.activeRun)
    throw new Error(
      "Turn completed too quickly to test an active interruption",
    );
  const exited = once(child, "exit");
  child.kill();
  await exited;
  await start();
  snapshot = await api("/api/chats/" + chat.id);
  if (snapshot.runs[0].status !== "interrupted" || snapshot.activeRun)
    throw new Error("Restart did not mark the active turn interrupted");
  const duplicate = await api("/api/chats/" + chat.id + "/messages", body);
  if (duplicate.id !== run.id || !duplicate.duplicate)
    throw new Error("Interrupted action was duplicated");
  const continuation = await api("/api/chats/" + chat.id + "/messages", {
    ...body,
    actionId: randomUUID(),
    text: "The host restarted. Do not use tools. Reply only: explicit recovery verified.",
  });
  const finish = Date.now() + 60000;
  do {
    if (Date.now() > finish) throw new Error("Explicit continuation timed out");
    await new Promise((r) => setTimeout(r, 250));
    snapshot = await api("/api/chats/" + chat.id);
  } while (snapshot.activeRun);
  if (snapshot.runs[0].status !== "completed")
    throw new Error("Explicit native continuation failed");
  const result = {
    type: "real-provider-real-host-process-crash",
    provider: "codex",
    partialMessageSurvived: true,
    interruptedRunId: run.id,
    duplicatePrevented: true,
    explicitContinuation: snapshot.messages
      .filter((m) => m.run_id === continuation.id && m.role === "assistant")
      .map((m) => m.content)
      .join("\n"),
    at: new Date().toISOString(),
  };
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (child && !child.killed) child.kill();
}
