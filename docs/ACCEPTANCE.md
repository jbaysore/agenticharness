# Acceptance record — 2026-10-06

Raw account probes, native transcripts and screenshots stay in ignored local
folders. No credentials, account identifiers or session transcripts are committed.

| Check                                                                   | Kind                                                              | Result                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT, Claude and Cursor login/model discovery                        | Real native account calls                                         | All three connected; catalogs returned 7, 12 and 43 presets respectively                                                                                                      |
| Billing boundary                                                        | Real telemetry plus owner setting confirmation                    | Codex included usage available with no paid credits; Claude explicitly user-disabled extra usage; Cursor owner confirmed on-demand off, with account-bound daily confirmation |
| Codex implements → Claude reviews → Cursor adds test                    | Real subscribed inference and actual file changes                 | Passed; final 4 tests independently passed in an ignored Git fixture                                                                                                          |
| Each provider resumes its own session                                   | Real subscribed inference                                         | All three retained the same native session ID                                                                                                                                 |
| Each provider searches and reads app history                            | Real native tools                                                 | All three invoked both tools and cited source conversations                                                                                                                   |
| Native delegation                                                       | Real native tools                                                 | One small delegated task completed under each provider; progress is visible in Work                                                                                           |
| Stop after streaming begins                                             | Real subscribed inference                                         | Codex, Claude and Cursor all cancelled; observed acknowledgements under one second                                                                                            |
| Review comment → revision request → approval → test                     | Real Edge interaction and Cursor inference                        | Passed after fixing a save/request race; null/undefined prefix handling added and all 6 fixture tests passed; native subagent status visible                                  |
| Desktop review, artifacts, evidence notes, models/effort                | Automated real Edge browser with saved real transcript            | Passed with no page errors; screenshots inspected                                                                                                                             |
| PowerShell terminal                                                     | Real ConPTY and browser input                                     | Command output and successful host exit verified; native cleanup warning is documented below                                                                                  |
| Responsive phone UI                                                     | Edge touch-device emulation (`npm run test:mobile`), 320–430px portrait and 844px landscape | Passed: single chat, compact usage, welcome cards, model menus, settings/search, work panel, approval buttons, newline and explicit send. Simulated visual-viewport keyboard resize/pan keeps composer and overlays in bounds; no page errors. Physical-device validation remains pending. |
| Browser disconnect/reconnect                                            | Automated real Edge network interruption                          | Connection banner and saved transcript recovery passed                                                                                                                        |
| Host recovery, scoped history, duplicate actions, approvals, RPC faults | Automated synthetic state / real SQLite and process/HTTP fixtures | Passed; synthetic runs are not counted as real provider recovery tests                                                                                                        |
| Private remote endpoint                                                 | Requires Cloudflare Tunnel and Access setup                       | Pending. The earlier Tailscale Serve endpoint was replaced; the Cloudflare endpoint has not been verified from this host.                                                     |
| Remote owner rejection and proxy boundary                               | Real local HTTP with locally signed Access tokens                 | Missing, forged, wrong-owner, wrong-audience and expired tokens denied; a spoofed identity header denied; correct owner admitted without pairing                              |
| Consistent live backup                                                  | Real SQLite backup                                                | Integrity check passed; history retained and browser pairings excluded                                                                                                        |
| Physical Windows laptop and iPhone                                      | Requires product owner                                            | Pending. Owner reported devices could not be tested yet. No physical-device success is claimed.                                                                               |

## Reproduce

Directoryless chat checks added 2026-10-28: `npm run test:directoryless` uses
simulated providers and Edge to verify starting without a project, attachments,
failed creation recovery, replies, reloads, scoped search, private workspaces,
sidebar grouping, the review panel, directory switching with drafts/settings/files
preserved, and the mobile composer. `npm run test:directory` retains coverage of
ordinary folder selection. No inference is consumed by these checks.

Context/caching checks added 2026-10-27: `npm run test:context` uses isolated
fixture providers and Edge to verify live updates, cache details, compaction,
model changes, draft preservation, reload, two/four panes, keyboard controls,
and mobile layout. Screenshots are in `.local/screenshots/context-*.png`.
Unit fixtures cover provider token semantics, cumulative reviewer deltas,
failed delivery, generation/session boundaries, and summary-read timeout and
single-flight behavior. Native Codex continuity and cache telemetry passed the
opt-in two-turn `context-provider-smoke.mjs --codex` check; other adapters were
verified with fixtures. See INTEGRATIONS.md for the native probe limitation.
Final unit verification used `node --test --test-concurrency=1 test/*.test.mjs`:
476 passed. The parallel run encountered an intermittent Windows `EPERM` while
the existing detached restart helper replaced its state file; that fixture
passed without concurrent browser work. Restart implementation was unchanged.

