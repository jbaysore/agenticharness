# Daily use, setup and recovery

## Launch and first task

Use **Agentic Harness** on the Windows desktop or Start menu. Pin that shortcut,
or right-click the open Harness window and choose **Pin to taskbar**. The window
is an Edge app, and its taskbar identity is separate from the Edge browser only
when that shortcut is present. Pinning the window before the shortcut exists pins
Edge instead. The installed app and its bundled
runtime are under `%LOCALAPPDATA%\Programs\AgenticHarness\<version>`. Data is separate,
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
The picker comes from the connected native integrations. No model or effort is
selected until you choose one. Supported effort choices
change with the model. Cursor's effort control stays disabled and uses each model's
provider default. Composer, Grok, and the other advertised models are selectable
at standard speed. Auto is omitted from the picker. Assistant messages identify the route
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

## Working in several chats

Each chat runs its own turn, so several can work at once. Up to three show side
by side:

- Click a chat to open it in the focused pane. Ctrl-click or middle-click it, or
  use **Open beside** on its sidebar row, to add a pane. The split button in the
  header adds an empty pane, and Ctrl-click on **New conversation** starts a new
  chat beside the current one.
- Each pane has its own composer, draft, agent and model. A draft stays with its
  chat when the pane is closed. Closing a pane never stops the chat's work.
- The header breadcrumb and the work panel (Review, Work, Files, Terminal) follow
  the pane you last clicked. Alt+1, Alt+2 and Alt+3 move focus between panes.
- The window width decides how many panes fit: each needs 390 px. A pane that
  does not fit stays open and reappears when the window widens. The work panel
  stays docked while every pane keeps that width and otherwise opens over them.
- Open panes are part of the address and are restored on the next launch.

Sidebar rows mark what a chat is doing: a pulsing dot while it works, **!** when
it waits for your approval, **×** when it stopped before finishing, and a solid
dot when it finished since you last looked. **Active** at the top of the sidebar
lists those chats from every project, and the window title counts the ones
waiting on you. A chat shown in a visible window counts as looked at. Hover a
row to rename or archive it; archived chats sit behind **Show archived** in
their project and return when you unarchive them or send them a message.

Chats in one project share one working folder. When a turn starts while another
chat is already working in that folder, or in a folder nested inside it, the
agent is told who else is working, what they were asked, and which files already
had uncommitted changes. It is instructed to commit only its own files by path
and not to stash, reset, rebase or switch branches. Every agent can also call
`workspace_activity` to check again before committing. The composer and Review
panel show how many other chats are working in the project. This is guidance to
the agents, not enforcement: Harness cannot tell which chat made an edit while
turns overlap, and parallel chats still see each other's unfinished files when
they run tests. Give parallel chats separate areas of the code, and review the
diff before trusting a commit made while another chat was working.

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
  usage in the account dashboard. Confirm that setting once in Connections & usage.
  The confirmation stays with that account and does not expire. Confirm again only
  after signing in to a different Cursor account. ACP exposes no authoritative
  quota meter or paid-mode attestation, so the dashboard setting remains the
  required protection. A model reply is not billing proof.

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
Agents can call `history_search`, `history_read`, and `project_notes` on demand,
and `workspace_activity` to see which other chats are working in the same folder.

The History selector controls agent access: **This conversation**, **This project**,
or **All projects**. Reducing/changing scope starts fresh native sessions so an old
native context cannot silently retain broader access. The transcript stays saved.

Switching agent in the same chat creates an attributed, bounded text handoff with
recent messages, saved decisions and review comments. Earlier messages remain
searchable. Switching back can resume that provider's own native session and add
the intervening handoff. Codex/Claude/Cursor session IDs are never interchanged.
Very long handoffs are bounded, so ask an agent to read linked older sources when
needed. **Import local conversations** in Connections & usage copies Cursor,
Codex, and Claude transcripts already stored on this PC. A chat lands in the
matching project when its original folder is known, and otherwise under
Imported history. Imported chats keep their provider label and are not resumed
as native sessions. Running the import again skips transcripts already copied.

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

The host remains bound to loopback. A Cloudflare Tunnel, started and stopped with
the host, publishes it at an HTTPS hostname on the owner's domain. Cloudflare
Access requires the owner to sign in before any request reaches this PC. The app
then verifies the signed Access token on every remote request (issuer, application
audience, expiry and owner email) and additionally requires browser pairing. No
app is needed on the remote device.

One-time setup on the delivery PC:

1. Install the connector: `winget install Cloudflare.cloudflared`.
2. Run `cloudflared tunnel login` and choose the domain in the browser.
3. In the Cloudflare Zero Trust dashboard, add a self-hosted Access application
   for the chosen hostname, with one Allow policy that includes only the owner's
   email. Copy its **Application Audience (AUD) Tag**.
4. Run `node scripts/remote-setup.mjs --hostname <hostname> --team <team name>
--audience <AUD tag> --email <owner email>`, then restart the host.

Setup creates the tunnel and its DNS record, and refuses to replace an existing
record. Only a hash of the owner email is stored.

The address is shown in **Connections & usage → Remote access** on the delivery
PC. Open that address in the laptop browser or iPhone Safari and sign in through
Cloudflare Access. Generate a separate one-time code
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

The only recurring cost is the owner's domain registration; the Cloudflare
Tunnel and Access plans used are free. The Cloudflare endpoint has not yet been
verified end to end from this host, and physical Windows-laptop and iPhone checks
remain pending. Automated tests cover token validation with locally generated keys;
those results do not substitute for real endpoint or device tests.

## Back up and restore

Choose **Back up workspace** in Connections & usage. It takes a consistent SQLite
snapshot while the host is running, under `%LOCALAPPDATA%\AgenticHarness\backups`.
The saved path appears in the app. Browser pairing capabilities are excluded.
Copy that snapshot and `config.json` to your chosen backup location. This backs
up app history and metadata, not project code or provider-owned native session
files. Continue using Git and your normal file backups for those.

**Export conversation history** downloads readable JSON including messages,
run outcomes, work events, comments, notes and artifact references. Restoring
that JSON file is not implemented; use a SQLite snapshot for a full workspace
restore. Local provider transcripts are copied with **Import local conversations**.

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
