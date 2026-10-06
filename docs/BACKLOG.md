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
4. Replace Cursor's daily dashboard confirmation when ACP exposes authoritative
   billing and quota information. Until then keep the account-level on-demand-off
   boundary and honest unavailable meter.
5. Add optional start-at-login, a tray indicator, and a signed installer/updater.
   No startup service or recurring service cost is required by this release.
6. Extend the tested reload-safe outbox to explicit queued drafts across browser
   tabs. Current tab session storage retains an uncertain action ID and reconciles
   it against the server before restoring the draft or showing its accepted run.

## Product improvements

7. Rename/archive chats and projects from the UI, collapse/resize panels, and add
   keyboard shortcuts. The current sidebar supports creation, selection and search.
8. Group tool events into one updating card and make native subagent progress
   easier to scan. Keep provider-managed work distinct from app orchestration.
9. Resolve/retire individual review comments and navigate deleted-line anchors.
   Current comments target new-side lines and preserve their reviewed diff hash.
10. Add image/PDF artifact previews and pinned file versions. Current artifacts
    reference live files and the browser previews bounded text only.
11. Add supported provider-history import and JSON restore, preserving origin.
    SQLite restore already covers app-owned state; native imports remain optional.
12. Improve long-history paging with per-message offsets and explicit handoff
    truncation notices. Add deterministic repository evidence freshness checks.

## Architecture notes

- Preserve app-owned SQLite history; no paid summary/embedding dependency.
- Keep the single-repository path simple. Reference repositories stay one-way,
  separate Git roots and read-only in the app UI.
- Remote clients are views of this Windows executor. Running while the PC is off
  is a separate, optional product decision with security and cost implications.
