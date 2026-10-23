# Daily use, setup and recovery

## Launch and first task

Use **Agentic Harness** on the Windows desktop or Start menu. Pin that shortcut,
or right-click the open Harness window and choose **Pin to taskbar**. The window
is an Edge app, and its taskbar identity is separate from the Edge browser only
when that shortcut is present. Pinning the window before the shortcut exists pins
Edge instead. The installed app and its bundled
runtime are under `%LOCALAPPDATA%\Programs\AgenticHarness\<version>`. Data is separate,
under `%LOCALAPPDATA%\AgenticHarness`. Closing the app window leaves the host and
ongoing work running. The host starts when you launch the app, or through the
optional Windows startup task described below.

Verify installed-app launches through the actual Windows desktop shortcut.
Packaged development tools can redirect `%LOCALAPPDATA%` into their own private
storage; starting the host there can create a separate runtime and database from
the ones Windows Explorer sees. A desktop launch can then encounter an occupied
port even though its runtime file is missing. Preserve the existing database and
configuration before consolidating those folders, and restart the idle host from
Explorer. The launcher reports an early host exit with the new host error instead
of waiting for a generic startup timeout; earlier log entries are excluded.

Pick a project in the sidebar, then choose an agent and model in the composer.
Before sending the first message, click the folder path or **Change** above the
composer to choose an existing project or enter another directory. Your draft,
attachments, and model settings stay with the conversation.
The picker comes from the connected native integrations. No model or effort is
selected until you choose one. Supported effort choices
change with the model. Cursor's effort control stays disabled and uses each model's
provider default. Composer, Grok, and the other advertised models are selectable
at standard speed. Auto is omitted from the picker. Assistant messages identify the route
and model; new Claude responses resolve aliases from native initialization events.
The mode menu beside Permissions is separate from review. **Default** takes the
message as usual. **Ask** is read-only: the agent answers questions and explains
how the project works, and it cannot change files, land commits, or change a
page. Cursor uses its own Ask mode. Codex stays in a read-only sandbox, including
when permissions are Override. Claude Code is limited to read and search tools.
**Plan** researches and proposes a plan. One **Confirm and build** button accepts
it and returns the chat to Default so the plan can be built. **Goal** keeps Codex or Claude Code working until the
message's condition is met. Cursor has no goal mode. `/ask`, `/plan`, `/goal`,
and `/default` anywhere in a message switch modes the same way. `/queue` and
`/steer` work anywhere too.

In Goal the agent stays in Goal until the condition is met. It does not suggest
another mode, and carrying out a plan does not leave Goal. Permission requests
are decided by the automatic reviewer, including when permissions are Manual,
and one that needs you is declined so the work continues. Override still allows
those actions. A question is shown for 60 seconds. If it is not answered, the
agent chooses the path that best completes the objective and continues. The
same question does not wait again after it times out, and after three timeouts
further questions are answered by the agent at once.

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

Each chat runs its own turn, so several can work at once. Up to four show at
once. One, two, or three sit side by side; four fill a two-by-two grid:

- Click a chat to open it in the focused pane. Ctrl-click or middle-click it, or
  use **Open beside** on its sidebar row, to add a pane. The split button in the
  header adds an empty pane, and Ctrl-click on **New conversation** starts a new
  chat beside the current one.
- Each pane has its own composer, draft, agent and model. A draft stays with its
  chat when the pane is closed. Closing a pane never stops the chat's work.
- The header breadcrumb and the work panel (Review, Work, Files, Terminal) follow
  the pane you last clicked. Alt+1, Alt+2, Alt+3 and Alt+4 move focus between
  panes.
- The window width decides how many panes fit. A row needs 390 px for each
  pane. Four panes need the width of two, because they stack in two rows. A
  pane that does not fit stays open and reappears when the window widens. The
  work panel stays docked while every pane keeps that width and otherwise
  opens over them.
- Open panes are part of the address and are restored on the next launch.

