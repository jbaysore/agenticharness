# Agentic Harness

A personal Windows coding workspace for Codex, Claude Code and Cursor, using
their native subscription sign-ins. Chats and project history live on this PC.

## Open the app

Extract the complete Windows release zip. Double-click **Install Harness.vbs**
to install a copy under your user account and create **Agentic Harness** on your
desktop. Or double-click **Launch Harness.vbs** in the extracted folder for a
portable launch. No development commands or administrator account are needed.
The Windows package includes Node; each provider's official CLI stays separately
installed and owns its credentials.

The launcher opens an Edge app window and starts the local host if needed. Closing
the window leaves work running. The host binds to `127.0.0.1:47831`.

For automatic startup, run `scripts\install-boot-task.ps1` from an administrator
PowerShell in the permanent app folder after building or extracting the app.
The **Agentic Harness** scheduled task runs in the background after boot and
waits for your signed-in Windows desktop, which the coding agents require.
See [startup task setup and removal](docs/OPERATIONS.md#automatic-startup).

When running from its source checkout, Harness can deliver its own committed
changes and restart after every chat finishes and live terminals close. Agents
can also queue a safe restart with `restart_harness`. An update is built and
checked separately; startup failure restores the previous version. See
[self delivery and restart](docs/OPERATIONS.md#update-or-stop-the-host).

## Current delivery status

Real editing, test execution and handoff across all three agents pass. The app
includes streaming chat, native sessions, shared history search, review comments,
revision requests, file artifacts, decisions, approvals, and PowerShell terminals.
Paste screenshots into the chatbox, use the paperclip to upload files, or drag
files onto the composer. Preview or remove attachments before sending, with or
without message text. Each message accepts up to 10 files, 20 MB each; uploaded
files stay on this PC and remain linked in chat history. Attachment handling has
been checked in a real browser with a simulated agent.
Up to three chats run side by side; four use a two-by-two grid with compact,
ready-to-type composers. Each sidebar folder starts with six chats. **Show more**
doubles that limit to 12, 24, 48, and so on; **Show fewer** returns to six.
The sidebar shows what every chat is doing, and agents sharing a folder are told
about each other. These layouts have been checked with simulated providers,
not yet with real providers running at once.
Questions can offer one choice or several independent choices, with an Other
response available in either case. All three agents can ask these through the
shared Harness question tool.
**Agent rules** holds standing instructions for every agent and can hand
eight kinds of work (reading, extracting, sorting, summarising, locating, a
single-file edit, running a command, drafting a commit message) to a cheaper
worker model on Claude Code or Codex. Harness works out each time whether the
hand-off is cheaper and falls back when the worker's provider is out of usage;
this too has only been checked with simulated providers.
**Skills** are named instructions you write in the app. A message invokes one
with its slash command, and that message includes the full text for Codex,
Claude Code and Cursor.
Every chat can also drive a shared Chrome on the host through Playwright MCP;
in **Auto-review** the automatic reviewer approves each action that can change a
page, and in **Manual** each one asks you; read-only actions never ask.
New conversations default to **Auto-review**. The permission picker saves each
selection immediately, including during a turn. Harness pauses the agent and
resumes its native session under the new mode, keeping the same conversation,
turn and completed work. **Override** bypasses permission review; questions still
require your input. Existing conversations keep their saved mode.
The mode menu is separate from permissions. **Ask** is read-only: the agent
answers questions about the project and cannot change files, commits, or pages.
Cursor uses its native Ask mode; Codex is held in a read-only sandbox; Claude
Code can only read and search. **Plan** proposes work before changing anything,
and **Goal** keeps Codex or Claude Code working until a condition is met.
Plan approval cards include the complete proposal beside **Confirm and build**
and **Keep planning**, including after a reload. Confirmation is unavailable when
the proposal cannot be retrieved.
An agent in Goal stays there until that condition is met. It does not suggest
another mode, and carrying out a plan does not switch the chat back to Default.
Permission requests in Goal are decided by the automatic reviewer, including
when the picker is Manual, and a request that needs you is declined so the work
continues. Override still allows those actions. A question stays open for 60
seconds; if you do not answer, the agent chooses the path that best completes
the objective. The same question does not wait again after it times out, and
after three timeouts further questions are answered by the agent at once.
Agents in Default, Ask, or Plan can suggest a mode change with a reason and,
for Goal, a concrete objective. Every suggestion waits for your manual approval,
including under Auto-review and Override. Approving resumes the current task in
the chosen mode with the same conversation and native session; declining keeps
the current mode. Mode approval alone does not approve a plan or expand the
task scope.
Cursor's **Auto-review**, and browser actions under every agent's **Auto-review**,
use a separate Codex session, with a Claude subscription fallback if Codex cannot
review. Cursor's read-only Git commands, such as `git status` or `git diff`,
are allowed without a review unless you have refused an action in that chat.
Choose each model and effort in **Agent rules → Automatic reviewer**. Unpinned defaults show their current model names;
pinned choices never silently change. Saving applies to the next review, even
during a running turn. The reviewer evaluates each proposed action
against your request and project rules, then allows or declines it. Coding and
command questions are its decision. It asks you only for a managerial choice the
task did not already settle, such as spending money, publishing or sending
something, signing in, or changing the goal, and the reason explains that choice
in plain language. The activity log records its decisions. No worker setup
is needed. An explicit deny, or a request for that choice, is final. If neither
reviewer can run, the action comes to you with the reason review failed; decline
it if you are not sure. Paid extra usage remains blocked.
Remote access runs through a Cloudflare Tunnel behind Cloudflare Access; real
endpoint and physical laptop/iPhone validation are pending. See [daily-use instructions](docs/OPERATIONS.md),
[acceptance evidence](docs/ACCEPTANCE.md), [the delivery plan](docs/PLAN.md), and
[integration evidence](docs/INTEGRATIONS.md).

## Subscription controls

- Codex must report ChatGPT login, included usage available and no paid credits.
- Claude Code must report Claude sign-in, current quota and user-disabled extra
  usage. Fast mode and direct API routes are disabled.
- Cursor must use native login. Confirm **on-demand usage off** in its dashboard
  once. The app keeps that confirmation for the signed-in account. ACP supplies no
  reliable quota meter. Auto is omitted from the picker. Models that offer Fast
  are pinned to standard speed. A model offers effort levels once Harness has
  used it in a Cursor session.

Connection checks and live catalogs adapt to plan changes. Claude requires
verified subscription-only usage once per signed-in account during each host
session. Chats, connection refreshes and workers share that verification, so a
missing usage lookup between turns also keeps working while the meter shows
Unknown and the last confirmation time. Complete readings restore the meter
automatically. Account, organization, plan or login-route changes require fresh
verification; confirmed exhausted limits or enabled paid usage invalidate the
saved verification and stop the turn with a visible reason.
Claude usage reads are shared across chats, connection refreshes and workers,
at most once a minute while active. Missing or failed readings retry after five,
then ten, then fifteen minutes; a longer provider Retry-After is honored. Cached
reads retain their original confirmation time. Refresh also respects this cooldown.
For an available free Claude reset, use **Open Claude resets** in the header's
usage panel or **Connections & usage**. Redeem it on Claude's account usage page,
then return to Harness and choose **Refresh usage**. Claude controls reset
eligibility and confirmation; Harness does not redeem resets itself.
Unknown or exhausted quota stops Codex. Cursor's account-level disabled on-demand setting is the
billing boundary. The app never supplies an inference API key or buys credits.

## Development

Node 24, Windows x64. Run `npm ci --include=dev`, `npm run build`, `npm test`, then
double-click **Launch Harness.vbs**. `npm run package` creates the Windows zip.
`npm run preview:design` screenshots the main screens against seeded chats into
`.local/screenshots`, with no provider calls, for reviewing visual changes.
`node scripts/acceptance.mjs` is an **opt-in real provider test** that consumes
included usage and edits an ignored fixture. Ordinary tests use no inference.
`npm run test:attachments` checks paste, upload, drop, draft recovery and send
retries in a headless browser with a simulated agent and no inference.

All repository changes go directly to `main`, following [AGENTS.md](AGENTS.md).

The app icon carries the UI's three strokes, one in each agent's color (Codex
blue, Claude Code orange, Cursor violet), onto a dark tile. Its editable
source is `src/ui/icons/harness.svg`; `npm run build:icons` regenerates the committed
PNG and multi-size Windows ICO assets using local Edge. Normal builds copy those
assets for the browser, home-screen icon and installed desktop shortcut.
