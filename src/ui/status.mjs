export function providerStatusLabel(provider) {
  if (
    provider?.blockReason &&
    /exhausted|usage limit has been reached/i.test(provider.blockReason)
  )
    return "Out of usage";
  if (provider?.blockReason) return "Setup needed";
  return provider?.connected ? "Connected" : "Checking…";
}