Sidebar rows mark what a chat is doing: a pulsing dot while it works, **!** when
it waits for your approval, **×** when it stopped before finishing, and a solid
dot when it finished since you last looked. **Active** at the top of the sidebar
lists those chats from every project, and the window title counts the ones
waiting on you. A chat shown in a visible window counts as looked at. Hover a
row to rename, pin, or archive it. Pinned chats stay at the top of their
project and are listed under **Pinned**, newest pin first. A pin is kept while
a chat is archived, and the chat returns to **Pinned** when you unarchive it
or send it a message. Archived chats sit behind **Show archived** in their
project.

When a turn stops because included usage runs out, its chat keeps a usage flag
and reminder. **Dismiss** in the reminder or sidebar acknowledges that run;
the same error stays hidden after reload, and later failures still appear.
A resumed Goal's earlier usage-limit state does not mark a successful run failed.

Codex, Claude Code and Cursor give new chats a short title silently at the start
of their work. If an agent misses naming a chat, it is reminded on the next turn.
An automatic title never replaces one you chose or an earlier automatic title.

When a chat's first turn starts, and the project folder is the top of a Git
repository on a branch, the chat gets its own Git worktree under `%LOCALAPPDATA%\AgenticHarness\worktrees`
on a branch named `harness/<id>`. It keeps that worktree for good. Its agent,
Review, Files and Terminal all work there, so no other chat's unfinished edits
reach its builds, tests or commits. `node_modules` is linked from the project
folder; `.env` files and local databases are not copied.

A chat in a worktree commits to its own branch and delivers the work by calling
`land_changes`. Harness then lands one branch at a time per project: it rebases
the branch onto the project's branch, runs the project's check command on the
result, fast-forwards the project's branch in the project folder and pushes it
to its upstream. Conflicts, a failing check or uncommitted work go back to the
agent to fix and land again. Set the check command under **Check before
landing** in the Files panel; with none set, a clean rebase is enough. Landing
fails if the project folder has uncommitted changes in the same files, or is on
another branch. Before each turn, a worktree with no commits of its own catches
up with the project's branch.

When a chat's turn ends and everything in its worktree has landed, with no
uncommitted, untracked or unlanded work left, Harness removes the worktree and
its branch. The next turn recreates it at the same path from the project's
branch, so a project with nothing left to land is back to its one folder.
Worktrees that still hold work are kept, as are any a terminal or other program
has open; Harness tries again after the chat's next turn and at startup.

A chat that began before every chat got a worktree, or whose project folder is
not the top of a Git repository on a branch, stays in the shared project
folder. When a turn starts while another chat is working in that folder, or in a
folder nested inside it, the agent is told who else is working, what they were
asked, and which files already had uncommitted changes. It is instructed to
commit only its own files by path and not to stash, reset, rebase or switch
branches. Every agent can also call `workspace_activity` to check again before
committing. The composer and Review panel show how many other chats are working
in the same folder. This is guidance to the agents, not enforcement: Harness
cannot tell which chat made an edit while turns overlap.

## Skills

**Skills** in the sidebar is where you write a skill: a name and the instructions
an agent should follow. Harness stores it and gives it a slash command from the
name, so Review notes becomes `/review-notes`. A skill you create here is not a
Cursor skill, a Claude Code skill, or a Codex skill, so the same command works
for every agent.

In the message box, type `/` and pick a skill, or type the command yourself.
`/review-notes look at the parser` includes that skill’s full text on that
message only, for Codex, Claude Code, or Cursor, including when the chat
continues an existing session. A message can invoke six. The command has to be
its own word, so a path does not trigger one. The work log names the skills
that went with a turn. Text that every chat should always see belongs in
**Agent rules** instead.

A name can be 60 characters and the instructions 8,000. You can keep 40 skills.
A long skill is sent in full every time you invoke it, so it spends included
usage each time.

## Agent rules

**Agent rules** in the sidebar holds standing rules that every agent receives at
the start of each turn, in every project. Changes apply to the next turn.

- **Instructions for every agent** is free text given to Codex, Claude Code and
  Cursor chats as written.
- **Hand off work to a cheaper model** lets a chat give certain kinds of work to
  a worker model you choose instead of doing them on its own model. Pick the
  worker, optionally a fallback worker, tick the kinds of work you allow, and
  switch the rule on. Nothing is selected until you choose.

