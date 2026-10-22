import test from "node:test";
import assert from "node:assert/strict";
import { activeTab, terminalGroups } from "../src/ui/terminal-groups.mjs";

const tab = (id, groupId, title) => ({
  id,
  groupId,
  groupTitle: "Terminal " + groupId,
  projectId: "p",
  title,
});

test("sessions gather into windows in the order they opened", () => {
  const groups = terminalGroups([
    tab("a", "1", "PowerShell 1"),
    tab("b", "2", "Command Prompt 1"),
    tab("c", "1", "Command Prompt 1"),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.id, g.title, g.tabs.map((t) => t.id)]),
    [
      ["1", "Terminal 1", ["a", "c"]],
      ["2", "Terminal 2", ["b"]],
    ],
  );
  assert.deepEqual(terminalGroups(), []);
});
test("the chosen tab shows while it exists, otherwise the newest", () => {
  const [group] = terminalGroups([tab("a", "1", "x"), tab("b", "1", "y")]);
  assert.equal(activeTab(group, "a").id, "a");
  assert.equal(activeTab(group, "gone").id, "b");
  assert.equal(activeTab(group, null).id, "b");
  assert.equal(activeTab(undefined, "a"), undefined);
});
