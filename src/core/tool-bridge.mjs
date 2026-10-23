// Questions, mode suggestions, and command permission requests can wait for
// the person until the turn stops. Command execution has its own deadline;
// the bridge must not time out while its permission request is still open.
// Other calls stay bounded so a stuck tool cannot hold the agent open.
export function toolBridgeTimeoutMs(name) {
  if (name === "ask_user" || name === "suggest_mode" || name === "run_command")
    return null;
  if (/^(?:browser(?:_|$)|land_changes)$/.test(name ?? ""))
    return 15 * 60 * 1000;
  return 15_000;
}

// The client picks the token. A notification with any other token is ignored,
// so a missing token means there is nothing useful to send.
export function progressToken(message) {
  const token =
    message?.params?._meta?.progressToken ?? message?._meta?.progressToken;
  if (typeof token === "string" && token) return token;
  if (typeof token === "number" && Number.isFinite(token)) return token;
  return null;
}
