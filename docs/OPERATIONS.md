# Daily use, setup and recovery

## Launch and first task

Use **Agentic Harness** on the Windows desktop. The installed app and its bundled
runtime are under `%LOCALAPPDATA%\Programs\AgenticHarness\0.1.1`. Data is separate,
under `%LOCALAPPDATA%\AgenticHarness`. Closing the app window leaves the host and
ongoing work running. The host starts when you launch the app; it is not a Windows
service and does not currently start automatically when you sign in.

Verify installed-app launches through the actual Windows desktop shortcut.
Packaged development tools can redirect `%LOCALAPPDATA%` into their own private
storage; starting the host there can create a separate runtime and database from
the ones Windows Explorer sees. A desktop launch can then encounter an occupied
port even though its runtime file is missing. Preserve the existing database and
configuration before consolidating those folders, and restart the idle host from
Explorer. The launcher reports an early host exit with the new host error instead
of waiting for a generic startup timeout; earlier log entries are excluded.

Pick a project in the sidebar, then choose an agent and model in the composer.
The picker comes from the connected native integrations. Supported effort choices
change with the model. Cursor's effort control stays disabled and uses each model's
provider default. Composer, Grok, and the other advertised models are selectable
at standard speed; Auto stays unavailable. Assistant messages identify the route
and model; new Claude responses resolve aliases from native initialization events.

Three projects are configured on the delivery PC: Agentic Harness, linescience,
and linescience-personal. Only linescience-personal lists linescience as an
upstream reference. The reverse relationship is absent. Add more folders with
the **+** beside Projects. Each folder retains its own Git state.

Drag the inside edge of either sidebar to change its width. You can also focus
the edge with Tab and use the left/right arrows (Shift for larger steps), Home
or End for the smallest/largest width, or double-click to reset. The sidebar
buttons in the conversation header hide or reopen each side; each sidebar also
has its own collapse button. Desktop widths and visibility are remembered in
this browser. On smaller screens the work panel opens over the conversation,
and on phones the project sidebar does too. Escape dismisses these overlays.

## Sign-in and subscription boundaries

The app uses the official native executables already installed for your Windows
user. Their browser sign-ins and credential stores remain theirs. It does not
extract or relay subscription tokens. Account/model probes do not submit prompts.

- **Codex:** sign in through Codex with ChatGPT. The app rejects API auth, custom
  endpoints, unavailable/depleted included quota, and available paid credits.
  Standard service tier is forced. Models and effort come from `model/list`.
- **Claude Code:** use the official Claude browser sign-in. Disable usage credits
  in Claude account Usage settings. The official SDK controls the unmodified CLI;
  its native usage response must confirm `user_disabled=true` and
  `is_enabled=false`. Fast mode and external API environment variables are off.
  The usage control is experimental and version-sensitive: a future incompatible
  version will block work rather than infer billing safety.
- **Cursor:** use the official Cursor CLI browser sign-in and disable on-demand
  usage in the account dashboard. Confirm that setting in Connections & usage.
  The confirmation is tied to the account and expires after 24 hours. ACP exposes
  no authoritative quota meter or paid-mode attestation, so the dashboard setting
  remains the required protection. A model reply is not billing proof.

Use **Refresh** in Connections & usage after a login or plan change. The app never
automatically buys credits, supplies an inference API key, or retries a failed
turn with another route. Native subagents and compaction use the same account
billing boundary. No separate embedding or AI summary service runs in the app.

## Approvals and stopping

Requested commands, tool actions, plans and questions appear in the conversation.
Open the action details before **Allow once**. Approvals are limited to that
request. **Decline** rejects it. The square stop button interrupts work and expires
pending approvals. A repeated approval response cannot apply twice.

Native provider permission models differ. Some workspace reads/edits need no
prompt under a provider's own policy. Harness does not claim that every operation
is independently sandboxed. Read-only references are directional context and have
no writable app API; never approve a command that writes to one unless you intend
to change the task scope. Agent execution has the current Windows user's powers
where a provider permits it or you approve an unsandboxed command.

This PC's Codex Windows sandbox sometimes fails with `apply deny-read ACLs`.
Harness preserves that failure and the agent can request approval for a command
outside the sandbox. Review that request; the app does not disable the sandbox
globally or automatically approve the workaround.

## History and changing agents

All chat text, run outcomes, tool activity, review comments, artifacts and decisions
are recorded in SQLite. Search conversations by words, filenames or decisions.
Search results link to the source conversation and retain provider attribution.
Agents can call `history_search`, `history_read`, and `project_notes` on demand.

The History selector controls agent access: **This conversation**, **This project**,
or **All projects**. Reducing/changing scope starts fresh native sessions so an old
native context cannot silently retain broader access. The transcript stays saved.

