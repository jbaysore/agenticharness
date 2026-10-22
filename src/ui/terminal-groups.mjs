// A terminal window is a group of shell sessions, one per tab. The host lists
// sessions; this gathers them back into windows in the order they opened.
export const SHELL_CHOICES = [
  ["powershell", "PowerShell"],
  ["cmd", "Command Prompt"],
];
export function terminalGroups(sessions = []) {
  const groups = new Map();
  for (const s of sessions) {
    let group = groups.get(s.groupId);
    if (!group) {
      group = {
        id: s.groupId,
        title: s.groupTitle,
        projectId: s.projectId,
        tabs: [],
      };
      groups.set(s.groupId, group);
    }
    group.tabs.push(s);
  }
  return [...groups.values()];
}
// The tab to show: the chosen one while it exists, otherwise the newest.
export function activeTab(group, chosenId) {
  return group?.tabs.find((t) => t.id === chosenId) ?? group?.tabs.at(-1);
}
