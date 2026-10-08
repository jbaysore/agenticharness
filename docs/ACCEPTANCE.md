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
| Responsive phone UI                                                     | Edge iPhone 13 viewport emulation                                 | Conversation, review and connections checked; no horizontal page overflow                                                                                                     |
| Browser disconnect/reconnect                                            | Automated real Edge network interruption                          | Connection banner and saved transcript recovery passed                                                                                                                        |
| Host recovery, scoped history, duplicate actions, approvals, RPC faults | Automated synthetic state / real SQLite and process/HTTP fixtures | Passed; synthetic runs are not counted as real provider recovery tests                                                                                                        |
| Private remote endpoint                                                 | Requires Cloudflare Tunnel and Access setup                       | Pending. The earlier Tailscale Serve endpoint was replaced; the Cloudflare endpoint has not been verified from this host.                                                     |
| Remote owner rejection and proxy boundary                               | Real local HTTP with locally signed Access tokens                 | Missing, forged, wrong-owner, wrong-audience and expired tokens denied; a spoofed identity header denied; correct owner still requires pairing                                |
| Consistent live backup                                                  | Real SQLite backup                                                | Integrity check passed; history retained and browser pairings excluded                                                                                                        |
| Physical Windows laptop and iPhone                                      | Requires product owner                                            | Pending. Owner reported devices could not be tested yet. No physical-device success is claimed.                                                                               |

## Reproduce

Additional delivery checks passed after the table above: an actual host-process
kill during a real Codex response preserved partial output, marked the run
interrupted, refused duplicate execution, and allowed explicit native continuation.
A real browser with a simulated provider also verified outbox reconciliation
across reload after both a lost response and an unreceived request.

- `npm test`: no paid or included inference. Unit/state fixtures plus actual local
  HTTP, filesystem and child-process tests.
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
- `node scripts/outbox-acceptance.mjs`: real Edge/HTTP with an explicitly simulated
  provider; verifies action reconciliation and draft recovery after reload.

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
