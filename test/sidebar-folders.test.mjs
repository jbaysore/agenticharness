import test from "node:test";
import assert from "node:assert/strict";
import {
  changeFolders,
  openFolderIds,
  readExpandedFolders,
  toggleFolder,
} from "../src/ui/sidebar-folders.mjs";

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
