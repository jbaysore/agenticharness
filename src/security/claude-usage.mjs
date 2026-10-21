// A turn starts with verified subscription-only usage. Later missing telemetry
// makes that reading stale; only an explicit billing boundary stops the turn.
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

export function checkClaudeBilling(auth, usage) {
  if (
    !auth.loggedIn ||
    auth.authMethod !== "claude.ai" ||
    auth.apiProvider !== "firstParty" ||
    !["pro", "max", "team"].includes(auth.subscriptionType)
  )
    return "Sign in to Claude Code with an included-usage Claude subscription. API, gateway and usage-based accounts are blocked.";
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

export function createClaudeUsageMonitor(
  auth,
  now = () => new Date().toISOString(),
) {
  let lastConfirmed = null,
    lastConfirmedAt = null;
  return {
    update(reading) {
      const problem = checkClaudeBilling(auth, reading);
      const unknown =
        !!problem && !!lastConfirmed && !confirmedBoundary(reading);
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
}
