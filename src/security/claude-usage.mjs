export const CLAUDE_USAGE_POLL_INTERVAL_MS = 60_000;

// Missing telemetry makes verified subscription-only usage stale. Only an
// explicit billing boundary invalidates it; turns share it for the same account.
function confirmedBoundary(usage) {
  const extra = usage?.rate_limits?.extra_usage;
  if (extra?.is_enabled === true)
    return "Paid Claude extra usage is enabled. Disable it before continuing.";
  if (extra?.user_disabled === false)
    return "Disable Claude usage credits at the account level; a temporarily empty credit balance is not sufficient.";
  if (
    Array.isArray(usage?.rate_limits?.limits) &&
    usage.rate_limits.limits.some((w) => w?.percent >= 100)
  )
    return "A Claude included-usage limit is exhausted.";
  return null;
}

function checkClaudeAccount(auth) {
  if (
    !auth?.loggedIn ||
    auth.authMethod !== "claude.ai" ||
    auth.apiProvider !== "firstParty" ||
    !["pro", "max", "team"].includes(auth.subscriptionType)
  )
    return "Sign in to Claude Code with an included-usage Claude subscription. API, gateway and usage-based accounts are blocked.";
  return null;
}

export function checkClaudeBilling(auth, usage) {
  const accountProblem = checkClaudeAccount(auth);
  if (accountProblem) return accountProblem;
  const boundary = confirmedBoundary(usage);
  if (boundary) return boundary;
  if (
    usage?.rate_limits_available !== true ||
    usage?.rate_limits?.extra_usage?.is_enabled !== false
  )
    return "The Claude CLI could not verify that paid extra usage is disabled.";
  if (usage.rate_limits.extra_usage.user_disabled !== true)
    return "The Claude CLI could not verify that usage credits are disabled at the account level.";
  const limits = usage.rate_limits.limits;
  if (
    !Array.isArray(limits) ||
    !limits.length ||
    limits.some((w) => !Number.isFinite(w?.percent))
  )
    return "Current Claude subscription quota is unavailable.";
  return null;
}

function publicUsage(usage) {
  const limits = usage?.rate_limits?.limits;
  return {
    source: "Claude Code native usage control (experimental, version checked)",
    windows: (Array.isArray(limits) ? limits : [])
      .filter((w) => Number.isFinite(w?.percent))
      .map((w) => ({
        bucket: w.kind,
        label: w.scope?.model?.display_name ?? w.scope?.surface?.display_name,
        usedPercent: w.percent,
        resetsAt: w.resets_at,
        windowMinutes: null,
      })),
    extraUsageEnabled: usage?.rate_limits?.extra_usage?.is_enabled ?? null,
  };
}

function retryAfterMs(error, now) {
  const headers = error?.response?.headers ?? error?.headers;
  const value = headers?.get?.("retry-after") ?? headers?.["retry-after"];
  if (value == null) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

// Keep only diagnostic categories and HTTP status, never arbitrary SDK error
// text: it may contain account details or credentials.
function lookupFailure(error, fallback) {
  if (!error) return fallback;
  const status = error.status ?? error.response?.status;
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? `Claude usage lookup failed (HTTP ${status}).`
    : "Claude usage lookup failed.";
}

export function createClaudeUsageMonitor(
  auth,
  now = () => new Date().toISOString(),
  {
    clock = Date.now,
    intervalMs = CLAUDE_USAGE_POLL_INTERVAL_MS,
    retryMs = 5 * 60_000,
    maxRetryMs = 15 * 60_000,
  } = {},
) {
  let lastConfirmed = null,
    lastConfirmedAt = null,
    current = null,
    pending = null,
    nextReadAt = 0,
    failures = 0,
    generation = 0;
  const monitor = {
    invalidate() {
      lastConfirmed = null;
      current = null;
      pending = null;
      nextReadAt = 0;
      failures = 0;
      generation++;
    },
    // All chats, catalog probes and workers for this account share both an
    // in-flight request and its result. Reusing it never advances confirmation.
    async read(fetchUsage) {
      if (pending) return pending;
      if (current && clock() < nextReadAt) return current;
      const startedGeneration = generation;
      const task = Promise.resolve()
        .then(async () => {
          let reading = null,
            error;
          try {
            reading = await fetchUsage();
          } catch (failure) {
            error = failure;
          }
          // A native boundary observed during the lookup takes precedence over
          // its older answer. It must not resurrect subscription verification.
          if (startedGeneration !== generation)
            return current ?? monitor.update(null);
          const problem = checkClaudeBilling(auth, reading);
          const failed = !!problem && !confirmedBoundary(reading);
          failures = failed ? failures + 1 : 0;
          const checkedAt = clock();
          const delay = failed
            ? Math.max(
                Math.min(retryMs * 2 ** Math.min(failures - 1, 10), maxRetryMs),
                retryAfterMs(error, checkedAt),
              )
            : intervalMs;
          nextReadAt = checkedAt + delay;
          const result = monitor.update(reading);
          current = {
            ...result,
            usage: {
              ...result.usage,
              lastAttemptAt: new Date(checkedAt).toISOString(),
              nextCheckAt: new Date(nextReadAt).toISOString(),
              lookupProblem: failed ? lookupFailure(error, problem) : null,
            },
          };
          return current;
        })
        .finally(() => {
          if (pending === task) pending = null;
        });
      pending = task;
      return task;
    },
    update(reading) {
      const problem = checkClaudeBilling(auth, reading);
      if (confirmedBoundary(reading)) lastConfirmed = null;
      const unknown = !!problem && !!lastConfirmed;
      if (!problem) {
        lastConfirmed = publicUsage(reading);
        lastConfirmedAt = now();
      }
      return {
        reason: unknown ? null : problem,
        usage: {
          ...(unknown ? lastConfirmed : publicUsage(reading)),
          ...(unknown && { extraUsageEnabled: null }),
          authoritative: !problem,
          verificationStatus: unknown
            ? "unknown"
            : problem
              ? "blocked"
              : "confirmed",
          lastConfirmedAt,
        },
      };
    },
  };
  return monitor;
}

// Keep verification in memory for this host, across chats, probes and workers.
// A changed account, organization, plan or login route must verify afresh.
export function createClaudeUsageTracker(now, polling) {
  let account = null,
    monitor;
  return (auth) => {
    const key =
      !checkClaudeAccount(auth) && auth.email && auth.orgId
        ? JSON.stringify([
            auth.email,
            auth.orgId,
            auth.subscriptionType,
            auth.configDirectory ?? null,
          ])
        : null;
    if (!key || key !== account) {
      monitor?.invalidate();
      account = key;
      monitor = createClaudeUsageMonitor(auth, now, polling);
    }
    return monitor;
  };
}

export const claudeUsageForAccount = createClaudeUsageTracker();
