# Delivery plan

Goal: a personal Windows coding workspace using existing Codex, Claude Code and
Cursor subscriptions, with secure browser access from a laptop and iPhone.
The complete product is not finished at the first working provider milestone.

1. **Subscription validation (working).** Official documentation, installed
   version checks, real conversations, model/effort discovery, no paid fallback.
2. **Daily local slice.** Persistent projects/chats, streaming and cancellation,
   searchable history, review/comments/revisions, terminals, artifacts, approvals.
3. **All providers and shared context.** Native continuation per provider,
   attributed cross-provider handoffs, on-demand history tools, visible subagents.
4. **Reliability and context.** Restart/reconnect recovery, deduplicated actions,
   evidence-linked project notes, directional reference repositories.
5. **Windows delivery and remote use.** Double-click launch, portable package,
   authenticated encrypted remote browser access, responsive review and approvals.
6. **Acceptance and dogfooding.** Real provider/device checks, setup/update/backup
   guide, prioritized backlog. No mock-only capability counts as complete.

## Architecture decisions

- One local Node 24 host owns SQLite history and agent processes. Browser clients
  receive durable event IDs and reconnect without re-submitting actions.
- Providers own credentials and native sessions. The app never extracts OAuth
  credentials or calls inference APIs directly.
- A provider adapter owns its actual capabilities. A model label always includes
  the agent/subscription route. Unsupported quotas are unavailable, not estimates.
- SQLite full-text search and explicit source links provide shared memory. No
  separately billed embedding service or summarization model.
- A project defaults to one writable repository; references are directional and
  are not silently granted write access. Git state stays per repository.
- Local host binds to loopback. Remote access requires an explicitly configured
  encrypted authenticated path. Never expose raw agent RPC endpoints publicly.
- All changes are committed and pushed directly to main, per AGENTS.md.

## Account/setup actions

- Codex 0.160.0: ChatGPT auth confirmed; backend reports included usage available.
- Claude Code 2.1.292: official binary installed; claude.ai Pro login confirmed.
- Cursor 2026.10.01-e373342: official native Windows runtime downloaded; browser
  login confirmed. Preserve the existing cursor-agent directory and worker lock.
- Product owner confirmed Claude usage credits and Cursor on-demand usage are off.
  Claude's native usage response independently confirms user-disabled extra usage.
  Cursor ACP has no authoritative billing meter; its account-bound confirmation
  expires after 24 hours and must be renewed in the app.
- Existing Tailscale installation is signed in; use a new private HTTPS port,
  preserving existing Serve/Funnel services. Device testing is still pending.

## Validation accounting

Non-inference account/model probes are real. Automated fixture tests will be
identified separately from real provider conversations and manual device tests.
Never record credentials, account identifiers, or raw diagnostic transcripts in Git.

## Latest evidence — 2026-10-06

- Real controller workflow: Codex implemented a small issue-title formatter and
  passed 3 tests; Claude inspected the files and independently passed those tests;
  Cursor added the normal-input regression test and passed all 4. Shared history
  retained provider/model attribution and both context handoffs.
- Model catalogs came from all three native runtimes (7 / 12 / 43 entries on this
  account at validation time). Codex and Claude effort controls were exercised.
- Dogfooding found and fixed an immediate approval-response race and an overly
  strict check that rejected Codex's official default ChatGPT endpoint.
- This machine's Codex Windows sandbox can fail during ACL setup. The agent can
  request approval for an unsandboxed command. The app does not silently disable
  sandboxing; each such request remains visible and requires approval.
- Remaining: browser QA, native continuation/delegation/cancel tests, packaging,
  private remote setup and physical laptop/iPhone checks, user documentation.