Update preflight reliability fixed 2026-10-28: `npm test` now uses that serial
test-file schedule by default, including inside prepared runtimes. A live update
was rejected when cold PowerShell startup left time for only two of the startup
supervisor test's three required launches before its ten-second deadline. That
behavior check now allows 45 seconds, with a separate 60-second test timeout for
cleanup; all launch arguments, environment isolation, retry counts and log
assertions remain required.

Additional delivery checks passed after the table above: an actual host-process
kill during a real Codex response preserved partial output, marked the run
interrupted, refused duplicate execution, and allowed explicit native continuation.
A real browser with a simulated provider also verified outbox reconciliation
across reload after both a lost response and an unreceived request.

- `npm test`: no paid or included inference. Unit/state fixtures plus actual local
  HTTP, filesystem and child-process tests.
- `npm run test:watchers`: real headless Edge and isolated HTTP/SQLite, simulated
  CI and providers, no inference. Passed notification-only completion, unread
  results while the page is closed, reload, manual continuation, cancellation,
  Goal suspension/resumption and mobile layout. Unit fixtures cover conditional
  requests, pagination, reruns, revision changes, restart recovery, usage limits,
  three-continuation caps and one automatic agent at a time. A read-only smoke
  check through the installed GitHub CLI also retrieved real CI twice with the
  same result; it made no GitHub changes and called no models.
- `npm run test:terminal`: real Edge and Windows ConPTY, no inference. Passed
  PowerShell/Command Prompt execution, native copy/paste shortcuts, clipboard
  buttons, Ctrl+C interruption, tab/pane lifecycle and replay after reload.
  A 25-character command appeared in 62 ms with the old HTTP input endpoint
  artificially delayed; no per-key HTTP requests were made. Transport tests
  cover large Unicode pastes, ordering, reconnect without input replay,
  authentication, revocation, assertion expiry and output without SQLite writes.
- `npm run test:usage-stop`: real headless Edge and isolated HTTP/SQLite with
  simulated providers, no inference. Passed resumed Goal completion, genuine
  quota stops, banner/sidebar dismissal, disconnected events, persistence after
  reload and visibility of later failures. Store tests cover conservative repair
  of saved replay failures and preservation of genuine or unverified stops.
- `node scripts/acceptance.mjs`: **real included usage**, resets the disposable
  `.local/dogfood-project` fixture and performs the three-provider workflow.
- `node scripts/native-acceptance.mjs`: **real included usage**, native continuation,
  history tools and delegation against the existing fixture conversations.
- `node scripts/browser-acceptance.mjs`: actual Edge, saved real transcripts; no new
  inference. Adds fixture comments, notes and artifact references.
- `node scripts/interaction-acceptance.mjs`: **real included usage**, cancellation
  and browser-driven revisions. `--revision-only` reruns only the revision scenario.
- `node scripts/restart-acceptance.mjs`: **real included usage**, deliberately
  terminates a disposable host during streaming, then restarts and continues.
- `npm run test:self-restart`: real headless Edge and disposable hosts with a
  simulated provider, no inference. Passed update blocker status, reconnect,
  client reload, saved draft recovery and no message replay. It also covers the
  restart progress modal on desktop and mobile, dismissal only after workspace
  readiness, and feedback during startup recovery. The unit suite verifies
  automatic self delivery, mode and repository restrictions, the idle gates,
  IPC helper, activation admission, failed startup rollback, private SQLite
  recovery and launcher serialization using real Git, SQLite and child processes.
- `node scripts/outbox-acceptance.mjs`: real Edge/HTTP with an explicitly simulated
  provider; verifies action reconciliation and draft recovery after reload.
- `node scripts/multichat-acceptance.mjs`: real Edge/HTTP with an explicitly
  simulated provider; several chats running side by side and in the background.
