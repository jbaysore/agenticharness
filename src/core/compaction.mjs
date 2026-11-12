// Compaction stays the provider's own action. Harness only tells the summary
// what must survive and, for a Goal, hands back a checkpoint built from its
// own records afterwards. No model call is made for either.

export const CLAUDE_AUTO_COMPACT_WINDOW = 600_000;
export const CHECKPOINT_MAX = 4000;

export const COMPACTION_GUIDANCE = `Harness compaction guidance. Keep these in the summary, exactly where they matter:
- The user's binding objective and every acceptance condition, in their words.
- Decisions made and why, including approaches that were tried and rejected.
- Files created or changed, and what remains uncommitted or unlanded.
- The latest test and check results, with the exact command and outcome.
- Open blockers, questions waiting on the user, and anything promised but not done.
- The exact next step that was about to be taken.
Drop tool output that has already been acted on. Harness will add its own checkpoint after compaction; where they differ, the checkpoint's phase status is current.`;

const clip = (text, max) => {
  const value = String(text ?? "").trim().replace(/\s+/g, " ");
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
};

// Every part is optional; whatever Harness could not read is left out.
export function goalCheckpoint({
  progress,
  checks = [],
  watches = [],
  ownerPause = null,
  repository = null,
  feedback = [],
} = {}) {
  const lines = ["Harness Goal checkpoint (from Harness records, after compaction)."];
  if (progress?.goalId) lines.push(`Goal ID: ${progress.goalId}`);
  if (progress?.phases?.length) {
    lines.push("Phases:");
    for (const phase of progress.phases.slice(0, 30))
      lines.push(`- [${phase.status}] ${clip(phase.label, 200)}`);
    if (progress.explanation) lines.push(`Latest progress note: ${clip(progress.explanation, 400)}`);
  }
  if (checks.length) {
    lines.push("Latest recorded checks:");
    for (const check of checks.slice(0, 4))
      lines.push(`- ${check.outcome}: ${clip(check.command, 160)}${check.freshness ? ` (${check.freshness})` : ""}`);
  }
  if (watches.length) {
    lines.push("Active watches:");
    for (const watch of watches.slice(0, 6))
      lines.push(`- ${watch.id} ${watch.kind ?? ""} ${watch.status ?? ""}${watch.label ? `: ${clip(watch.label, 120)}` : ""}`.replace(/\s+/g, " "));
  }
  if (ownerPause?.statement) lines.push(`Waiting on the owner: ${clip(ownerPause.statement, 300)}`);
  if (repository) {
    lines.push(`Repository: branch ${repository.branch}${repository.head ? ` at ${repository.head.slice(0, 10)}` : ""}`);
    const changes = repository.changes ?? [];
    if (changes.length) {
      lines.push(`Uncommitted changes (${changes.length}):`);
      for (const change of changes.slice(0, 25)) lines.push(`- ${change.status.trim() || "?"} ${change.file}`);
      if (changes.length > 25) lines.push(`- …and ${changes.length - 25} more`);
    } else lines.push("No uncommitted changes.");
  }
  if (feedback.length) {
    lines.push("Recent user messages:");
    for (const text of feedback.slice(-3)) lines.push(`- ${clip(text, 400)}`);
  }
  lines.push("Re-read the binding objective in your instructions. This checkpoint is current for phase status; confirm anything else against the repository before relying on it.");
  const text = lines.join("\n");
  return text.length > CHECKPOINT_MAX ? text.slice(0, CHECKPOINT_MAX - 1) + "…" : text;
}
