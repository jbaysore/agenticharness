# Provider integration evidence

Checked 2026-10-06 against the installed versions listed in PLAN.md. Recheck on
provider upgrades and account/plan changes. These are local personal integrations.

| Route                     | Supported interface                                             | Billing evidence                                                                                                                               | Enforcement and limits                                                                                                                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex / ChatGPT           | Official `codex app-server`, JSON-RPC over stdio                | `account/read.type=chatgpt`; `account/rateLimits/read.ordinaryUsageAllowed`; quota and credit fields                                           | Reject API/gateway auth, unknown or depleted included usage, and available paid credits until a reliable no-credit path exists. Use standard speed and the live model catalog.                                                                                                            |
| Claude Code / Claude plan | Official Agent SDK controlling the unmodified CLI, native login | `claude auth status` reports claude.ai, firstParty and subscriptionType; native usage control independently confirms user-disabled extra usage | No `--bare` (it bypasses OAuth), API keys, gateway routes, fast mode, credit purchases, or budget flags misrepresented as subscription caps. Experimental native quota API is version-sensitive and fails closed when unavailable.                                                        |
| Cursor / Cursor plan      | Official `agent acp`, JSON-RPC over stdio                       | Official browser login and account dashboard with on-demand usage disabled                                                                     | Advertise parameterized model selection, then force `fast=false` when that option exists. Omit Auto and keep exploded fast-only presets unavailable. Do not fabricate quota percentages or infer coverage from a model response. ACP itself does not document a billing-mode attestation. |

## Sources

OpenRouter was added 2026-10-26 as a separate free-only API route. Exact model
approvals, external-data consent, fresh pricing and catalog identity are checked
at the server boundary. Credentials use Windows DPAPI and are excluded from
database backups and exports. Protocol, HTTP, permission and boundary tests use
simulated responses; headless Edge covers setup, the model picker, a real host
file-tool exchange, revocation and mobile layout. Windows DPAPI round-trip tests
use a fixture key. No live inference or real account connection has been tested.

