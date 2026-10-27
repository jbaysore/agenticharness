import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.mjs";
import { Controller } from "../src/core/controller.mjs";
import { OpenRouter } from "../src/providers/openrouter.mjs";
import { runOpenRouter } from "../src/providers/openrouter-runner.mjs";
import { OpenRouterCredentials } from "../src/security/openrouter.mjs";
import { callOpenRouterFile } from "../src/core/openrouter-files.mjs";
import { agentInstructions } from "../src/core/history.mjs";
import { checkMode } from "../src/core/modes.mjs";
import { commandTool } from "../src/core/command-tool.mjs";
import { subscriptionEnvironment } from "../src/security/environment.mjs";

const ID = "fixture/coder-v1:free",
  SECOND = "fixture/other-v1:free";
const model = (id = ID, extra = {}) => ({
  id,
  canonical_slug: id.replace(":free", "-20261026"),
  name: "Fixture Coder",
  pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
  context_length: 262144,
  supported_parameters: ["tools"],
  architecture: {
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
  },
  ...extra,
});
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function stream({
  actual = ID,
  content = "Done",
  calls,
  finish = calls ? "tool_calls" : "stop",
  done = true,
  cost = 0,
} = {}) {
  const events = [
    {
      model: actual,
      choices: [
        {
          index: 0,
          delta: {
            content,
            ...(calls
              ? { tool_calls: calls.map((c, index) => ({ index, ...c })) }
              : {}),
          },
          finish_reason: null,
        },
      ],
    },
    {
      model: actual,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost },
    },
  ];
  const text =
    events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("") +
    (done ? "data: [DONE]\n\n" : "");
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        // Deliberately split a UTF-8/SSE response at arbitrary network boundaries.
        for (let i = 0; i < bytes.length; i += 17)
          controller.enqueue(bytes.slice(i, i + 17));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const call = (name, args, id = "tool-1") => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
async function fixture(
  t,
  {
    models = [model(), model(SECOND)],
    responses = [],
    credentials: supplied,
    now,
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "harness-openrouter-"));
  const store = new Store(":memory:"),
    requests = [];
  let key = "sk-or-v1-fixture-key-not-a-real-credential";
  const credentials = supplied ?? {
    has: async () => !!key,
    read: async () => key,
    write: async (value) => {
      key = value;
    },
    remove: async () => {
      key = null;
    },
  };
  const service = new OpenRouter(store, directory, {
    credentials,
    ...(now ? { now } : {}),
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith("/models")) return json({ data: models });
      if (url.endsWith("/key"))
        return json({
          data: { free_model_daily_requests: { remaining: 49, limit: 50 } },
        });
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      const response = responses.shift();
      if (!response)
        throw new Error("Unexpected inference request in simulated test");
      return typeof response === "function" ? response(options) : response;
    },
  });
  const project = store.addProject("Fixture", directory),
    chat = store.createConversation({
      projectId: project.id,
      provider: "openrouter",
      model: ID,
    });
  t.after(async () => {
    service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const approve = async (ids = [ID], overrides = {}) =>
    service.configure({
      revision: service.policy().revision,
      enabled: true,
      dataConsent: true,
      allowedModels: ids,
      ...overrides,
    });
  const ctx = {
    openrouter: service,
    project: { ...project, repositories: [] },
    dataDir: directory,
    chat,
    model: ID,
    mode: "default",
    instructions: "Fixture instructions",
    addendum: "",
    handoff: "",
    text: "Do the task",
    tools: [],
    attachments: [],
    signal: new AbortController().signal,
    saveSession() {},
    emit() {},
    approve: async () => ({ allow: true }),
    history: async () => ({ ok: true }),
  };
  return {
    directory,
    store,
    service,
    requests,
    responses,
    models,
    approve,
    ctx,
    inference: () =>
      requests.filter((r) => r.url.endsWith("/chat/completions")),
  };
}

test("OpenRouter starts disabled and requires explicit data consent before any file or inference access", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.service.policy(), {
    revision: 0,
    enabled: false,
    dataConsent: false,
    allowedModels: [],
  });
  await assert.rejects(runOpenRouter(f.ctx), /disabled/);
  await assert.rejects(
    callOpenRouterFile(f.ctx, "read_file", { path: "missing" }),
    /disabled/,
  );
  await assert.rejects(f.approve([ID], { dataConsent: false }), /consent/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.service.policy().revision, 0);
});

