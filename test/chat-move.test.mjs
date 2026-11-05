import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { claudeContent } from "../src/providers/attachments.mjs";

const deferred = () => Promise.withResolvers();
const assertCompleted = (events) => {
  for (const event of events.filter(
    (e) =>
      e.type === "run" && ["completed", "failed"].includes(e.payload.status),
  ))
    assert.equal(event.payload.status, "completed", event.payload.error);
};
async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      "Timed out waiting for the simulated turn",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(t, provider = "codex", mode = "default") {
  const dir = await mkdtemp(join(tmpdir(), "harness-chat-move-"));
  const source = join(dir, "source"),
    destination = join(dir, "destination");
  await mkdir(source);
  await mkdir(destination);
  const store = new Store(":memory:"),
    controller = new Controller(store, { dataDir: dir });
  const project = store.addProject("Source", source);
  const chat = store.createConversation({
    projectId: project.id,
    provider,
    model: "fixture",
    effort: "high",
    permissions: "manual",
    mode,
    scope: "project",
    title: "Moving chat",
  });
  controller.providers = [
    { id: provider, models: [{ id: "fixture", efforts: ["high"] }] },
  ];
  const events = [];
  controller.on("event", (event) => events.push(event));
  t.after(async () => {
    await controller.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const start = (extra = {}) =>
    controller.send(chat.id, {
      actionId: crypto.randomUUID(),
      text: "Move this chat and finish the parser",
      provider,
      model: "fixture",
      effort: "high",
      ...extra,
    });
  return { store, controller, chat, source, destination, events, start };
}

for (const provider of ["codex", "claude", "cursor", "openrouter"]) {
  test(`${provider}: a successful move starts one fresh turn in the destination`, async (t) => {
    const f = await fixture(t, provider),
      seen = [];
    let original;
    f.controller.runners[provider] = async (ctx) => {
      seen.push(ctx);
      if (seen.length === 1) {
        ctx.saveSession({ id: "old-session" });
        const queued = await ctx.history("move_chat", {
          directory: f.destination,
        });
        assert.equal(queued.queued, true);
        assert.match(queued.instruction, /automatically prompt/);
        ctx.emit("text", {
          nativeId: "old",
          text: "The move is queued. Parser work remains.",
        });
      } else {
        ctx.saveSession({ id: "new-session" });
        ctx.emit("text", {
          nativeId: "new",
          text: "Continuing the parser here.",
        });
      }
      return { status: "completed" };
    };
    original = f.start();
    const oldEntry = f.controller.active.get(f.chat.id);
    await waitFor(() => !f.controller.active.has(f.chat.id));
    assertCompleted(f.events);
    assert.equal(seen.length, 2);
    const next = seen[1],
      moved = f.store.conversation(f.chat.id);
    assert.equal(next.project.path, f.destination);
    assert.equal(next.session?.id, undefined);
    assert.match(
      next.instructions,
      new RegExp(f.destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(next.handoff, /Parser work remains/);
    assert.match(next.handoff, /Move this chat and finish the parser/);
    assert.match(next.text, /The move is complete/);
    assert.match(next.text, /without repeating completed work/);
    assert.match(next.text, /If moving the chat was the entire request/);
    assert.equal(next.mode, "default");
    assert.equal(next.permissions, "manual");
    assert.equal(next.effort, "high");
    assert.equal(moved.sessions[provider].id, "new-session");
    assert.equal(moved.scope, "project");
    assert.equal(moved.title, "Moving chat");
    const note = f.store
      .messages(f.chat.id)
      .find((m) => m.source === "chat-move");
    assert.equal(
      note.content,
      `Chat moved to ${f.destination}. Continuing the task.`,
    );
    assert.equal(f.store.runForAction(`move-${original.id}`).id, note.run_id);
    f.controller.continueChatMove(f.chat.id, oldEntry);
    assert.equal(seen.length, 2);
    assert.equal(
      f.store.messages(f.chat.id).filter((m) => m.source === "chat-move")
        .length,
      1,
    );
  });
}

for (const provider of ["codex", "claude"]) {
  test(`${provider}: moving a Goal retains its objective and delivers the move prompt`, async (t) => {
    const f = await fixture(t, provider, "goal"),
      seen = [];
    const objective = "Ship the parser with passing tests";
    f.controller.runners[provider] = async (ctx) => {
      seen.push(ctx);
      if (seen.length === 1) {
        ctx.saveSession({ id: "old-goal-session" });
        ctx.goalState("active", objective);
        if (provider === "codex") ctx.emit("work", { kind: "plan", plan: [
          { step: "Inspect the parser", status: "completed" }, { step: "Verify it", status: "pending" },
        ] });
        else {
          ctx.emit("work", { kind: "tool", provider, item: { id: "phases", name: "TodoWrite", input: { todos: [
            { content: "Inspect the parser", status: "completed" }, { content: "Verify it", status: "pending" },
          ] } } });
          ctx.emit("work", { kind: "tool-result", provider, toolUseId: "phases", isError: false });
        }
        await ctx.history("move_chat", { directory: f.destination });
      } else {
        assert.match(ctx.addendum, /\[completed\] Inspect the parser/);
        assert.equal(f.store.conversation(f.chat.id).goalProgress.phases[0].status, "completed");
        assert.equal(ctx.startGoal, true);
        assert.equal(ctx.resumeGoal, false);
        assert.equal(ctx.session?.id, undefined);
        assert.equal(ctx.goalObjective, objective);
        assert.equal(
          f.store.conversation(f.chat.id).sessions[provider].goal.objective,
          objective,
        );
        assert.match(ctx.text, /The Goal objective is still:\nShip the parser/);
        const prompt = await claudeContent(ctx);
        assert.match(prompt, /The move is complete/);
        assert.equal(prompt.split(ctx.text).length - 1, 1);
        assert.match(prompt, /\/goal Ship the parser with passing tests/);
        ctx.goalState("complete", objective);
      }
      return { status: "completed" };
    };
    f.start();
    await waitFor(() => !f.controller.active.has(f.chat.id));
    assertCompleted(f.events);
    assert.equal(seen.length, 2);
    const progress = f.store.conversation(f.chat.id).goalProgress;
    assert.equal(progress.goalId, seen[0].runId);
    assert.equal(progress.status, "complete");
    assert.equal(
      f.store.conversation(f.chat.id).sessions[provider].goal.objective,
      objective,
    );
  });
}

test("a permission change during a moved Goal resumes the new session without recreating its Goal", async (t) => {
  const f = await fixture(t, "codex", "goal"),
    entered = deferred(),
    seen = [];
  const objective = "Finish the parser";
  f.controller.runners.codex = async (ctx) => {
    seen.push(ctx);
    if (seen.length === 1) {
      ctx.goalState("active", objective);
      await ctx.history("move_chat", { directory: f.destination });
    } else if (seen.length === 2) {
      ctx.saveSession({ id: "destination-goal-session" });
      ctx.goalState("active", objective);
      entered.resolve();
      await new Promise((resolve) =>
        ctx.signal.addEventListener("abort", resolve, { once: true }),
      );
      return { status: "cancelled" };
    } else {
      ctx.goalState("complete", objective);
    }
    return { status: "completed" };
  };
  f.start();
  await entered.promise;
  f.controller.setPermissions(f.chat.id, "override");
  await waitFor(() => !f.controller.active.has(f.chat.id));
  assertCompleted(f.events);
  assert.equal(seen.length, 3);
  assert.equal(seen[1].startGoal, true);
  assert.equal(seen[2].startGoal, false);
  assert.equal(seen[2].continuing, true);
  assert.equal(seen[2].session.id, "destination-goal-session");
  assert.equal(seen[2].permissions, "override");
  assert.equal(
    f.store.conversation(f.chat.id).sessions.codex.goal.objective,
    objective,
  );
});

test("a queued user message takes priority and runs in the destination without an extra turn", async (t) => {
  const f = await fixture(t),
    gate = deferred(),
    requested = deferred(),
    seen = [];
  f.controller.runners.codex = async (ctx) => {
    seen.push(ctx);
    if (seen.length === 1) {
      await ctx.history("move_chat", { directory: f.destination });
      requested.resolve();
      await gate.promise;
    }
    return { status: "completed" };
  };
  f.start();
  await requested.promise;
  f.start({ text: "Look at the destination README first", mode: "plan" });
  gate.resolve();
  await waitFor(() => !f.controller.active.has(f.chat.id));
  assertCompleted(f.events);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].project.path, f.destination);
  assert.equal(seen[1].text, "Look at the destination README first");
  assert.equal(seen[1].mode, "plan");
  assert.equal(
    f.store.messages(f.chat.id).filter((m) => m.source === "chat-move").length,
    0,
  );
});

test("a Plan continuation keeps Plan mode and current settings", async (t) => {
  const f = await fixture(t, "codex", "plan"),
    seen = [];
  f.controller.runners.codex = async (ctx) => {
    seen.push(ctx);
    if (seen.length === 1) {
      await ctx.history("move_chat", { directory: f.destination });
      f.store.updateConversation(f.chat.id, {
        permissions: "override",
        effort: null,
      });
    }
    return { status: "completed" };
  };
  f.start();
  await waitFor(() => !f.controller.active.has(f.chat.id));
  assertCompleted(f.events);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].mode, "plan");
  assert.equal(seen[1].permissions, "override");
  assert.equal(seen[1].effort, null);
  assert.match(seen[1].text, /the move does not approve a plan/);
});