What can be handed off:

| Kind of work                       | What the chat gets back                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| Read a file for the relevant parts | The lines that answer its question, verbatim with line numbers               |
| Extract facts into a list          | The values, each with its file and line                                      |
| Sort items by relevance            | The items in order, with a reason for each                                   |
| Summarise for orientation          | A short summary with file and line references                                |
| Locate code or files               | Paths and line numbers                                                       |
| One specified edit to one file     | The diff of what changed, to review                                          |
| Run a command and report           | The exit code and the output, or its relevant lines verbatim when it is long |
| Draft a commit or changelog        | Text written from the uncommitted diff, to review                            |

Everything else stays on the chat's own model, and the agent is told so:
anything that must be exhaustive or prove absence, changes across several files,
configuration or infrastructure, new code or tests, multi-step terminal work,
planning, debugging and final review.

How the decision is made:

- Harness decides on every call, so no model spends tokens estimating. It
  compares the whole round trip (starting the worker, the worker's tokens, and
  the chat's model reading and checking the result) with the chat's model doing
  the work itself, and uses the worker only when that is at least a tenth cheaper.
- The sizes come from things Harness can measure for free: the files named, the
  command's output, the diff. What a worker costs comes from what that worker
  actually used on its recent runs of the same kind of work; until it has run,
  fixed starting figures are used.
- Tokens are weighed at list prices, so a token on a cheap model counts for less
  than one on an expensive model. The prices are a dated table in
  `src/core/prices.mjs`. A model with no price in that table is never compared,
  so nothing is handed to it or away from it.
- A job under about 2,000 tokens is never handed off. The saving would be a
  fraction of a cent and not worth the wait.
- When the worker is not cheaper, Harness does the plain part itself with no
  model: it returns the file text, the command output, or the lines an exact
  search for a name finds. An edit or draft that would not pay is declined and
  the chat does it.
- A kind of work that can never pay for a given pair of models is not offered
  to that chat at all. For example, with a worker only four times cheaper than
  the chat's model, drafts and small edits are left out.
- Each hand-off appears in the Work log with the worker, its tokens and its cost
  as a share of the estimate for the chat's own model. So does each job Harness
  did itself.

What a worker may do:

- A worker can be on a different provider from the chat. Harness runs it itself,
  so this does not depend on either provider's own subagents.
- For reading, extracting, sorting, summarising, command output and drafts, the
  worker is given the material and has no tools at all.
- A locating worker can search, list and read files in the project and nothing
  else.
- An editing worker may change the one file it was given and nothing else. If it
  fails part-way, Harness puts the file back as it was.
- A command runs only after you approve it, in PowerShell, with a ten-minute
  limit. Harness runs it; the worker only ever sees its output.
- A worker spends its own provider's included usage and passes the same
  subscription checks as a chat turn. A Codex chat with a Claude worker
  therefore spends Claude usage.
- Claude Code and Codex chats are covered. Cursor chats are not, and a Cursor
  model cannot be a worker. A chat already running on the worker model does its
  own work.

When a worker cannot run:

- If the worker's provider is out of usage, signed out or blocked when a turn
  starts, the turn uses the fallback worker. If neither can run, the chat is not
  offered the tools for that turn and does its own work.
- A limit reached during a turn is caught when the worker checks its own usage.
  That worker is skipped for the rest of the turn, the next one is tried, and
  provider status is refreshed.
- A worker that takes longer than five minutes or fails for another reason also
  gives way to the next one. A chat never fails because its worker could not run.
- The settings screen shows each worker's current status and one line saying
  where a hand-off would go right now. Every fallback is written to the Work log
  with the provider's reason.

Limits to keep in mind:

- The comparison counts parent-held input twice: once for this turn and once
  for a later turn that re-reads it. That applies to a file the chat would read,
  an unread file before an edit, the fixed search assumption, and the worker's
  answer that stays in the chat. A job under about 2,000 tokens is still never
  handed off.
- What a search would cost the chat's own model cannot be measured beforehand,
  so locating uses a fixed assumption of about 6,000 tokens, counted twice.
- A worker's answer can be wrong or incomplete. That is why exhaustive and
  absence questions are kept on the chat's model, edits come back as a diff, and
  the agent is told that "not found" is not proof.
- The fallback covers the worker's provider only. A chat whose own provider is
  out of usage still cannot run.

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

In **Auto-review**, the automatic reviewer allows or declines commands, edits,
and browser actions. It decides coding and command questions itself. It asks you
only for a managerial choice the task did not already settle, such as spending
money, publishing or sending something, signing in, or changing the goal, and
the note explains that choice in plain language. If automatic review cannot run,
the action comes to you with that reason; decline it if you are not sure.
In Goal, a review that asks you or cannot run is declined and the agent continues.
**Manual** shows each request for **Allow once**. **Override** allows actions
without asking. A plan still comes to you as one **Confirm and build** button,
except in Goal, where a plan is carried out and the chat stays in Goal. Agents are told to ask only a managerial question,
and to explain why they cannot decide it. In Goal that question waits 60 seconds
and then the agent chooses. In every other mode a question stays open until you send an answer or stop the turn. Reading it or typing an answer does not start a countdown.

Requested commands, tool actions, plans and questions appear in the conversation
when they need you. Open the action details before **Allow once**. Approvals are
limited to that request. **Decline** rejects it. The square stop button interrupts
work and expires pending approvals. A repeated approval response cannot apply twice.

Agent questions use selectable cards with the agent's brief explanation beneath
each option. Choose one option, or several when the question allows it. Choose
**Other** to write a different response; questions without suggested options
show a response field directly. **Send answer** stays disabled until each
question has an answer. A failed submission keeps your answers for retry.

Agents are instructed to explain each option's benefit or tradeoff. Cursor's
current ACP bridge accepts option IDs but drops free text, so Harness forwards
Other answers through its supported question feedback reason, including any
other selections from the same form.

Native provider permission models differ. Some workspace reads/edits need no
prompt under a provider's own policy. Harness does not claim that every operation
is independently sandboxed. Read-only references are directional context and have
no writable app API; never approve a command that writes to one unless you intend
to change the task scope. Agent execution has the current Windows user's powers
where a provider permits it or you approve an unsandboxed command.

This PC's Codex Windows sandbox sometimes fails with `apply deny-read ACLs`.
Harness preserves that failure and the agent can request approval for a command
outside the sandbox. In Auto-review the automatic reviewer decides that request
the same way it decides any other command. The app does not disable the sandbox
globally or automatically approve the workaround.

## Browser for agents

Every Codex, Claude Code and Cursor chat can drive a browser through one
`browser` tool. Harness checks the action against Playwright's schemas and runs
one Chrome on the host PC. Chats share that Chrome, so a page stays open
between turns. It uses its own
profile in `%LOCALAPPDATA%\AgenticHarness\browser\profile`, separate from your
everyday Chrome: sign in to a site there once and the sign-in persists. Saved
snapshots and screenshots go to `browser\output` beside it. The window is visible
on the host PC; close it any time and the next browser action reopens it.

Reading the page (snapshot, screenshot, find, console and network listings,
waiting) needs no prompt. Anything that can change a page or leave this PC
(navigating, clicking, typing, filling forms, running page script, uploading a
file, managing tabs) is decided by the automatic reviewer in **Auto-review**,
which asks you only for a managerial choice such as signing in, posting, or
paying. In **Manual**, each of those actions asks for **Allow once**, titled
with the action and its target. Playwright's tool for running arbitrary code on
the host is never offered. Chats share the browser, so their actions run one at
a time; Chrome must be installed. If the browser cannot start, the turn goes on
without it and the work log says why.

## History and changing agents

All chat text, run outcomes, tool activity, review comments, artifacts and decisions
are recorded in SQLite. Search conversations by words, filenames or decisions.
Search results link to the source conversation and retain provider attribution.
Agents can call `history_search`, `history_read`, `project_notes`,
`project_note_read`, and `workspace_activity` on demand. Harness also searches
the current project's Project Log for each request and includes up to three
active matching entries, capped at about 500 estimated tokens. A `project_notes`
query returns up to five concise matches; use `project_note_read` for a full
entry. Stale entries stay out of automatic context and search unless requested.
Both tools respect the conversation's history scope. `history_read` returns
four messages at a time, each capped at 2,000 characters. Pass a query to get
short windows around matches. Older text stays in the archive.
`workspace_activity` lists the other chats working in the same folder.
On a chat's first message the agent is asked to call `rename_chat` with a short
summary title. It works once and never replaces a title you set yourself; you can
still rename any chat from its menu.

In **Connections & usage → Conversation history**, choose **This conversation**,
**This project**, or **All projects** as the history access for new conversations.
The default is **All projects** and is saved in the host's SQLite settings across
browser refreshes and host restarts. Each conversation keeps the scope it was
created with; its footer shows that scope without a selector. Changing the default
does not change existing conversations, reset their native sessions, or delete
their transcripts. Conversations created before this setting retain their scope.

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

**New terminal** in the sidebar opens PowerShell in the selected project as its
own pane, the way a conversation opens. Ctrl-click opens it beside the current
pane. Open terminals are listed under **Terminals** in the sidebar; closing a
pane keeps the shell running, and the **End** button or the sidebar close button
stops it. The Terminal tab in the work panel starts shells in the focused
chat's worktree.

A terminal pane has tabs. **+** in the tab bar adds a PowerShell or Command
Prompt tab to that terminal, in the same folder. The arrow beside **New
terminal** starts a new terminal window with either shell. Each tab is its own
shell and keeps running while hidden or while the pane is closed. Ending a
terminal stops all of its tabs. Up to sixteen tabs can be open in total.
The **Terminals** section of the sidebar folds away, and stays folded after a
reload. A terminal that nobody has run a command in is removed, not kept, when
its pane is closed or replaced; once any tab has had a line submitted, it stays
in the list until you end it.

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
audience, expiry and owner email). That verified sign-in is all a remote browser
needs; there is no pairing code. No app is needed on the remote device.

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
PC. Open that address in any browser (Chrome, laptop, iPhone Safari) and sign in
through Cloudflare Access. The sign-in lasts for the Access application's session
duration, set in the Zero Trust dashboard. Because that sign-in is the only gate,
use an identity provider with two-step verification rather than one-time email
codes. On iPhone, optionally add the page to the Home Screen using Safari's Share
menu.

