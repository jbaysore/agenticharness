# Dogfooding backlog

## Next acceptance action

1. On the physical Windows laptop and iPhone, verify the same chat and response,
   send from each device, review a diff, answer a fixture approval, then disconnect
   and reconnect. Private HTTPS and emulated layouts already pass. This is the
   outstanding completion criterion, not an inferred success.

## Reliability and daily friction

2. Extend the passing real Codex host-crash test to long-running shell tools and
   native child agents for all providers. Partial response recovery, intentional
   continuation and action deduplication have already passed an actual host kill.
3. Investigate the existing Codex Windows ACL setup failure upstream. Keep
   approval-backed recovery explicit while the native sandbox issue remains.
   Track the node-pty AttachConsole shutdown warning too; keep the verified
   system-console cleanup until the library fixes its helper race.
4. Replace Cursor's manual on-demand confirmation when ACP exposes authoritative
   billing and quota information. Until then keep the account-level on-demand-off
   boundary and honest unavailable meter. The saved confirmation does not expire.
5. Add optional start-at-login, a tray indicator, and a signed installer/updater.
   No startup service or recurring service cost is required by this release.
6. Extend the tested reload-safe outbox to explicit queued drafts across browser
   tabs. Current tab session storage retains an uncertain action ID and reconciles
   it against the server before restoring the draft or showing its accepted run.

## Product improvements

7. Rename/archive projects and delete chats from the UI, and add more keyboard
   shortcuts. Chats can be renamed and archived, panels collapse and resize, and
   Alt+1/2/3 moves between side-by-side chats.
8. Group tool events into one updating card and make native subagent progress
   easier to scan. Keep provider-managed work distinct from app orchestration.
9. Resolve/retire individual review comments and navigate deleted-line anchors.
   Current comments target new-side lines and preserve their reviewed diff hash.
10. Add image/PDF artifact previews and pinned file versions. Current artifacts
    reference live files and the browser previews bounded text only.
11. Add JSON restore for an exported Harness history file. Local Cursor, Codex,
    and Claude transcript import is available and keeps the provider label without
    resuming those native sessions. SQLite restore already covers app-owned state.
12. Improve long-history paging with per-message offsets and explicit handoff
    truncation notices. Add deterministic repository evidence freshness checks.

## Multi-chat follow-ups

13. Run two real turns at once and record the result: two providers in the
    `.local/dogfood-project` fixture that both commit, confirming neither commit
    holds the other's files, and two simultaneous Cursor turns. Cursor's worker
    lock has not been tested with concurrent sessions; if it refuses, add a
    per-provider limit in `Controller.send` with a clear message. Both checks use
    included subscription usage. Everything verified so far used a simulated
    provider.
14. Worktree follow-ups. A worktree is removed only once all its work has
    landed, so a chat that leaves uncommitted or unlanded work keeps its folder
    until that work lands or is discarded; nothing yet surfaces those. A new
    worktree links `node_modules` from the project folder but gets no `.env` or
    local databases, and an `npm install` in it changes the shared
    `node_modules`. Codex's workspace-write sandbox covers the worktree but not
    the project's `.git` folder that its commits write to, so committing may ask
    for approval. None of this has run with real agents yet.
15. A chat that started alone stays in the shared folder, where the notice is
    advisory and cannot attribute edits made while turns overlap. Harness sends its tool list again when it resumes a
    Codex thread, which Codex documents as replacing the stored list; that a
    thread from before this release then gains `workspace_activity` is unverified.
    The per-turn notice reaches it either way.
16. Resizable or reorderable panes, and sending one request to several agents to
    compare the results. Both were left out of the first multi-chat release.

## Agent rules follow-ups

17. Run the hand-off rule against real providers and record the results. Nothing
    has run against a real provider yet, including the workers themselves. For
    each of the eight kinds of work, on a Claude chat and a Codex chat: one job
    large enough to be handed off, checked for a correct answer, and its real
    cost against the estimate. Also one small job the host should do itself, and
    one real task measured end to end with the rule on and off. All of this uses
    included usage.
18. Measure quality per kind of work on these repos: a fixed set of tasks with
    known answers, run on each worker at each effort and on the chat's model as
    the baseline. The current list of what is handed off rests on public
    evidence, which is controlled for only two of the eight kinds and on an older
    small model.
19. Update Claude Code so Haiku 5.5 is offered here. This install still resolves
    `haiku` to Haiku 4.5, which is only four times cheaper than Opus 5.5. At
    that ratio the estimate declines plain reads, drafts and all but very large
    edits.
20. Keep `src/core/prices.mjs` current, and decide whether prices should be
    editable in Agent rules. The table is dated, comes from third-party price
    trackers, and has no entry for older models, which are therefore never used.
21. Improve the estimate: count that text read by the chat's model is re-read on
    later turns; replace the fixed assumption for what a search costs the chat's
    model with a measured one; show a per-turn saving in the Work log.
22. Find out how long Codex waits for a client tool to answer. A worker is limited
    to five minutes, a command to ten, and Codex's own limit for `item/tool/call`
    is undocumented.
23. Confirm on this PC that a Codex worker can read under the read-only sandbox,
    and that a Codex editing worker's file-change approvals arrive as the host
    expects. The Codex Windows sandbox here sometimes fails ACL setup. A worker
    that cannot run returns an error and the chat does the work itself.
24. Cover Cursor: let Cursor chats hand off through the MCP bridge (its tool-call
    time limit is unknown and the bridge allows 15 seconds), and decide whether a
    Cursor model can be a worker without a usage meter.
25. Per-project overrides for the rules, and further rules.

## Architecture notes

- Preserve app-owned SQLite history; no paid summary/embedding dependency.
- Keep the single-repository path simple. Reference repositories stay one-way,
  separate Git roots and read-only in the app UI.
- Remote clients are views of this Windows executor. Running while the PC is off
  is a separate, optional product decision with security and cost implications.
