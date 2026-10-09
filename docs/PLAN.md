# Delivery plan

Goal: a personal Windows coding workspace using existing Codex, Claude Code and
Cursor subscriptions, with secure browser access from a laptop and iPhone.
The complete product is not finished at the first working provider milestone.

1. **Subscription validation (working).** Official documentation, installed
   version checks, real conversations, model/effort discovery, no paid fallback.
2. **Daily local slice (working).** Persistent projects/chats, streaming and cancellation,
   searchable history, review/comments/revisions, terminals, artifacts, approvals.
3. **All providers and shared context (verified).** Native continuation per provider,
   attributed cross-provider handoffs, on-demand history tools, visible subagents.
4. **Reliability and context (verified).** Restart/reconnect recovery, deduplicated actions,
   evidence-linked project notes, directional reference repositories.
5. **Windows delivery and remote use (installed; device checks pending).** Double-click launch, portable package,
   authenticated encrypted remote browser access, responsive review and approvals.
6. **Acceptance and dogfooding (physical device acceptance pending).** Real provider/device checks, setup/update/backup
   guide, prioritized backlog. No mock-only capability counts as complete.
7. **Several chats at once (built; real concurrent providers not yet run).** One to three
   chats side by side, per-chat status in the sidebar, rename/archive, and an
   automatic shared-workspace notice to agents. Verified with a simulated provider only.
8. **Agent rules (built; not yet run against real providers).** Standing instructions for
   every agent, and a rule that hands read-only searches to a cheaper worker model
   the user picks, across providers, with a fallback when a worker's provider is
   out of usage. Verified with simulated providers and workers only.

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
- Chats in a project share one working folder. Agents are told about each other
  and given commit rules on every overlapping turn; this is advisory. Enforced
  isolation through a Git worktree per chat is the planned next phase, switched
  on only when a chat starts beside another that is already working.
- Delegated work runs in the host, not in a provider's own subagents. Built-in
  subagents cannot leave their provider and their model is not always settable,
  so Harness offers its own `delegate_task` tool and runs a read-only worker on
  the chosen model. That makes cross-provider workers, a visible token count and
  a fallback possible. The agent still decides when delegating is cheaper.
- The host already ran one turn per chat. The browser holds open chats in a map
  fed by one event stream, so any pane can show any chat without a second stream.
- All changes are committed and pushed directly to main, per AGENTS.md.

## Account/setup actions

- Codex 0.160.0: ChatGPT auth confirmed; backend reports included usage available.
- Claude Code 2.1.292: official binary installed; claude.ai Pro login confirmed.
- Cursor 2026.10.01-e373342: official native Windows runtime downloaded; browser
  login confirmed. Preserve the existing cursor-agent directory and worker lock.
- Product owner confirmed Claude usage credits and Cursor on-demand usage are off.
  Claude's native usage response independently confirms user-disabled extra usage.
  Cursor ACP has no authoritative billing meter; the account-bound confirmation
  does not expire and must be repeated only after the signed-in account changes.
- Remote access uses a Cloudflare Tunnel and Cloudflare Access on the owner's
  domain; existing Tailscale Serve/Funnel services belong to other projects and
  are left alone. Real endpoint and device testing are still pending.

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
- All three providers resumed native sessions, called scoped history tools and
  completed one native subagent. Cancellation after streaming began passed for all
  three. A real Cursor revision through the UI passed all six fixture tests.
- Desktop and iPhone-sized Edge checks passed, including real ConPTY, review,
  artifacts and reconnect. Screenshots were inspected. Phone tests are emulation.
- A real Codex response survived an abrupt test-host exit as saved partial text;
  restart marked it interrupted, prevented duplicate action submission, and an
  explicit native continuation succeeded.
- Reload-safe submission recovery passed in a real browser with a simulated
  provider, including both an accepted-but-lost response and an unreceived request.
- Windows package and desktop shortcut installed. Remote access later moved from
  Tailscale Serve to Cloudflare Tunnel and Access (2026-10-08); that endpoint is
  not yet verified from the host.
- Setup, update, backup, limits and prioritized dogfooding backlog are documented.
- Remaining completion action: physical Windows laptop/iPhone validation. The
  product owner cannot test the devices yet; do not mark the full goal complete.
