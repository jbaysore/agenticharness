// How long the history bridge waits for one tool call. A question or a mode
// suggestion stays open until the person answers or the turn stops. A clock
// here would close it while they are still reading or typing. Other calls
// stay bounded so a stuck tool cannot hold the agent open.
export function toolBridgeTimeoutMs(name) {
  if (name === "ask_user" || name === "suggest_mode") return null;
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