On the host PC itself, any browser can open `http://127.0.0.1:47831` (or
`localhost`) directly. Requests from this computer need no pairing; tunnel traffic,
which also arrives over loopback, is told apart by its host name and Cloudflare
headers.

The Windows host must remain awake, connected, and running Harness. Browser
disconnects do not cancel work. Event IDs replay missed updates. Retrying the
same submission after a lost response uses its original action ID to avoid a
second turn. An unconfirmed submission is saved in the browser tab's session
storage. After a reload the app checks whether its action was accepted; it either
shows the accepted run or restores the draft with the original action ID. Nothing
is automatically resubmitted. An interrupted turn is never automatically re-executed.

After losing a device, revoke its sessions in the Cloudflare Zero Trust dashboard
and sign it out of the identity provider. Provider account logins are not affected.

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
from another database, then relaunch. Native session resumption
also requires the provider's own saved session to still exist; otherwise use a new
conversation and consult the restored history.

## Update or stop the host

When Harness runs from a clean Git checkout, changes delivered to its own source
through `land_changes` automatically queue a self restart. An agent working on
that source in Default or Goal mode can also call `restart_harness`. The tool
returns a queued status immediately; finish the turn normally. The update banner
shows preparation, blockers, completion and failures.
During the restart, a modal with an animated progress bar stays visible through
reconnection and any client reload. It closes automatically after the host is
accepting work and the workspace has loaded. Your saved drafts remain in place.

