import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { browseDirectories } from "../src/core/directories.mjs";
import { createHarness } from "../src/server.mjs";

test("directory browsing lists immediate folders, including junctions, with canonical navigation", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "harness-folder-list-"));
  try {
    for (const folder of [
      "z-last",
      "Folder 10",
      "Folder 2",
      "A space & Ω",
      ".hidden",
    ])
      await fs.mkdir(join(dir, folder));
    await fs.mkdir(join(dir, "Folder 2", "deeper"));
    await fs.writeFile(join(dir, "file.txt"), "Not a folder");
    await fs.symlink(
      join(dir, "Folder 2"),
      join(dir, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const listing = await browseDirectories(join(dir, "Folder 2", ".."));
    assert.equal(listing.path, await fs.realpath(dir));
    assert.deepEqual(
      listing.directories.map((entry) => entry.name),
      [".hidden", "A space & Ω", "Folder 2", "Folder 10", "link", "z-last"],
    );
    assert.equal(listing.breadcrumbs.at(-1).path, listing.path);
    assert.equal(listing.breadcrumbs.at(-2).path, listing.parent);
    assert.equal(listing.roots[0].path, homedir());
    const linked = await browseDirectories(join(dir, "link"));
    assert.equal(linked.path, await fs.realpath(join(dir, "Folder 2")));
    assert.deepEqual(
      linked.directories.map((entry) => entry.name),
      ["deeper"],
    );
    assert.deepEqual(
      (await browseDirectories(join(dir, "Folder 2", "deeper"))).directories,
      [],
    );
    const root = await browseDirectories(parse(dir).root);
    assert.equal(root.parent, null);
    assert.equal(root.breadcrumbs.length, 1);
    assert.ok(root.roots.some((entry) => entry.path === parse(dir).root));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("directory browsing rejects invalid paths and reports permission errors without exposing contents", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "harness-folder-errors-"));
  try {
    const file = join(dir, "file.txt");
    await fs.writeFile(file, "private content");
    for (const path of [null, "", "relative/path", "bad\0path"])
      await assert.rejects(browseDirectories(path), /absolute folder path/);
    await assert.rejects(browseDirectories(file), /folder, not a file/);
    await assert.rejects(
      browseDirectories(join(dir, "missing")),
      /unavailable/,
    );
    for (const code of ["EACCES", "EPERM"])
      await assert.rejects(
        browseDirectories(dir, {
          ...fs,
          readdir: async () => {
            throw Object.assign(new Error("private details"), { code });
          },
        }),
        /permission to access/,
      );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("folder listing uses existing host, pairing, and origin checks and does not register projects", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "harness-folder-http-"));
  const app = await createHarness({
    dataDir: join(dir, "data"),
    port: 0,
    startProviders: false,
  });
  try {
    const folder = join(dir, "A space # & Ω");
    await fs.mkdir(folder);
    const endpoint =
      "/api/directories?" + new URLSearchParams({ path: folder });
    const get = (headers = {}, path = endpoint) =>
      fetch(app.runtime.origin + path, { headers });
    const listing = await get();
    assert.equal(listing.status, 200);
    assert.equal(listing.headers.get("cache-control"), "no-store");
    assert.equal((await listing.json()).path, await fs.realpath(folder));
    const home = await get({}, "/api/directories");
    assert.equal((await home.json()).path, await fs.realpath(homedir()));
    assert.equal((await get({}, "/api/directories?path=relative")).status, 400);
    assert.equal((await get({}, "/api/directories?path=")).status, 400);
    const remote = { "Cf-Connecting-IP": "203.0.113.9" };
    assert.equal((await get(remote)).status, 401);
    const token = app.auth.pair(app.auth.pairing(), "fixture");
    assert.equal(
      (await get({ ...remote, cookie: `harness_session=${token}` })).status,
      200,
    );
    assert.equal((await get({ Origin: "https://evil.example" })).status, 403);
    assert.equal((await get({ "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.deepEqual(app.store.projects(), []);
    assert.deepEqual(app.store.conversations(), []);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
