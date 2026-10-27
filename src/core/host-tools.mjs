import { historyTools, textHash } from "./history.mjs";
import { askUserTool } from "./questions.mjs";
import { commandTool } from "./command-tool.mjs";
import { modeSuggestionTool } from "./modes.mjs";
import { landTool } from "./worktrees.mjs";
import { restartTool } from "./self-restart.mjs";

// Harness's own tools, offered to every agent in every mode. A mode or a
// chat's situation decides what a call may do when it is made, not which
// tools exist: a native session that cannot add tools when it resumes would
// otherwise keep the narrower set it started with.
export const hostTools = [
  ...historyTools,
  askUserTool,
  commandTool,
  modeSuggestionTool,
  landTool,
  restartTool,
];

// A Codex thread keeps the tools it started with. A thread started under a
// different set is replaced once, with a handoff, instead of resumed.
export const hostToolsKey = textHash(
  hostTools.map((tool) => tool.name).join("\n"),
);