- `npm run test:layout`: real Edge, no provider; sidebars and one to four panes.
- `npm run test:history`: real Edge and isolated SQLite fixtures, no provider;
  desktop/mobile history defaults, browser refresh, updates across open browsers,
  and new conversations retaining their scope without resetting existing sessions.
  `npm test` also checks host-restart persistence and rejects scope changes to an
  existing conversation through both the API and storage layer.
- `node scripts/rules-acceptance.mjs`: real Edge/HTTP with an explicitly simulated
  provider and worker; the Agent rules screen, a delegated search and each fallback.

## Several chats at once — 2026-10-09

Everything here used a simulated provider or stored state. No real provider ran
two turns at once, so none of it counts as real concurrent-provider evidence.

| Check                                                                  | Kind                                             | Result                                                                                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two turns streaming side by side, each with its own draft and model    | Real Edge and HTTP, simulated provider           | Passed (`node scripts/multichat-acceptance.mjs`)                                                                                                                             |
| Background chat: working, approval, unread markers; window title count | Real Edge and HTTP, simulated provider           | Passed; an approval in a chat that was not open opened and was answered with one click                                                                                       |
| Work panel and breadcrumb follow the focused pane across two projects  | Real Edge and HTTP, simulated provider           | Passed                                                                                                                                                                       |
| Rename, archive, unarchive                                             | Real Edge and HTTP                               | Passed                                                                                                                                                                       |
| One to three panes at 1920, 1512 and 1200 px; restore on reload        | Real Edge (`node scripts/layout-acceptance.mjs`) | Passed: three panes of at least 390 px with the work panel docked at 1920; panel floats at 1512; two panes with the focused one kept at 1200; one pane on the phone viewport |
| Single-chat review, files, terminal, search, reconnect                 | Real Edge with saved real transcripts            | Passed after the change (`node scripts/browser-acceptance.mjs`)                                                                                                              |
| Workspace notice, commit rules and `workspace_activity`                | Unit tests with a stubbed provider               | Passed: a chat starting beside another in the same or a nested folder receives the notice; an unrelated project does not                                                     |
| Worktree per chat and `land_changes`                                   | Unit tests with real Git and a stubbed provider  | Passed: every new chat gets its own worktree; landing rebases, checks, fast-forwards and pushes, and refuses conflicts, failing checks and uncommitted work                  |
| Chat status, unread, archive and the migration of an existing database | Unit tests against real SQLite                   | Passed                                                                                                                                                                       |
| Real agents following the notice; two real turns committing at once    | Requires included usage                          | Not run                                                                                                                                                                      |
| Two simultaneous Cursor turns                                          | Requires included usage                          | Not run; Cursor's worker lock is untested with concurrent sessions                                                                                                           |

`scripts/outbox-acceptance.mjs` and `scripts/browser-acceptance.mjs` had stopped
passing before this work, once models were left unset by default and Cursor Auto
was removed from the picker. Both now choose a model the picker offers.

## Agent rules — 2026-10-09

Everything here used simulated chat providers and simulated workers. No worker
has run against a real provider, so none of this is evidence that a real agent
uses the tools, that a real worker answers well, or that tokens are saved.