Harness exports the committed revision into a separate runtime, installs its
locked dependencies, builds it and runs the tests without inference. It waits
for all chats, queued messages, approvals, live terminals and host jobs to finish,
then checks five seconds of idle time before switching. Close terminal tabs to
allow an update; waiting never stops work for you. Uncommitted source changes or
a changed source branch also postpone the switch.

An unfinished or unconfirmed Goal blocks the switch even between native turns,
after a provider disconnect, or when its chat is archived or changes modes.
Harness never stops a Goal to apply an update; a continuing Goal can delay it
indefinitely. Confirmed completion, pause, blocking, or usage/budget limits allow
the update after all work settles and a fresh idle interval passes. Saved Goal
sessions from older versions have unconfirmed status until resumed or explicitly
stopped. For an unconfirmed Goal with no live run, send a message to continue or
use **Stop work** to release its hold.

A hidden helper keeps the same Windows session, port and configuration, takes a
private SQLite recovery copy and starts the replacement. Startup must pass its
readiness and revision checks before new work is admitted. A failed startup
restores the previous runtime and database, including browser pairings. Failed
revisions do not retry automatically; an agent can explicitly request another
attempt after fixing the problem. Prepared runtimes, recovery copies and the
helper log are under the data folder (`self-runtimes`, `self-restart-*.sqlite`,
and `self-restart.log`). Keep them private. The launcher preserves the selected
runtime across later starts and waits for an active restart helper.