Switching agent in the same chat creates an attributed, bounded text handoff with
recent messages, saved decisions and review comments. Earlier messages remain
searchable. Switching back can resume that provider's own native session and add
the intervening handoff. Codex/Claude/Cursor session IDs are never interchanged.
Very long handoffs are bounded, so ask an agent to read linked older sources when
needed. Existing conversation import from provider apps is not in this release.

## Review, files, decisions and terminal

Review shows primary or reference repository Git changes. Select a file, click a
line and save a comment. **Ask for revisions** submits the saved comments to the
selected agent; it waits for a comment save to finish. Comments carry a diff hash,
and saving against a changed diff is rejected so you can refresh it first.

Files lets you search file paths, inspect text and pin artifacts to a conversation.
Artifacts point to current files; they are not immutable file snapshots. Binary
previews and files larger than 2 MiB are not supported. Private configuration
paths, traversal and junction escapes are rejected by the file browser.

Save a project decision with its source conversation. **Flag stale** keeps the
evidence while excluding the note from automatic handoffs. Refresh a decision by
saving a new evidence-backed note; the old flagged note remains inspectable.

Terminal starts PowerShell in the selected primary project. It continues when
you change panels or disconnect the browser. Close terminals when finished. A
host restart ends terminals; reopen one afterward. Live terminal streams and work
events can contain local code and command output, so treat backups as private.
The terminal library can log `AttachConsole failed` while closing a Windows
console. Its bounded cleanup fallback still exits successfully; this has been
verified. Allow about five seconds for that fallback when stopping the host.

## Private laptop and iPhone access

The host remains bound to loopback. Tailscale Serve provides private HTTPS on a
separate port, without modifying the pre-existing services or enabling Funnel.
The app additionally requires the owner's Tailscale identity and browser pairing.

The address is shown in **Connections & usage → Remote access** on the delivery
PC. Keep Tailscale connected to the same account on both remote devices. Open that
address in the laptop browser or iPhone Safari. Generate a separate one-time code
with **Pair another browser** for each browser. Codes expire after 10 minutes;
paired browser sessions expire after seven days. On iPhone, optionally add the
page to the Home Screen using Safari's Share menu.

The Windows host must remain awake, connected, and running Harness. Browser
disconnects do not cancel work. Event IDs replay missed updates. Retrying the
same submission after a lost response uses its original action ID to avoid a
second turn. An unconfirmed submission is saved in the browser tab's session
storage. After a reload the app checks whether its action was accepted; it either
shows the accepted run or restores the draft with the original action ID. Nothing
is automatically resubmitted. An interrupted turn is never automatically re-executed.

**Revoke all paired browsers** invalidates all browser sessions, including your
current one. Relaunch the desktop shortcut to pair locally again. Revocation is
useful after losing a device. Provider account logins are not affected.

No new paid remote service or recurring charge was added. The implementation uses
the Tailscale installation and account that were already configured on this PC.
Physical Windows-laptop and iPhone checks remain pending because the product owner
could not test the devices during setup. Desktop HTTPS and responsive emulation
passed; those results do not substitute for physical device tests.

## Back up and restore

Choose **Back up workspace** in Connections & usage. It takes a consistent SQLite
snapshot while the host is running, under `%LOCALAPPDATA%\AgenticHarness\backups`.
The saved path appears in the app. Browser pairing capabilities are excluded.
Copy that snapshot and `config.json` to your chosen backup location. This backs
up app history and metadata, not project code or provider-owned native session
files. Continue using Git and your normal file backups for those.

**Export conversation history** downloads readable JSON including messages,
run outcomes, work events, comments, notes and artifact references. JSON import
is not implemented; use a SQLite snapshot for restoration.

To restore: stop active work and the host, preserve the existing data folder as a
rollback copy, then put the chosen SQLite snapshot at
`%LOCALAPPDATA%\AgenticHarness\workspace.sqlite`. Do not mix it with WAL/SHM files
from another database. Relaunch and pair browsers again. Native session resumption
also requires the provider's own saved session to still exist; otherwise use a new
conversation and consult the restored history.

## Update or stop the host

Release zips contain a complete runtime and dependencies. Back up first, stop
active work, close terminals and double-click **Stop Harness.vbs**. Extract the
new release and run **Install Harness.vbs**. Data stays in its separate folder.
Then launch the desktop shortcut. Provider CLIs are updated through their own
official distribution; refresh connections afterward.

Advanced commands are optional: `node scripts/launch.mjs --stop` and
`node scripts/launch.mjs --restart` provide graceful host control. Startup errors
are under the data folder in `host-errors.log` and `launcher-errors.log`.
The app does not include an automatic updater, startup service, offline executor,
or cross-machine copy of provider credentials.
