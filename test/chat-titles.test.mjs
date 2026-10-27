import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { historyTools, renameInstructions } from "../src/core/history.mjs";
import { runClaude } from "../src/providers/claude.mjs";

for (const provider of ["codex", "claude", "cursor"])
  test(`${provider}: title instructions are silent, retry missed titles, and stop after naming`, async (t) => {
    const store = new Store(":memory:"),
      controller = new Controller(store, {}),
      project = store.addProject("Titles", process.cwd()),
      chat = store.createConversation({ projectId: project.id, provider }),
      contexts = [];
    t.after(async () => {
      await controller.close();
      store.close();
    });
    controller.providers = [
      { id: provider, models: [{ id: "fixture", efforts: [] }] },
    ];
    controller.runners[provider] = async (ctx) => {
      contexts.push(ctx);
      ctx.saveSession({ id: ctx.session?.id ?? `title-session-${provider}` });
      ctx.promptAccepted();
      if (contexts.length === 2) {
        await ctx.history("rename_chat", { title: "Fix sidebar flicker" });
        ctx.emit("text", {
          nativeId: "progress",
          text: "Checking the sidebar.",
        });
      }
      return { status: "completed" };
    };
    let action = 0;
    const send = async (target, text) => {
      controller.send(target.id, {
        actionId: `chat-title-${provider}-${++action}`,
        text,
        provider,
        model: "fixture",
      });
      await controller.active.get(target.id).task;
    };
    await send(chat, "Please investigate the sidebar flicker on resize");
    const shown = (ctx) =>
        [ctx.instructions, ctx.addendum].filter(Boolean).join("\n"),
      tool =
        provider === "claude" ? "mcp__harness__rename_chat" : "rename_chat";
    assert.ok(shown(contexts[0]).includes(`silently call ${tool} once`));
    assert.match(
      contexts[0].addendum,
      /Before your first user-facing response or other task work/,
    );
    assert.match(
      contexts[0].addendum,
      /Do not announce, narrate, or mention the rename/,
    );

    // A missed rename is requested again, even though this isn't the first turn.
    await send(chat, "Continue");
    assert.equal(contexts[1].firstTurn, false);
    assert.ok(contexts[1].addendum.includes(renameInstructions(provider)));
    assert.equal(store.conversation(chat.id).title, "Fix sidebar flicker");
    const events = store.events(),
      titleEvent = events.find(
        (e) => e.type === "chat" && e.payload.title === "Fix sidebar flicker",
      ),
      progress = events.find((e) => e.type === "text");
    assert.ok(titleEvent.id < progress.id);
    assert.deepEqual(
      store
        .messages(chat.id)
        .filter((m) => m.role === "assistant")
        .map((m) => m.content),
      ["Checking the sidebar."],
    );

    await send(chat, "Continue again");
    assert.ok(!shown(contexts[2]).includes(`silently call ${tool} once`));
    if (provider === "cursor") assert.equal(contexts[2].instructions, "");
    else
      assert.match(
        contexts[2].instructions,
        /Never announce, narrate, or mention your own automatic chat rename/,
      );

    // A title chosen by the user never triggers the naming instruction.
    const named = store.createConversation({
      projectId: project.id,
      title: "My title",
      provider,
    });
    await send(named, "Investigate something else");
    assert.ok(!shown(contexts[3]).includes(`silently call ${tool} once`));
    const result = await contexts[3].history("rename_chat", {
      title: "Agent title",
    });
    assert.equal(result.renamed, false);
    assert.equal(store.conversation(named.id).title, "My title");
  });

test("Claude exposes the silent title tool immediately and calls through the real MCP server", async () => {
  const calls = [],
    events = [],
    titleTool = historyTools.find((t) => t.name === "rename_chat");
  const result = await runClaude(
    {
      project: { path: process.cwd() },
      text: "Investigate the sidebar flicker",
      instructions: renameInstructions("claude"),
      permissions: "manual",
      signal: new AbortController().signal,
      saveSession() {},
      emit(type, payload) {
        events.push({ type, payload });
      },
      history: async (name, args) => {
        calls.push({ name, args });
        return { renamed: true, title: args.title };
      },
      approve: async () =>
        assert.fail("Naming must not ask the user for approval"),
    },
    {
      baseOptions: () => ({}),
      readAuth: async () => ({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "pro",
      }),
      readUsage: async () => ({
        rate_limits_available: true,
        rate_limits: {
          extra_usage: { is_enabled: false, user_disabled: true },
          limits: [{ kind: "five_hour", percent: 10 }],
        },
      }),
      queryFn: ({ prompt, options }) => ({
        interrupt: async () => {},
        close() {},
        async *[Symbol.asyncIterator]() {
          await prompt[Symbol.asyncIterator]().next();
          assert.ok(options.allowedTools.includes("mcp__harness__rename_chat"));
          const client = new Client({ name: "title-test", version: "1.0.0" }),
            [clientTransport, serverTransport] =
              InMemoryTransport.createLinkedPair(),
            server = options.mcpServers.harness.instance;
          try {
            await server.connect(serverTransport);
            await client.connect(clientTransport);
            const { tools } = await client.listTools(),
              rename = tools.find((t) => t.name === "rename_chat"),
              projectNotes = tools.find((t) => t.name === "project_notes"),
              projectNoteRead = tools.find(
                (t) => t.name === "project_note_read",
              );
            assert.equal(rename._meta["anthropic/alwaysLoad"], true);
            assert.equal(rename.description, titleTool.description);
            assert.match(rename.description, /Never announce or mention/);
            assert.match(projectNotes.description, /Project Log/);
            assert.ok(projectNotes.inputSchema.properties.query);
            assert.match(projectNoteRead.description, /full Project Log entry/);
            assert.deepEqual(projectNoteRead.inputSchema.required, ["noteId"]);
            const answer = await options.canUseTool(
              "mcp__harness__rename_chat",
              { title: "Fix sidebar flicker" },
            );
            assert.equal(answer.behavior, "allow");
            const renamed = await client.callTool({
              name: "rename_chat",
              arguments: answer.updatedInput,
            });
            assert.deepEqual(JSON.parse(renamed.content[0].text), {
              renamed: true,
              title: "Fix sidebar flicker",
            });
          } finally {
            await client.close();
            await server.close();
          }
          yield { type: "result", is_error: false };
        },
      }),
    },
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, [
    { name: "rename_chat", args: { title: "Fix sidebar flicker" } },
  ]);
  assert.equal(
    events.some((e) => e.type === "text"),
    false,
  );
});
