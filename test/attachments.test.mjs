import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server.mjs";
import { attachmentPath, MAX_FILE_SIZE } from "../src/core/attachments.mjs";
import { handoffContext, historyCall } from "../src/core/history.mjs";
import {
  claudeContent,
  codexInput,
  cursorPrompt,
} from "../src/providers/attachments.mjs";

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

test("uploads persist, reach the agent and history, and attachment-only sends retry exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-attachments-"));
  let app = await createHarness({
    dataDir: dir,
    port: 0,
    startProviders: false,
  });
  const request = (path, body, headers = {}) =>
    fetch(app.runtime.origin + path, {
      method: "POST",
      headers: { "X-Harness-Client": "1", ...headers },
      body,
    });
  const upload = (project, name, bytes, headers) =>
    request(`/api/projects/${project.id}/attachments`, bytes, {
      "X-Harness-Filename": encodeURIComponent(name),
      ...headers,
    });
  try {
    const project = app.store.addProject("Attachments", dir),
      chat = app.store.createConversation({ projectId: project.id });
    const imageResponse = await upload(project, "screen.png", pixel);
    assert.equal(imageResponse.status, 201);
    const image = await imageResponse.json();
    assert.equal(image.type, "image/png");
    const doc = await (
      await upload(project, "notes.txt", "Evidence in a file")
    ).json();
    assert.equal(doc.type, "application/octet-stream");
    assert.equal(
      (
        await readFile(attachmentPath(dir, app.store.attachment(doc.id)))
      ).toString(),
      "Evidence in a file",
    );
    app.controller.providers = [
      { id: "codex", models: [{ id: "fixture", efforts: [] }] },
    ];
    let seen;
    app.controller.runners.codex = async (ctx) => {
      seen = ctx;
      return { status: "completed" };
    };
    const body = {
      actionId: "attachment-only-test-123",
      text: "",
      provider: "codex",
      model: "fixture",
      attachments: [image.id, doc.id],
    };
    const sent = await request(
      `/api/chats/${chat.id}/messages`,
      JSON.stringify(body),
      { "Content-Type": "application/json" },
    );
    assert.equal(sent.status, 202);
    const run = await sent.json();
    await app.controller.active.get(chat.id)?.task;
    assert.match(seen.text, /screen\.png/);
    assert.match(seen.text, /notes\.txt/);
    assert.equal(seen.attachments.length, 2);
    assert.equal(
      seen.attachments[0].path,
      attachmentPath(dir, app.store.attachment(image.id)),
    );
    assert.deepEqual(app.store.messages(chat.id)[0].attachments, [image, doc]);
    assert.equal(app.store.messages(chat.id)[0].content, "");
    const history = await seen.history("history_read", {
      conversationId: chat.id,
    });
    assert.equal(
      history.messages[0].attachments[0].path,
      seen.attachments[0].path,
    );
    assert.equal(app.store.conversation(chat.id).title, "screen.png");
    assert.equal(
      historyCall(app.store, chat.id, "rename_chat", {
        title: "Review attached evidence",
      }).renamed,
      true,
    );
    const duplicate = await (
      await request(`/api/chats/${chat.id}/messages`, JSON.stringify(body), {
        "Content-Type": "application/json",
      })
    ).json();
    assert.equal(duplicate.id, run.id);
    assert.equal(duplicate.duplicate, true);
    assert.equal(app.store.messages(chat.id).length, 1);

    assert.deepEqual(codexInput(seen).at(-1), {
      type: "localImage",
      path: seen.attachments[0].path,
    });
    const claude = await claudeContent(seen);
    assert.equal(claude.length, 2);
    assert.deepEqual(claude[1].source, {
      type: "base64",
      media_type: "image/png",
      data: pixel.toString("base64"),
    });
    const cursor = await cursorPrompt(seen, { image: true });
    assert.equal(cursor.length, 2);
    assert.equal(cursor[1].data, pixel.toString("base64"));
    assert.equal((await cursorPrompt(seen, { image: false })).length, 1);
    app.store.addMessage({
      conversationId: chat.id,
      role: "user",
      content: "Continue with another agent",
    });
    assert.match(
      handoffContext(app.store, app.store.conversation(chat.id), "claude", dir),
      /notes\.txt/,
    );

    await app.close();
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false });
    assert.deepEqual(app.store.messages(chat.id)[0].attachments, [image, doc]);
    const fetched = await fetch(app.runtime.origin + image.url);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), pixel);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachment endpoints enforce origin, authentication, project ownership, size and safe downloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-upload-security-")),
    app = await createHarness({ dataDir: dir, port: 0, startProviders: false });
  const post = (path, bytes, headers = {}) =>
    fetch(app.runtime.origin + path, {
      method: "POST",
      headers: {
        "X-Harness-Client": "1",
        "X-Harness-Filename": "file.txt",
        ...headers,
      },
      body: bytes,
    });
  try {
    const project = app.store.addProject("Uploads", dir),
      path = `/api/projects/${project.id}/attachments`;
    assert.equal(
      (await post(path, "x", { Origin: "https://evil.example" })).status,
      403,
    );
    assert.equal(
      (await post(path, "x", { "X-Harness-Client": "" })).status,
      403,
    );
    assert.equal(
      (await post(path, "x", { "Cf-Connecting-IP": "203.0.113.9" })).status,
      401,
    );
    assert.equal(
      (await post("/api/projects/missing/attachments", "x")).status,
      400,
    );
    for (const name of ["", "..", "NUL.txt", "%ZZ"]) {
      assert.equal(
        (await post(path, "x", { "X-Harness-Filename": name })).status,
        400,
      );
    }
    assert.equal(
      (await post(path, Buffer.alloc(MAX_FILE_SIZE + 1))).status,
      400,
    );
    const file = await (
      await post(path, "<html>unsafe</html>", {
        "X-Harness-Filename": encodeURIComponent("../../report.html"),
        "Content-Type": "image/png",
      })
    ).json();
    assert.equal(file.name, "report.html");
    const download = await fetch(app.runtime.origin + file.url);
    assert.equal(
      download.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.match(download.headers.get("content-disposition"), /^attachment;/);
    assert.match(download.headers.get("cache-control"), /private, no-store/);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    const head = await fetch(app.runtime.origin + file.url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await post(file.url, "")).status, 405);
    assert.equal(
      (
        await fetch(app.runtime.origin + file.url, {
          headers: { "Cf-Connecting-IP": "203.0.113.9" },
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(app.runtime.origin + "/api/attachments/..%5Csecret")).status,
      404,
    );
    const other = app.store.addProject("Other", join(dir, "other")),
      chat = app.store.createConversation({ projectId: other.id });
    const body = {
      text: "",
      actionId: "invalid-attachment-check",
      provider: "codex",
      model: "fixture",
    };
    for (const attachments of [
      [file.id],
      ["../../secret"],
      [file.id, file.id],
      Array(11).fill(file.id),
      "file",
    ]) {
      assert.throws(
        () => app.controller.send(chat.id, { ...body, attachments }),
        /Attachment|attachment|Attach/,
      );
    }
    assert.equal(app.store.messages(chat.id).length, 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
