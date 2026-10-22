# Future plan: optional cloud execution

Status: deferred proposal. This document records a future direction; implementation
is not scheduled, and no infrastructure purchase or deployment is authorized.
Recorded: 2026-10-22.

## Purpose

Allow suitable coding tasks to continue while the primary Windows PC is asleep or
off. Keep local execution as the default and preserve native subscription sign-ins,
included-usage limits, app-owned history, and explicit permissions.

Useful scenarios include starting a long task before leaving the desk, checking
results from a phone, and moving builds or tests off the primary PC. Model quality
still depends on the chosen model; remote execution mainly changes availability,
resources, and the working environment.

## Current position

Harness runs provider processes, commands, project worktrees, browser tools, and
SQLite history on one Windows host. Closing the browser window leaves work running.
Remote browser access connects clients to that host, which must remain awake and
connected. It does not supply a separate executor. Real endpoint and physical-device
checks remain recorded as pending in the current project documentation.

See [the delivery plan](PLAN.md),
[operations](OPERATIONS.md#private-laptop-and-iphone-access), and
[subscription integration evidence](INTEGRATIONS.md).

## Recommended sequence

### 1. Evaluate a limited Codex Cloud integration

Start with self-contained repository tasks using Codex's existing cloud
infrastructure. Official documentation describes an experimental cloud CLI that
submits tasks, lists status as JSON, and applies cloud changes locally.

The intended flow is to choose a published environment and repository revision,
submit explicit task instructions, retain the task identifier and execution
location in Harness, reconnect to status after a client or host restart, then
inspect and import the result into the originating chat's worktree. Imported work
must pass the project's checks and existing landing process.

Before building, verify the installed CLI, account access, cloud quotas,
included-usage enforcement, approval behavior, cancellation, and result retrieval.
Confirm whether the commands address the current cloud experience or a legacy
surface. Do not assume local app-server capabilities, history, tools, or permission
controls carry over. Treat cloud work as a separate task and an explicit handoff;
seamless native session transfer is unverified.

### 2. Evaluate an always-on personal Windows host if all providers are needed

If the requirement is to use Codex, Claude Code, and Cursor while the primary PC is
off, assess running the existing Harness host on an always-on personal machine or
VM before splitting execution across hosts.

Validate native provider sign-in and subscription protections on that host, Windows
tooling, private remote access, project synchronization, backup and recovery, and
ownership of app history. Use providers' supported sign-in flows; do not extract or
relay credentials from the primary PC. Recurring infrastructure spending requires
a separate owner decision.

### 3. Consider workers managed by Harness after demonstrated need

Separate task coordination from remote workers only if the simpler approaches
prove insufficient. A later design would need durable task records, authenticated
worker connections, isolated workspaces, provisioning and cleanup, quotas, secrets
handling, artifact transfer, cancellation, reconnect recovery, and controlled
delivery of changes.

Verify each provider independently. Windows builds and desktop-dependent checks
need a compatible worker or a later local validation step.

## Constraints and open decisions

- Preserve subscription-only AI usage. Stop at included limits; do not add
  inference API keys, paid credits, or paid fallback. Do not enable an execution
  route until its billing protections can be established.
- OpenAI's separately billed Agents API falls outside the current subscription-only
  design.
- Supply remote repositories, dependencies, configuration, and credentials
  explicitly. A checkout does not reproduce uncommitted files, ignored secrets,
  local databases, localhost services, or browser sessions.
- Define how dirty working trees and reference repositories are handled. Keep
  references read-only and Git state distinct.
- Preserve Ask-mode restrictions and the user's permission decisions. Identify
  cloud actions Harness cannot intercept or review before claiming equivalent
  controls.
- Retain task provenance, execution location, status, logs, and results with honest
  limits on transcript availability. Keep app-owned history and backups coherent.
- Handle uncertain submissions without duplicate tasks or duplicate application of
  changes. Preserve unfinished work after failure.
- Keep local execution available and avoid automatic migration of existing chats.
- Confirm hosted data handling, retention, access scope, and cleanup before enabling
  an environment. Select a cost model and budget separately if infrastructure costs
  are involved.

## Gate for a later implementation decision

Revisit when keeping the PC awake becomes a recurring obstacle, remote task demand
is demonstrated, or local resource contention affects daily use.

A small first implementation should be justified by evidence that it can:

1. Submit a repository task using supported native sign-in and verified
   included-usage protections.
2. Continue remotely while the primary PC is off.
3. Recover task identity and status after reconnecting without resubmission.
4. Show success, failure, cancellation, and required user decisions accurately.
5. Retrieve changes into the correct isolated worktree for review, checks, and
   delivery.
6. Preserve permission, credential, history, and repository boundaries.

These checks have not been run for cloud execution. Recheck provider documentation
and installed capabilities when the work is prioritized.

## Sources

Official pages reviewed during the 2026-10-22 discussion. Account behavior and the
installed cloud commands were not tested.

- [Codex Cloud](https://learn.chatgpt.com/docs/cloud)
- [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)
- [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Authentication](https://learn.chatgpt.com/docs/auth)
- [Agents API and pricing](https://developers.openai.com/api/docs/guides/agents-api/overview)