for (const reason of [
  "same-directory",
  "missing-destination",
  "failed-run",
  "usage",
  "billing",
]) {
  test(`${reason} does not start an automatic move continuation`, async (t) => {
    const f = await fixture(t);
    let attempts = 0;
    f.controller.runners.codex = async (ctx) => {
      attempts++;
      await ctx.history("move_chat", {
        directory: reason === "same-directory" ? f.source : f.destination,
      });
      if (reason === "missing-destination")
        await rm(f.destination, { recursive: true });
      if (reason === "usage" || reason === "billing") {
        ctx.emit("work", {
          kind: "billing-stop",
          reason:
            reason === "usage"
              ? "Usage limit reached"
              : "Billing is not configured",
        });
      }
      return { status: reason === "failed-run" ? "failed" : "completed" };
    };
    f.start();
    await waitFor(() => !f.controller.active.has(f.chat.id));
    assert.equal(attempts, 1);
    assert.equal(
      f.store.messages(f.chat.id).filter((m) => m.source === "chat-move")
        .length,
      0,
    );
    if (["same-directory", "missing-destination"].includes(reason))
      assert.equal(
        f.store.project(f.store.conversation(f.chat.id).project_id).path,
        f.source,
      );
    if (reason === "missing-destination")
      assert.ok(f.events.some((e) => e.payload.kind === "chat-move-failed"));
  });
}

