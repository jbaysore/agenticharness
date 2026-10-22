import test from "node:test";
import assert from "node:assert/strict";
import {
  changeFolders,
  folderPage,
  openFolderIds,
  readExpandedFolders,
  toggleFolder,
} from "../src/ui/sidebar-folders.mjs";

test("folder pages start at six and double, capping the final increment", () => {
  assert.deepEqual(folderPage(80), { visible: 6, more: 6, next: 12 });
  assert.deepEqual(folderPage(80, 12), { visible: 12, more: 12, next: 24 });
  assert.deepEqual(folderPage(80, 24), { visible: 24, more: 24, next: 48 });
  assert.deepEqual(folderPage(53, 48), { visible: 48, more: 5, next: 96 });
  assert.deepEqual(folderPage(53, 96), { visible: 53, more: 0, next: 192 });
  assert.deepEqual(folderPage(0), { visible: 0, more: 0, next: 12 });
});

test("a missing or broken folder preference opens only the selected project", () => {
  assert.equal(readExpandedFolders(null), null);
  assert.equal(readExpandedFolders(""), null);
  assert.equal(readExpandedFolders("not json"), null);
  assert.equal(readExpandedFolders("{}"), null);
  assert.deepEqual(openFolderIds(null, "main"), ["main"]);
  assert.deepEqual(openFolderIds(null, ""), []);
});

test("an explicit folder list is kept, including when every folder is collapsed", () => {
  assert.deepEqual(readExpandedFolders('{"expanded":[]}'), []);
  assert.deepEqual(readExpandedFolders('{"expanded":["a","a",1,"","b"]}'), [
    "a",
    "b",
  ]);
  assert.deepEqual(openFolderIds([], "main"), []);
  assert.deepEqual(openFolderIds(["other"], "main"), ["other"]);
});

test("each folder can be collapsed or expanded without closing the others", () => {
  assert.deepEqual(toggleFolder(["main"], "other"), ["main", "other"]);
  assert.deepEqual(toggleFolder(["main", "other"], "main"), ["other"]);
  assert.equal(changeFolders(null, "main", "main", "expand"), null);
  assert.deepEqual(changeFolders(null, "main", "other", "toggle"), [
    "main",
    "other",
  ]);
  assert.deepEqual(changeFolders(null, "main", "main", "toggle"), []);
  assert.deepEqual(changeFolders(["other"], "main", "main", "expand"), [
    "other",
    "main",
  ]);
  assert.deepEqual(changeFolders([], "main", "main", "expand"), ["main"]);
});