test("an empty list, forged IDs, routers, aliases, paid models and unknown settings authorize zero inference", async (t) => {
  const f = await fixture(t, {
    models: [
      model(),
      model("fixture/paid-v1", {
        pricing: { prompt: "0.01", completion: "0.02" },
      }),
    ],
  });
  await f.service.catalogRefresh();
  await f.approve([]);
  await assert.rejects(runOpenRouter(f.ctx), /not approved/);
  await f.approve();
  for (const id of [
    SECOND,
    "fixture/coder-v1",
    "openrouter/free",
    "openrouter/auto",
    "fixture/*",
    "~fixture/coder-latest",
    "fixture/coder-latest:free",
  ]) {
    await assert.rejects(
      runOpenRouter({ ...f.ctx, model: id }),
      /not approved/,
    );
    await assert.rejects(f.approve([id]));
  }
  await assert.rejects(f.approve(["fixture/paid-v1"]), /Paid models/);
  await assert.rejects(f.approve([ID], { allowPaid: true }), /Invalid/);
  await assert.rejects(f.approve([ID], { models: [SECOND] }), /Invalid/);
  assert.equal(f.inference().length, 0);
});

test("every dispatch fixes the approved model and zero-price limits and exposes no caller-supplied routing", async (t) => {
  const f = await fixture(t, {
    responses: [
      stream({ actual: model().canonical_slug, content: "Verified ✓" }),
    ],
  });
  await f.service.catalogRefresh();
  await f.approve();
  let output = "";
  await f.service.completion({
    model: ID,
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
    maxTokens: 50,
    models: [SECOND],
    plugins: [{ id: "auto-router" }],
    onDelta: (delta) => {
      output += delta;
    },
  });
  const body = JSON.parse(f.inference()[0].options.body);
  assert.equal(body.model, ID);
  assert.equal(body.models, undefined);
  assert.equal(body.plugins, undefined);
  assert.deepEqual(body.provider, {
    require_parameters: true,
    max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
  });
  assert.equal(f.inference()[0].options.redirect, "error");
  assert.equal(output, "Verified ✓");
  const publicState =
    JSON.stringify(await f.service.settings()) +
    JSON.stringify(await f.service.inspect());
  assert.doesNotMatch(publicState, /sk-or-v1-fixture/);
});

