import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./components.jsx";
import { ClaudeResets } from "./claude-resets.jsx";
import { serverClock } from "./clock.mjs";
import {
  cursorResetDay,
  cursorResetLabel,
  providerStatusLabel,
  resetCountdown,
  resetLabel,
  usageGlance,
  usageReadingStale,
  usageWindows,
  usageVerificationLabel,
} from "./status.mjs";

// Included usage left for each agent, at a glance in the top bar. Clicking it
// opens every limit window with its reset time.
export function UsageGlance({ providers, onOpenConnections, onRefresh, refreshing }) {
  const [open, setOpen] = useState(false),
    [now, setNow] = useState(() => serverClock.now()),
    root = useRef(null);
  // Keep the reset countdowns current between provider updates.
  useEffect(() => {
    const tick = () => setNow(serverClock.now());
    const timer = setInterval(tick, 30000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, []);
  useEffect(() => setNow(serverClock.now()), [providers]);
  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const key = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const glances = providers.map((p) => [p, usageGlance(p, now)]);
  if (!glances.length) return null;
  return (
    <div className="usage-glance" ref={root}>
      <button
        className={"usage-glance-trigger " + (open ? "active" : "")}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Usage remaining and reset dates"
        onClick={() => setOpen(!open)}
      >
        {glances.map(([p, g]) => {
          const stale = usageReadingStale(p, now),
            note = usageVerificationLabel(p, now),
            described = g.bars
              .map((b) =>
                b.dateOnly
                  ? cursorResetLabel(b.resetsAt)
                  : b.remaining === null
                    ? "usage unknown"
                    : `${b.remaining}% of ${b.name.toLowerCase()} left` +
                      (b.resetsAt
                        ? `, resets in ${resetCountdown(b.resetsAt, now)}`
                        : ""),
              )
              .join(", ");
          return (
            <span
              className={`usage-chip ${p.id} ${g.level}${stale ? " stale" : ""}`}
              key={p.id}
              title={note ?? undefined}
              aria-label={`${p.name}: ${
                g.bars.every((b) => b.remaining === null) && note
                  ? note
                  : described + (stale ? ", stale" : "")
              }`}
            >
            <span className="usage-chip-name">
              {p.id === "claude" ? "Claude" : p.name}
              {stale && <span className="usage-stale">stale</span>}
            </span>
            {g.bars.length === 1 && g.bars[0].dateOnly ? (
              <span
                className="usage-chip-date"
                data-reset={g.bars[0].resetsAt}
                title={`${cursorResetLabel(g.bars[0].resetsAt)}. Assumed noon local time on the 14th.`}
              >
                <Icon name="refresh" size={10} />
                {cursorResetDay(g.bars[0].resetsAt)}
              </span>
            ) : (
            <span className="usage-chip-rows">
              {g.bars.map((b, i) => (
                <span className={"usage-chip-row " + b.level} key={i}>
                  <span className="usage-chip-span">{b.short}</span>
                  <span className="usage-chip-bar">
                    <span style={{ width: (b.remaining ?? 0) + "%" }} />
                  </span>
                  <span className="usage-chip-value">
                    {b.remaining === null
                      ? g.level === "out"
                        ? "0%"
                        : "–"
                      : b.remaining + "%"}
                  </span>
                  <span
                    className="usage-chip-reset"
                    title={b.resetsAt ? resetLabel(b.resetsAt, now) : undefined}
                  >
                    {b.resetsAt && (
                      <>
                        <Icon name="refresh" size={10} />
                        {resetCountdown(b.resetsAt, now)}
                      </>
                    )}
                  </span>
                </span>
              ))}
            </span>
            )}
          </span>
          );
        })}
      </button>
      {open && (
        <div
          className="usage-popover"
          role="dialog"
          aria-label="Usage remaining"
        >
          {glances.map(([p, g]) => {
            const windows = usageWindows(p);
            return (
              <section className={"usage-provider " + p.id} key={p.id}>
                <header>
                  <span className="provider-dot" />
                  <strong>{p.name}</strong>
                  {g.level !== "ok" && (
                    <span className={"usage-state " + g.level}>
                      {g.level === "out"
                        ? "Out of usage"
                        : g.level === "low"
                          ? "Running low"
                          : p.connected && !p.blockReason
                            ? p.usage?.verificationStatus === "unknown" ? "Unknown" : "No quota meter"
                            : providerStatusLabel(p)}
                    </span>
                  )}
                </header>
                {usageVerificationLabel(p, now) && (
                  <p className="muted small" role="status" title={p.usage.lastConfirmedAt}>
                    {usageVerificationLabel(p, now)}
                  </p>
                )}
                {windows.length ? (
                  windows.map((w, i) => (
                    <div className="usage-meter" key={i}>
                      <div>
                        <span>{w.name}</span>
                        <strong>{w.remaining}% left</strong>
                      </div>
                      <progress max="100" value={w.remaining} />
                      {w.resetsAt && <small>{resetLabel(w.resetsAt, now)}</small>}
                    </div>
                  ))
                ) : p.id === "cursor" ? (
                  <p
                    className="cursor-reset"
                    title="Assumed noon local time on the 14th of each month"
                  >
                    {cursorResetLabel(g.bars[0].resetsAt)}
                  </p>
                ) : (
                  <p className="muted small">
                    {p.connected
                      ? "This integration doesn’t report quota."
                      : (p.blockReason ?? "Not connected")}
                  </p>
                )}
                {p.id === "claude" && (
                  <ClaudeResets onRefresh={onRefresh} refreshing={refreshing} />
                )}
              </section>
            );
          })}
          <button
            className="usage-popover-link"
            onClick={() => {
              setOpen(false);
              onOpenConnections();
            }}
          >
            Connections & usage…
          </button>
        </div>
      )}
    </div>
  );
}
