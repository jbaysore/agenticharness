import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server.mjs";

test("OpenRouter setup uses authenticated routes, requires consent, and keeps keys out of public state and backups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-openrouter-http-"));
  const id = "fixture/coder-v1:free",
    key = "sk-or-v1-fixture-key-for-http-tests";
  let storedKey = null,
    inference = 0;
  const models = [
    {
      id,
      canonical_slug: "fixture/coder-20261026",
      name: "Fixture Coder",
      context_length: 131072,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["tools"],
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    },
  ];
  const options = {
    credentials: {
      has: async () => !!storedKey,
      read: async () => storedKey,
      write: async (value) => {
        storedKey = value;
      },
      remove: async () => {
        storedKey = null;
      },
    },
    fetch: async (url) => {
      if (url.endsWith("/models")) return Response.json({ data: models });
      if (url.endsWith("/key"))
        return Response.json({
          data: { free_model_daily_requests: { remaining: 48, limit: 50 } },
        });
      inference++;
      return new Response(
        `data: ${JSON.stringify({ model: id, choices: [{ index: 0, delta: { content: "Fixture complete" }, finish_reason: "stop" }], usage: { cost: 0 } })}\n\ndata: [DONE]\n\n`,
      );
    },
  };
  let app = await createHarness({
    dataDir: directory,
    port: 0,
    startProviders: false,
    openrouterOptions: options,
  });
  app.controller.browser = null;
  const call = async (
    path,
    body,
    method = body === undefined ? "GET" : "POST",
    headers = {},
  ) => {
    const response = await fetch(app.runtime.origin + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Harness-Client": "1",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const initial = await call("/api/providers/openrouter");
    assert.equal(initial.body.enabled, false);
    assert.equal(initial.body.keyConfigured, false);
    const noHeader = await fetch(
      app.runtime.origin + "/api/providers/openrouter",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(noHeader.status, 403);
    assert.equal(
      (
        await call("/api/providers/openrouter", {}, "PUT", {
          Origin: "https://untrusted.example",
        })
      ).status,
      403,
    );
    await call("/api/providers/openrouter/catalog", {});
    const config = {
      revision: 0,
      enabled: true,
      dataConsent: false,
      allowedModels: [id],
      apiKey: key,
    };
    assert.equal(
      (await call("/api/providers/openrouter", config, "PUT")).status,
      400,
    );
    assert.equal(storedKey, null);
    const approved = await call(
      "/api/providers/openrouter",
      { ...config, dataConsent: true },
      "PUT",
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.body.keyConfigured, true);
    assert.equal(inference, 0);
    const project = app.store.addProject("Fixture", directory);
    const chat = (
      await call("/api/chats", {
        projectId: project.id,
        provider: "openrouter",
        model: id,
      })
    ).body;
    const send = {
      actionId: "openrouter-http-test-message",
      provider: "openrouter",
      model: "fixture/not-approved:free",
      text: "Fixture task",
      permissions: "override",
    };
    assert.equal(
      (await call(`/api/chats/${chat.id}/messages`, send)).status,
      400,
    );
    assert.equal(inference, 0);
    assert.equal(
      (await call(`/api/chats/${chat.id}/messages`, { ...send, model: id }))
        .status,
      202,
    );
    await app.controller.active.get(chat.id)?.task;
    assert.equal(inference, 1);
    assert.equal(
      app.store.conversationSnapshot(chat.id).runs[0].status,
      "completed",
    );
    assert.match(
      JSON.stringify((await call(`/api/chats/${chat.id}`)).body),
      /Fixture complete/,
    );
    for (const path of [
      "/api/state",
      "/api/providers/openrouter",
      "/api/export",
    ]) {
      assert.ok(!JSON.stringify((await call(path)).body).includes(key), path);
    }
    const backup = await call("/api/backup", {});
    assert.equal(backup.status, 201);
    const { readFile } = await import("node:fs/promises");
    assert.ok(!(await readFile(backup.body.path)).includes(Buffer.from(key)));
    await app.close();
    app = await createHarness({
      dataDir: directory,
      port: 0,
      startProviders: false,
      openrouterOptions: options,
    });
    const restored = (await call("/api/providers/openrouter")).body;
    assert.equal(restored.enabled, true);
    assert.equal(restored.dataConsent, true);
    assert.equal(restored.allowedModels[0].id, id);
    await app.controller.openrouter.catalogRefresh();
    await app.controller.refreshOpenRouter();
    const removed = await call(
      "/api/providers/openrouter",
      {
        revision: restored.revision,
        enabled: false,
        dataConsent: false,
        allowedModels: [],
        removeKey: true,
      },
      "PUT",
    );
    assert.equal(removed.status, 200);
    assert.equal(storedKey, null);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
