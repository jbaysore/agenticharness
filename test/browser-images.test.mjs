import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenshotLinks } from "../src/core/browser-images.mjs";
import { createHarness } from "../src/server.mjs";

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7VQAAAAASUVORK5CYII=",
  "base64",
);

test("screenshot tool output includes a short, clickable image URL without repeating bytes", () => {
  const output = join(tmpdir(), "browser", "output");
  for (const file of [
    "output\\page-test.png",
    "output/page-test.png",
    join(output, "page-test.png"),
  ]) {
    const result = {
      content: [
        { type: "text", text: `- [Screenshot of viewport](${file})` },
        { type: "image", data: "original-image-bytes", mimeType: "image/png" },
      ],
    };
    const linked = screenshotLinks(result, output);
    assert.deepEqual(linked.content.slice(0, 2), result.content);
    assert.match(
      linked.content[2].text,
      /\[!\[Browser screenshot\]\(\/api\/browser\/screenshots\/page-test.png\)\]\(\/api\/browser\/screenshots\/page-test.png\)/,
    );
    assert.doesNotMatch(linked.content[2].text, /original-image-bytes/);
  }
  for (const file of [
    "output/page.yml",
    "output/../secret.png",
    "https://example.com/page.png",
    join(tmpdir(), "elsewhere.png"),
  ]) {
    const result = { content: [{ type: "text", text: `[File](${file})` }] };
    assert.equal(screenshotLinks(result, output), result);
  }
});

test("screenshots are served as authenticated images, with HEAD support and no path escape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-screenshots-"));
  const output = join(dir, "browser", "output");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "page-test.png"), pixel);
  await writeFile(join(output, "snapshot.yml"), "not an image");
  await writeFile(join(dir, "outside.png"), pixel);
  const app = await createHarness({
    dataDir: dir,
    port: 0,
    startProviders: false,
  });
  const url = app.runtime.origin + "/api/browser/screenshots/";
  try {
    const image = await fetch(url + "page-test.png");
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.match(image.headers.get("cache-control"), /private, no-store/);
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), pixel);
    const head = await fetch(url + "page-test.png", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get("content-length")), pixel.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(
      (
        await fetch(url + "page-test.png", {
          method: "POST",
          headers: { "X-Harness-Client": "1" },
        })
      ).status,
      405,
    );
    assert.equal(
      (
        await fetch(url + "page-test.png", {
          headers: { "Cf-Connecting-IP": "203.0.113.9" },
        })
      ).status,
      401,
    );
    const paired = await fetch(app.runtime.origin + "/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Harness-Client": "1" },
      body: JSON.stringify({ code: app.auth.pairing() }),
    });
    const cookie = paired.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (
        await fetch(url + "page-test.png", {
          headers: { cookie, "Cf-Connecting-IP": "203.0.113.9" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(url + "page-test.png", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    for (const name of [
      "missing.png",
      "snapshot.yml",
      "..%2Foutside.png",
      "..%5Coutside.png",
      "%00.png",
      "%ZZ.png",
    ]) {
      assert.equal((await fetch(url + name)).status, 404, name);
    }
    // A junction can be made without Windows symlink privileges. Even a PNG
    // filename pointing through that directory must not open a sibling file.
    await symlink(
      dir,
      join(output, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal((await fetch(url + "escape%2Foutside.png")).status, 404);
    await rm(join(output, "escape"));
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
