export function checkCodexBilling(account, usage) {
  if (account?.type !== 'chatgpt') return 'Sign in to Codex with ChatGPT. API and gateway billing are disabled.';
  if (usage?.ordinaryUsageAllowed !== true) return usage?.ordinaryUsageAllowed === false ? 'Included Codex usage is exhausted. Wait for the provider to restore it.' : 'Included Codex usage could not be verified.';
  const buckets = Object.values(usage.rateLimitsByLimitId ?? { codex: usage.rateLimits }).filter(Boolean);
  if (!buckets.length) return 'Codex quota information is unavailable.';
  for (const bucket of buckets) {
    if (bucket.credits?.hasCredits !== false || bucket.credits?.unlimited !== false) return 'Codex credit fallback cannot be ruled out. Subscription-only runs are blocked while credits are available or unknown.';
    if (bucket.spendControlReached || bucket.rateLimitReachedType) return 'A provider usage limit has been reached.';
    if ([bucket.primary,bucket.secondary].some(w => w && w.usedPercent >= 100)) return 'Included Codex quota is exhausted.';
  }
  return null;
}

export function checkAccountConfirmation(confirmation, fingerprint, now = Date.now()) {
  if (!confirmation || confirmation.fingerprint !== fingerprint || confirmation.disabled !== true) return 'Verify paid usage is disabled in the provider account settings.';
  if (now - confirmation.verifiedAt > 24 * 60 * 60 * 1000) return 'Recheck the provider paid-usage setting. The previous verification is over 24 hours old.';
  return null;
}

export function publicCodexUsage(usage) {
  return {
    source: 'Codex account/rateLimits/read', authoritative: true,
    ordinaryUsageAllowed: usage?.ordinaryUsageAllowed ?? null,
    windows: Object.entries(usage?.rateLimitsByLimitId ?? { codex:usage?.rateLimits }).flatMap(([id,b]) => [
      ...[b?.primary,b?.secondary].filter(Boolean).map(w => ({ bucket:id, usedPercent:w.usedPercent, windowMinutes:w.windowDurationMins, resetsAt:w.resetsAt }))
    ]),
  };
}
