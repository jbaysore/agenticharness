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

## Current delivery status

Real editing, test execution and handoff across all three agents pass. The app
includes streaming chat, native sessions, shared history search, review comments,
revision requests, file artifacts, decisions, approvals, and PowerShell terminals.
Up to three chats run side by side, the sidebar shows what every chat is doing,
and agents sharing a folder are told about each other; this has been checked
with a simulated provider, not yet with real providers running at once.
**Agent rules** holds standing instructions for every agent and can hand
eight kinds of work (reading, extracting, sorting, summarising, locating, a
single-file edit, running a command, drafting a commit message) to a cheaper
worker model on Claude Code or Codex. Harness works out each time whether the
hand-off is cheaper and falls back when the worker's provider is out of usage;
this too has only been checked with simulated providers.
Every chat can also drive a shared Chrome on the host through Playwright MCP;
each action that can change a page asks for approval unless **Override** is selected.
New conversations default to **Auto-review**. The permission picker saves each
selection immediately, including during a turn. Harness pauses the agent and
resumes its native session under the new mode, keeping the same conversation,
turn and completed work. **Override** bypasses permission review; questions still
require your input. Existing conversations keep their saved mode.
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
  are pinned to standard speed.

Connection checks and live catalogs adapt to plan changes. Unknown or exhausted
quota stops Codex/Claude. Cursor's account-level disabled on-demand setting is the
billing boundary. The app never supplies an inference API key or buys credits.

## Development

Node 24, Windows x64. Run `npm ci --include=dev`, `npm run build`, `npm test`, then
double-click **Launch Harness.vbs**. `npm run package` creates the Windows zip.
`npm run preview:design` screenshots the main screens against seeded chats into
`.local/screenshots`, with no provider calls, for reviewing visual changes.
`node scripts/acceptance.mjs` is an **opt-in real provider test** that consumes
included usage and edits an ignored fixture. Ordinary tests use no inference.

All repository changes go directly to `main`, following [AGENTS.md](AGENTS.md).

The app icon carries the UI's three strokes, one in each agent's color (Codex
blue, Claude Code orange, Cursor violet), onto a dark tile. Its editable
source is `src/ui/icons/harness.svg`; `npm run build:icons` regenerates the committed
PNG and multi-size Windows ICO assets using local Edge. Normal builds copy those
assets for the browser, home-screen icon and installed desktop shortcut.