Self delivery is enabled on the next clean host launch after this feature is
installed. It does not interrupt existing chats to activate itself. Portable and
installed release updates without a source checkout still follow the release
installation procedure below.

Release zips contain a complete runtime and dependencies. Back up first, stop
active work, close terminals and double-click **Stop Harness.vbs**. Extract the
new release and run **Install Harness.vbs**. Data stays in its separate folder.
Then launch the desktop shortcut. Provider CLIs are updated through their own
official distribution; refresh connections afterward.

Advanced commands are optional: `node scripts/launch.mjs --stop` and
`node scripts/launch.mjs --restart` provide graceful host control. Startup errors
are under the data folder in `host-errors.log` and `launcher-errors.log`.
The app does not fetch release updates or include an offline executor,
or cross-machine copy of provider credentials.

## Automatic startup

After building the source checkout or extracting a complete release, open
PowerShell as Administrator in the permanent app folder and run:

```powershell
.\scripts\install-boot-task.ps1
```

This registers and starts **Agentic Harness** in Task Scheduler. It uses the
current Windows account with no stored password, starts 30 seconds after boot,
and also triggers 15 seconds after that account signs in. Concurrent starts
are ignored. The supervisor runs with normal user permissions, permits battery
operation, has no execution time limit, and retries every 30 seconds if the
launcher exits. Task Scheduler also retries a failed supervisor three times.
The task opens no browser window; use the normal shortcut to open Harness.

Harness's coding agents require an interactive Windows desktop. Before sign-in,
the supervisor waits and retries the existing desktop handoff. The host and
agents become available after you sign in, and stay on that desktop session.
The task reuses a healthy host and follows Harness's safe self-restarts.
It reads the existing configuration and data under
`%LOCALAPPDATA%\AgenticHarness`; supervisor output is in `startup.log` there,
alongside the host and launcher logs.

Use a permanent folder, not a chat worktree or a temporary release folder.
Optional `-Root`, `-NodePath`, and `-DataDir` arguments select explicit locations;
the installer prefers the bundled Node runtime and otherwise resolves `node.exe`.
`-NoStart` registers the task without starting it. Reinstalling updates only this
task and saves its previous XML in the data folder. After moving the app or
installing a release in a new version folder, rerun the installer there.

To stop automatic startup and its supervisor, run these in an administrator
PowerShell:

```powershell
Disable-ScheduledTask -TaskName 'Agentic Harness'
Stop-ScheduledTask -TaskName 'Agentic Harness'
```

Stopping the task leaves its detached desktop host running. Once all chats and
terminals are finished, use **Stop Harness.vbs** or
`node scripts/launch.mjs --stop` to stop that host. To remove the startup task,
run `Unregister-ScheduledTask -TaskName 'Agentic Harness' -Confirm:$false`.