| Check                                                                                                                                                                    | Kind                                                                 | Result                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Choose a worker, a fallback and the allowed kinds of work; save; reload                                                                                                  | Real Edge and HTTP (`node scripts/rules-acceptance.mjs`)             | Passed                                                                         |
| A long file goes to the worker; the Work log shows who answered, the tokens and the cost against the estimate                                                            | Real Edge and HTTP, simulated provider and worker                    | Passed                                                                         |
| A short file is returned by the host with no worker started                                                                                                              | Real Edge and HTTP, simulated                                        | Passed                                                                         |
| Worker's provider out of usage: settings shows where hand-offs go, the next one uses the fallback, reason logged                                                         | Real Edge and HTTP, simulated blocked provider                       | Passed                                                                         |
| No worker available, and the rule switched off: the chat is not offered the tools                                                                                        | Real Edge and HTTP, simulated                                        | Passed                                                                         |
| The cost comparison: round trip against the chat's own model, the minimum size, measured runs replacing starting figures, edit and draft thresholds for four model pairs | Unit tests (`test/cost.test.mjs`)                                    | Passed                                                                         |
| Each of the eight kinds of work through its tool, in a real temporary Git project                                                                                        | Unit tests with stubbed workers (`test/delegation.test.mjs`)         | Passed                                                                         |
| An exact name found by search with no model; a description sent to the worker                                                                                            | Unit tests, real `git grep`                                          | Passed                                                                         |
| An edit returned as a diff; a small edit declined; a worker that changes nothing or fails part-way leaves the file as it was                                             | Unit tests, real files and `git diff`                                | Passed                                                                         |
| A command asks for approval; a declined command does not run; long output is filtered by the worker                                                                      | Unit tests with a stubbed command runner                             | Passed                                                                         |
| Limit reached mid-turn: fallback answers, the exhausted worker is not retried, provider refresh requested; with every worker out the host still serves a read            | Unit tests with stubbed workers                                      | Passed                                                                         |
| Nothing offered to Cursor chats, to a chat on the worker model, or where a price is unknown; a kind of work that cannot pay for the pair of models is not offered        | Unit tests                                                           | Passed                                                                         |
| The Claude and Codex worker implementations, in all three modes                                                                                                          | Requires included usage                                              | Not run                                                                        |
| The command runner: real exit code, output in the given folder, long output trimmed, stopped on timeout or when the turn stops                                           | Unit tests running real harmless commands (`test/commands.test.mjs`) | Passed, after fixing PowerShell reporting every failing program as exit code 1 |
| A real agent using the tools, the quality of real worker answers, and real token use with the rule on versus off                                                         | Requires included usage                                              | Not run                                                                        |
| A real usage limit triggering the fallback                                                                                                                               | Would require exhausting a subscription                              | Not run; simulated only                                                        |

## Skills — 2026-10-21

The provider was simulated. No real agent was asked to follow a skill, so this
is not evidence that Codex, Claude Code, or Cursor obeys one.

| Check                                                                                                                                                | Kind                                                       | Result  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------- |
| Create, edit, invoke with `/review-notes`, include the text on that message, ignore a path, leave a later message alone, and delete                  | Real Edge (`node scripts/skills-acceptance.mjs`)           | Passed  |
| Name and command checks, the six-skill limit, and a deleted skill no longer matches its command                                                      | Unit tests (`test/skills.test.mjs`)                        | Passed  |
| Codex, Claude Code, and Cursor turns receive a slash command’s skill; a message without it does not; an edit is included the next time it is invoked | Unit tests with stubbed providers (`test/skills.test.mjs`) | Passed  |
| A real agent following a skill                                                                                                                       | Requires included usage                                    | Not run |

## Foreground command support — 2026-10-23

No real model turn was started for these checks. Provider tool exposure was
tested with fixtures, including Claude's real SDK MCP server and the HTTP bridge.

| Check                                                                                                                 | Kind                                                                        | Result |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ |
| PowerShell npm wrapper, multiline quotes and Unicode; cmd `&&` failure; Bash heredoc                                  | Real shells (`test/commands.test.mjs`)                                      | Passed |
| Linked dependency reads and Git index writes outside a worktree                                                       | Real temporary Git worktree and host command (`test/command-tool.test.mjs`) | Passed |
| All providers receive the tool; requests use permission review; Ask cannot execute; expired capability is rejected    | Controller fixtures and real HTTP bridge                                    | Passed |
| Stale dependency detection; approved installation detaches only the link; declining leaves shared dependencies intact | Real temporary filesystem and injected installation                         | Passed |
| Nonzero exits, output limits, timeout and cancellation                                                                | Real shells                                                                 | Passed |

Native Codex runner pipe timeouts are not repaired by these checks. The shared
foreground tool avoids that runner; it does not blindly retry uncertain actions.

## Bugs found through dogfooding

1. Official Codex default endpoint was mistaken for a custom gateway — fixed.
2. Immediate approval answer arrived before its waiter was registered — fixed.
3. Terminal emitted output after database shutdown — fixed.
4. Bundled ConPTY could retain its output worker on shutdown — keep system ConPTY
   and the library's full cleanup. A native AttachConsole helper warning can occur
   during shutdown; its bounded fallback exits successfully. This is recorded as
   a library limitation rather than hidden or treated as a failed provider turn.
5. Save-comment / ask-revisions race could submit the older list — fixed by
   disabling revision submission while the save or draft is pending.
6. Cursor delegation status arrived through ordinary tool events — retain its
   task identity across event updates.
7. Offline detection waited for the stream to fail — browser offline events now
   show reconnect status immediately.

The full goal remains open until physical device validation can be performed.