- [OpenRouter model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)
- [OpenRouter model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)
- [OpenRouter provider price ceilings](https://openrouter.ai/docs/guides/routing/provider-selection#max-price)
- [OpenRouter client tools](https://openrouter.ai/docs/guides/features/tool-calling)

- [Codex app-server](https://learn.chatgpt.com/docs/app-server): authentication,
  models, effort, approvals, native sessions, streamed events, account limits.
- [Codex authentication](https://learn.chatgpt.com/docs/auth): ChatGPT subscription
  access versus API-key usage-based access.
- The installed Codex-generated `GetAccountRateLimitsResponse` specifies that
  `ordinaryUsageAllowed=null` is unavailable and must not be inferred from reset
  times or percentages. Generated schemas are local research, not hand-edited.
- [Claude programmatic usage](https://code.claude.com/docs/en/headless): `-p`,
  streaming, continuation, subagent events; bare mode does not use subscription login.
- [Claude authentication](https://code.claude.com/docs/en/authentication): credential
  precedence and account types; OAuth alone is not proof of a subscription because
  Console can also use OAuth.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference): effort,
  MCP permission prompt handler, streaming and restricted mode.
- [Claude legal/integration rules](https://code.claude.com/docs/en/legal-and-compliance):
  user sign-in to an unmodified binary is allowed; do not collect/intermediate tokens.
- [Claude usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans):
  disabling usage credits restricts use to the plan's included usage.
- [Cursor ACP](https://cursor.com/docs/cli/acp): custom clients, native login,
  streaming, permissions, cancellation, session loading and subagent notifications.
- [Cursor Windows installation](https://cursor.com/docs/cli/installation): native
  PowerShell installer is supported; WSL is not required by the tested version.
- [Cursor on-demand usage](https://cursor.com/help/account-and-billing/overages):
  disable on-demand usage to stop at included limits. A spending cap is not the
  same as disabling on-demand usage; enforcement may lag.
- [ACP configuration](https://agentclientprotocol.com/protocol/v1/session-config-options):
  discover selectable model, mode and effort options from the running agent.

## Findings to preserve

Do not assume the user's quoted plan tier is current. Discover capabilities at
connection time. Codex currently returns the raw plan code `prolite`; preserve
that code without inventing a marketing-name mapping. Seven picker models and
their individual effort choices were returned by the real app-server.

Paid-credit protection applies to native compaction/subagents as well as visible
messages. Disable paid modes at the provider account as the final billing
boundary. App-side polling alone cannot prevent a provider-side charge during an
already-running turn if the account permits paid fallback.

The installed Claude SDK is 0.3.292 with Claude Code 2.1.292. Its
`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` method reports native
account quota and `extra_usage` settings without inference. This is actual
provider telemetry, not a local usage estimate. Cursor 2026.10.01-e373342 returns
bare model ids, including Composer and Grok, when the client advertises
`parameterizedModelPicker`. Those models default the new session to Fast, so the
app sets `fast=false` and stops unless Cursor confirms standard speed. Auto is
omitted from the picker. Exploded fast-only presets remain disabled. Cursor lists a
model's `reasoning_effort` levels only once a session has selected it, so the
app records them as it sees them; the first level seen is the default.

Cursor native task progress arrived as standard `tool_call`/`tool_call_update`
events (`rawInput._toolName=task`), rather than the documented optional
`cursor/task` notification. Both forms are supported. Native task IDs retain the
delegation label through subsequent status updates that omit the tool name.

Remote implementation follows [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
and [Access token validation](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/).
The app trusts no proxy-supplied identity header. It verifies the RS256 signature
of `Cf-Access-Jwt-Assertion` against the team's published keys, then the issuer,
audience, expiry and owner email, and also requires an app session.

## Context and caching — 2026-10-27

Context occupancy, per-request model usage, and account quotas are separate.
Codex uses the root thread's `tokenUsage.last` and `modelContextWindow`, not
the cumulative `total`. Claude uses `getContextUsage({detail: "summary"})`;
never omit `detail`, because the SDK defaults to per-category token-count API
calls. Cursor accepts ACP `usage_update.used`/`size` when supplied. OpenRouter
uses returned request usage and live catalog capacity, labeled as an estimate.
Missing data stays unavailable. Cached tokens remain part of context occupancy.

Snapshots persist in `conversation_context` and the event log in one transaction.
Conversation snapshots expose `contextByProvider`; SSE emits `context-usage`.
Session/model provenance and context generations protect against late reads,
child-agent events, and compaction. Cancellation and recovery mark readings
outdated. No idle inference, cache warming, or draft-token prediction is used.

Prompt delivery tracks independent skill, Memory Web, and workspace blocks.
Delivery hashes commit only on acceptance; uncertain delivery remains pending.
Explicit skill reinvocations are delivered again. Compaction invalidates delivery
fingerprints. Full tool fingerprints are diagnostic and do not change the legacy
thread-migration key. Instructions retain their bytes, order, and priority.
Native compaction, model/effort selection, and all billing protections are unchanged.

Independent block delivery defaults on for Codex following native verification.
Other routes retain legacy combined addenda pending native validation; their
existing provider-managed caching remains active. The internal SQLite setting
`prompt-delivery-v2=false` rolls delivery back without resetting sessions or
disabling telemetry. A per-provider object, such as `{"codex":true}`, enables
only explicitly verified routes; `true` enables all routes and should only be
used after verifying them. This is an internal compatibility switch, not a
model-facing tool or a new public settings endpoint.

`node scripts/context-provider-smoke.mjs --codex` opts into two small turns
through the subscription adapter. On the installed Codex 0.164.0-alpha.11.1,
GPT-6.1 Sol retained the same native session and all three reference facts.
The second turn sent 27 addendum bytes instead of 168 and reported 18,176
cached input tokens. The native working window was 475,000 tokens; it is
reported dynamically, not hardcoded. These observations are not a universal
savings rate or a subscription charge estimate.

Claude and Cursor event handling is verified with protocol fixtures. An optional
Claude summary-control probe (`node scripts/probe-claude.mjs --context`, no
inference input) was not executed: automatic approval review rejected using
another provider from the current Codex integration. No live Claude/Cursor
caching improvement is claimed. UI acceptance uses isolated fixture providers.

References: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Codex app-server](https://learn.chatgpt.com/docs/app-server),
[Claude Code usage](https://code.claude.com/docs/en/costs),
[ACP usage schema](https://agentclientprotocol.com/protocol/v1/schema#sessionupdate),
[OpenRouter cache fields](https://openrouter.ai/docs/guides/best-practices/prompt-caching).
