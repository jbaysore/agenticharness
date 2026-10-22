// Anchor countdowns to the host's HTTP Date header, then advance with a
// monotonic clock. A paired phone's wall clock can be wrong or change mid-turn.
export function createServerClock({
  wallNow = Date.now,
  monotonicNow = () => performance.now(),
} = {}) {
  let anchor;
  return {
    observe(date) {
      const at = typeof date === "string" ? Date.parse(date) : NaN;
      if (!Number.isFinite(at)) return;
      anchor = {
        // HTTP dates have second precision. Avoid guessing network latency or
        // server processing time; delay should add wait, never shorten it.
        at,
        received: monotonicNow(),
      };
    },
    now() {
      return anchor
        ? anchor.at + monotonicNow() - anchor.received
        : wallNow();
    },
  };
}

export const serverClock = createServerClock();