test("streamed tool arguments and provider reasoning signatures survive a tool exchange", async (t) => {
  const events = [
    {
      model: ID,
      choices: [
        {
          delta: {
            reasoning_details: [
              {
                index: 0,
                type: "reasoning.text",
                text: "fixture ",
                signature: null,
              },
            ],
            tool_calls: [
              {
                index: 0,
                id: "split-call",
                function: { name: "read_file", arguments: '{"path":' },
              },
            ],
          },
        },
      ],
    },
    {
      model: ID,
      choices: [
        {
          delta: {
            reasoning_details: [
              {
                index: 0,
                type: "reasoning.text",
                text: "state",
                signature: "signed-",
              },
            ],
            tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }],
          },
        },
      ],
    },
    {
      model: ID,
      choices: [
        {
          delta: {
            reasoning_details: [
              { index: 0, type: "reasoning.text", signature: "fixture" },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { cost: 0 },
    },
  ];
  const f = await fixture(t, {
    responses: [
      new Response(
        events.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") +
          "data: [DONE]\n\n",
      ),
    ],
  });
  await f.service.catalogRefresh();
  await f.approve();
  let visible = "";
  const result = await f.service.completion({
    model: ID,
    messages: [],
    tools: [],
    maxTokens: 100,
    onDelta: (delta) => {
      visible += delta;
    },
  });
  assert.equal(
    result.message.tool_calls[0].function.arguments,
    '{"path":"a.txt"}',
  );
  assert.equal(result.message.reasoning_details[0].signature, "signed-fixture");
  assert.equal(result.message.reasoning_details[0].text, "fixture state");
  assert.equal(visible, "");
});

test("expired metadata, changed identity and changed prices stop requests before inference", async (t) => {
  let now = 0;
  const f = await fixture(t, { now: () => now });
  await f.service.catalogRefresh();
  await f.approve();
  f.models[0].canonical_slug = "fixture/replaced-model";
  await f.service.catalogRefresh();
  await assert.rejects(runOpenRouter(f.ctx), /identity changed/);
  f.models[0] = model();
  await f.service.catalogRefresh();
  now = 6 * 60 * 1000;
  f.models[0].pricing.completion = "0.001";
  await assert.rejects(
    f.service.completion({ model: ID, messages: [], tools: [], maxTokens: 10 }),
    /Zero pricing/,
  );
  assert.equal(f.inference().length, 0);
});

test("revocation while loading a key is rechecked before dispatch", async (t) => {
  let release, started;
  const loading = new Promise((r) => {
    started = r;
  });
  const f = await fixture(t, {
    credentials: {
      has: async () => true,
      read: () => {
        started();
        return new Promise((r) => {
          release = r;
        });
      },
    },
  });
  await f.service.catalogRefresh();
  await f.approve();
  const request = f.service.completion({
    model: ID,
    messages: [],
    tools: [],
    maxTokens: 10,
  });
  await loading;
  await f.approve([]);
  release("fake-fixture-key");
  await assert.rejects(request, /not approved|settings changed/);
  assert.equal(f.inference().length, 0);
});

test("revocation cancels a streaming turn and prevents queued work from dispatching", async (t) => {
  let started;
  const streaming = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, {
    responses: [
      (options) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ model: ID, choices: [{ index: 0, delta: { content: "Starting" } }] })}\n\n`,
                ),
              );
              options.signal.addEventListener(
                "abort",
                () => controller.error(new Error("Stopped fixture stream")),
                { once: true },
              );
              started();
            },
          }),
        ),
    ],
  });
  const controller = new Controller(f.store, {
    dataDir: f.directory,
    openrouter: f.service,
  });
  t.after(() => controller.close());
  await f.service.catalogRefresh();
  await f.approve();
  await controller.refreshOpenRouter();
  controller.send(f.ctx.chat.id, {
    actionId: "openrouter-streaming-turn",
    text: "Task",
    provider: "openrouter",
    model: ID,
    permissions: "override",
  });
  const task = controller.active.get(f.ctx.chat.id).task;
  await streaming;
  controller.send(f.ctx.chat.id, {
    actionId: "openrouter-queued-message",
    text: "Next task",
    provider: "openrouter",
    model: ID,
  });
  await f.approve([]);
  await task;
  assert.equal(f.inference().length, 1);
  assert.equal(
    f.store.conversationSnapshot(f.ctx.chat.id).runs[0].status,
    "cancelled",
  );
  assert.equal(f.store.queuedInputs(f.ctx.chat.id).length, 1);
});

test("tool follow-ups recheck pricing and malformed tool arguments cannot write files", async (t) => {
  const f = await fixture(t, {
    responses: [stream({ calls: [call("fixture_tool", {})] })],
  });
  await f.service.catalogRefresh();
  await f.approve();
  await assert.rejects(
    runOpenRouter({
      ...f.ctx,
      tools: [
        {
          name: "fixture_tool",
          description: "Fixture",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      history: async () => {
        f.service.catalog.get(ID).pricing.prompt = "1";
        return { done: true };
      },
    }),
    /Zero pricing/,
  );
  assert.equal(f.inference().length, 1);
  f.service.catalog.get(ID).pricing.prompt = "0";
  f.responses.push(
    stream({
      calls: [
        call("edit_file", {
          path: "never.txt",
          oldText: "",
          newText: "bad",
          unexpected: true,
        }),
      ],
    }),
    stream(),
  );
  await runOpenRouter(f.ctx);
  await assert.rejects(readFile(join(f.directory, "never.txt")), {
    code: "ENOENT",
  });
  assert.match(
    JSON.parse(f.inference().at(-1).options.body)
      .messages.filter((m) => m.role === "tool")
      .at(-1).content,
    /schema/,
  );
});

test("unexpected model identities, incomplete responses and unexpected costs never execute tools", async (t) => {
  for (const response of [
    stream({
      actual: SECOND,
      calls: [
        call("edit_file", { path: "never.txt", oldText: "", newText: "bad" }),
      ],
    }),
    stream({
      done: false,
      calls: [
        call("edit_file", { path: "never.txt", oldText: "", newText: "bad" }),
      ],
    }),
    stream({
      finish: "length",
      calls: [
        call("edit_file", { path: "never.txt", oldText: "", newText: "bad" }),
      ],
    }),
    stream({
      cost: 1,
      calls: [
        call("edit_file", { path: "never.txt", oldText: "", newText: "bad" }),
      ],
    }),
  ]) {
    const f = await fixture(t, { responses: [response] });
    await f.service.catalogRefresh();
    await f.approve();
    await assert.rejects(runOpenRouter(f.ctx), /unexpected|incomplete/);
    await assert.rejects(readFile(join(f.directory, "never.txt")), {
      code: "ENOENT",
    });
    assert.equal(f.inference().length, 1);
  }
});

test("streamed tool calls are validated and results persist for follow-ups and later turns", async (t) => {
  const f = await fixture(t, {
    responses: [
      stream({
        content: "Reading",
        calls: [call("read_file", { path: "hello.txt" })],
      }),
      stream(),
      stream(),
    ],
  });
  await writeFile(join(f.directory, "hello.txt"), "hello world");
  await f.service.catalogRefresh();
  await f.approve();
  await runOpenRouter(f.ctx);
  const followup = JSON.parse(f.inference()[1].options.body);
  assert.match(
    followup.messages.find((m) => m.role === "tool").content,
    /hello world/,
  );
  await runOpenRouter({ ...f.ctx, text: "Continue" });
  const resumed = JSON.parse(f.inference()[2].options.body);
  assert.equal(resumed.messages.filter((m) => m.role === "tool").length, 1);
  assert.equal(resumed.messages[0].role, "system");
  assert.match(JSON.stringify(resumed.messages.at(-1)), /Continue/);
});

test("Ask and Plan offer every tool but refuse edits even with Override", async (t) => {
  for (const mode of ["ask", "plan"]) {
    const f = await fixture(t, {
      responses: [
        stream({
          calls: [
            call("edit_file", {
              path: "never.txt",
              oldText: "",
              newText: "bad",
            }),
          ],
        }),
        stream(),
      ],
    });
    await f.service.catalogRefresh();
    await f.approve();
    await runOpenRouter({ ...f.ctx, mode, permissions: "override" });
    const sent = JSON.parse(f.inference()[0].options.body);
    // The same tools in every mode, so switching modes never removes one.
    assert.ok(sent.tools.some((t) => t.function.name === "edit_file"));
    assert.match(
      JSON.parse(f.inference()[1].options.body).messages.find(
        (m) => m.role === "tool",
      ).content,
      /unavailable/,
    );
    await assert.rejects(
      callOpenRouterFile({ ...f.ctx, mode }, "edit_file", {
        path: "never.txt",
        oldText: "",
        newText: "bad",
      }),
      /unavailable/,
    );
    await assert.rejects(readFile(join(f.directory, "never.txt")), {
      code: "ENOENT",
    });
  }
});

test("Plan mode keeps host tools offered and refuses changes until the plan is approved", async (t) => {
  const f = await fixture(t, {
    responses: [
      stream({ calls: [call("run_command", { command: "npm test" })] }),
      stream(),
    ],
  });
  await f.service.catalogRefresh();
  await f.approve();
  const called = [];
  await runOpenRouter({
    ...f.ctx,
    mode: "plan",
    tools: [commandTool],
    history: async (name) => {
      called.push(name);
      return { ok: true };
    },
  });
  const sent = JSON.parse(f.inference()[0].options.body);
  assert.ok(sent.tools.some((t) => t.function.name === "run_command"));
  assert.match(
    JSON.parse(f.inference()[1].options.body).messages.find(
      (m) => m.role === "tool",
    ).content,
    /after the plan is approved/,
  );
  assert.deepEqual(called, []);
});

test("file tools enforce worktree boundaries, private paths, upstream read-only and review decisions", async (t) => {
  const f = await fixture(t);
  await f.service.catalogRefresh();
  await f.approve();
  const worktree = join(f.directory, "worktree"),
    upstream = join(f.directory, "upstream");
  await mkdir(worktree);
  await mkdir(upstream);
  await writeFile(join(worktree, "a.txt"), "old");
  await writeFile(join(upstream, "source.txt"), "upstream source");
  const ctx = {
    ...f.ctx,
    project: { path: worktree, repositories: [{ path: upstream }] },
  };
  assert.match(
    (
      await callOpenRouterFile(ctx, "read_file", {
        repository: 1,
        path: "source.txt",
      })
    ).text,
    /upstream source/,
  );
  for (const path of [
    "../upstream/source.txt",
    ".env",
    ".git/config",
    ".aws/credentials",
    "secrets/openrouter.dpapi",
    "a.txt:stream",
  ]) {
    await assert.rejects(callOpenRouterFile(ctx, "read_file", { path }));
  }
  await assert.rejects(
    callOpenRouterFile(ctx, "edit_file", {
      repository: 1,
      path: "source.txt",
      oldText: "upstream",
      newText: "changed",
    }),
    /read-only/,
  );
  await symlink(
    upstream,
    join(worktree, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    callOpenRouterFile(ctx, "read_file", { path: "escape/source.txt" }),
    /outside/,
  );
  await assert.rejects(
    callOpenRouterFile(ctx, "edit_file", {
      path: "escape/new.txt",
      oldText: "",
      newText: "bad",
    }),
    /outside/,
  );
  await mkdir(join(worktree, ".aws"));
  await writeFile(join(worktree, ".aws", "credentials"), "private fixture");
  await symlink(
    join(worktree, ".aws"),
    join(worktree, "private-alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    callOpenRouterFile(ctx, "read_file", { path: "private-alias/credentials" }),
    /private/,
  );
  const declined = await callOpenRouterFile(
    {
      ...ctx,
      approve: async () => ({ allow: false, reason: "declined fixture" }),
    },
    "edit_file",
    { path: "a.txt", oldText: "old", newText: "new" },
  );
  assert.equal(declined.declined, true);
  assert.equal(await readFile(join(worktree, "a.txt"), "utf8"), "old");
  await callOpenRouterFile(ctx, "edit_file", {
    path: "a.txt",
    oldText: "old",
    newText: "new $&",
  });
  assert.equal(await readFile(join(worktree, "a.txt"), "utf8"), "new $&");
});

test("interrupted tools are reconciled without replaying the command", async (t) => {
  const f = await fixture(t, { responses: [stream()] });
  await f.service.catalogRefresh();
  await f.approve();
  f.store.db
    .prepare(
      "INSERT INTO openrouter_sessions(conversation_id,state) VALUES(?,?)",
    )
    .run(
      f.ctx.chat.id,
      JSON.stringify({
        messages: [
          { role: "user", content: "Earlier task" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              call("run_command", { command: "previously completed" }),
            ],
          },
          {
            role: "tool",
            tool_call_id: "tool-1",
            content: "completed earlier",
          },
          { role: "user", content: "Task" },
          {
            role: "assistant",
            content: "",
            tool_calls: [call("run_command", { command: "never replay" })],
          },
        ],
        pendingTool: { id: "tool-1", name: "run_command" },
      }),
    );
  let commands = 0;
  await runOpenRouter({
    ...f.ctx,
    history: async () => {
      commands++;
    },
  });
  assert.equal(commands, 0);
  const sent = JSON.parse(f.inference()[0].options.body);
  assert.match(
    sent.messages.filter((m) => m.role === "tool").at(-1).content,
    /may have executed/,
  );
});

test("server admission and queued work recheck approval independently of the model picker", async (t) => {
  const f = await fixture(t),
    controller = new Controller(f.store, {
      dataDir: f.directory,
      openrouter: f.service,
    });
  t.after(async () => {
    await controller.close();
  });
  await f.service.catalogRefresh();
  await f.approve();
  await controller.refreshOpenRouter();
  controller.providers[0].models.push({ id: SECOND, efforts: [] }); // forged/stale UI catalog
  assert.throws(
    () =>
      controller.prepareSend(f.ctx.chat.id, {
        actionId: "openrouter-forged-model",
        provider: "openrouter",
        model: SECOND,
        text: "Task",
      }),
    /not approved/,
  );
  await f.approve([]);
  assert.throws(() =>
    controller.send(f.ctx.chat.id, {
      actionId: "openrouter-revoked-model",
      provider: "openrouter",
      model: ID,
      text: "Task",
    }),
  );
  assert.equal(f.inference().length, 0);
});

test("provider instructions and execution restrictions stay separate from subscription integrations", () => {
  const project = { path: "C:\\fixture", repositories: [] };
  const openrouter = agentInstructions(project, {
    id: "test",
    provider: "openrouter",
    scope: "all",
  });
  const codex = agentInstructions(project, {
    id: "test",
    provider: "codex",
    scope: "all",
  });
  assert.match(openrouter, /server-approved free model/);
  assert.doesNotMatch(
    openrouter,
    /Use only the current subscription integration/,
  );
  assert.match(codex, /Use only the current subscription integration/);
  assert.throws(() => checkMode("goal", "openrouter"), /Default, Ask and Plan/);
  assert.deepEqual(
    subscriptionEnvironment(
      { OPENROUTER_API_KEY: "fixture", PATH: "tools" },
      { platform: "linux" },
    ),
    { PATH: "tools" },
  );
});

test(
  "Windows key storage encrypts fixture credentials and supports replacement/removal",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "harness-openrouter-key-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const credentials = new OpenRouterCredentials(directory),
      key = "sk-or-v1-this-is-only-a-fixture-key";
    assert.equal(await credentials.has(), false);
    await credentials.write(key);
    assert.equal(await credentials.read(), key);
    assert.ok(!(await readFile(credentials.path, "utf8")).includes(key));
    await credentials.write(key + "-replacement");
    assert.equal(await credentials.read(), key + "-replacement");
    await credentials.remove();
    assert.equal(await credentials.has(), false);
  },
);