for (const reason of ["stop", "shutdown", "archive", "superseded"]) {
  test(`${reason} during move IO prevents automatic continuation`, async (t) => {
    const f = await fixture(t),
      entered = deferred(),
      gate = deferred();
    let attempts = 0;
    const finishMove = f.controller.finishChatMove.bind(f.controller);
    f.controller.finishChatMove = async (...args) => {
      entered.resolve();
      await gate.promise;
      return finishMove(...args);
    };
    f.controller.runners.codex = async (ctx) => {
      attempts++;
      await ctx.history("move_chat", { directory: f.destination });
      return { status: "completed" };
    };
    f.start();
    await entered.promise;
    let closing;
    if (reason === "stop") f.controller.cancel(f.chat.id);
    if (reason === "shutdown") closing = f.controller.close();
    if (reason === "archive") f.store.setArchived(f.chat.id, true);
    if (reason === "superseded") {
      const queued = f.start({ text: "A newer request that is then removed" });
      f.controller.removeQueued(f.chat.id, queued.id);
    }
    gate.resolve();
    await closing;
    await waitFor(() => !f.controller.active.has(f.chat.id));
    assert.equal(attempts, 1);
    assert.equal(
      f.store.project(f.store.conversation(f.chat.id).project_id).path,
      f.destination,
    );
    assert.equal(
      f.store.messages(f.chat.id).filter((m) => m.source === "chat-move")
        .length,
      0,
    );
  });
}

for (const reason of ["provider-unavailable", "restart-gated"]) {
  test(`${reason} reports a continuation failure while retaining the successful move`, async (t) => {
    const f = await fixture(t);
    let attempts = 0;
    f.controller.runners.codex = async (ctx) => {
      attempts++;
      await ctx.history("move_chat", { directory: f.destination });
      if (reason === "provider-unavailable")
        f.controller.providers[0].blockReason = "Provider unavailable";
      else
        f.controller.selfRestart = {
          gated: true,
          assertAdmission() {
            throw new Error("Harness is restarting");
          },
        };
      return { status: "completed" };
    };
    f.start();
    await waitFor(() => !f.controller.active.has(f.chat.id));
    assert.equal(attempts, 1);
    assert.equal(
      f.store.project(f.store.conversation(f.chat.id).project_id).path,
      f.destination,
    );
    const failure = f.events.find(
      (e) => e.payload.kind === "chat-move-continuation-failed",
    );
    assert.equal(
      failure.payload.item.title,
      "Chat moved, but the agent could not continue",
    );
    assert.match(
      failure.payload.item.description,
      reason === "provider-unavailable"
        ? /Provider unavailable/
        : /Harness is restarting/,
    );
  });
}
