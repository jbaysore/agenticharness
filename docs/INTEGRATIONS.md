# Subscription integration evidence

Checked 2026-10-06 against the installed versions listed in PLAN.md. Recheck on
provider upgrades and account/plan changes. These are local personal integrations.

| Route                     | Supported interface                                             | Billing evidence                                                                                                                               | Enforcement and limits                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex / ChatGPT           | Official `codex app-server`, JSON-RPC over stdio                | `account/read.type=chatgpt`; `account/rateLimits/read.ordinaryUsageAllowed`; quota and credit fields                                           | Reject API/gateway auth, unknown or depleted included usage, and available paid credits until a reliable no-credit path exists. Use standard speed and the live model catalog.                                                     |
| Claude Code / Claude plan | Official Agent SDK controlling the unmodified CLI, native login | `claude auth status` reports claude.ai, firstParty and subscriptionType; native usage control independently confirms user-disabled extra usage | No `--bare` (it bypasses OAuth), API keys, gateway routes, fast mode, credit purchases, or budget flags misrepresented as subscription caps. Experimental native quota API is version-sensitive and fails closed when unavailable. |
| Cursor / Cursor plan      | Official `agent acp`, JSON-RPC over stdio                       | Official browser login and account dashboard with on-demand usage disabled                                                                     | Advertise parameterized model selection, then force `fast=false` when that option exists. Auto and exploded fast-only presets stay unavailable. Do not fabricate quota percentages or infer coverage from a model response. ACP itself does not document a billing-mode attestation. |

## Sources

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
app sets `fast=false` and stops unless Cursor confirms standard speed. Exploded
fast-only presets and Auto remain disabled. Effort stays at the provider default.

Cursor native task progress arrived as standard `tool_call`/`tool_call_update`
events (`rawInput._toolName=task`), rather than the documented optional
`cursor/task` notification. Both forms are supported. Native task IDs retain the
delegation label through subsequent status updates that omit the tool name.

Remote implementation follows [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
and its [CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve).
The app trusts only the explicitly configured owner identity supplied by that
loopback proxy and also requires an app session. It does not enable Funnel.
