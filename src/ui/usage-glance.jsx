import React, { useEffect, useRef, useState } from "react";
import {
  providerStatusLabel,
  resetLabel,
  usageGlance,
  usageWindows,
  usageVerificationLabel,
} from "./status.mjs";

// Included usage left for each agent, at a glance in the top bar. Clicking it
// opens every limit window with its reset time.
export function UsageGlance({ providers, onOpenConnections }) {
  const [open, setOpen] = useState(false),
    root = useRef(null);
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
  const glances = providers
    .filter((p) => p.id !== "cursor")
    .map((p) => [p, usageGlance(p)]);
  if (!glances.length) return null;
  return (
    <div className="usage-glance" ref={root}>
      <button
        className={"usage-glance-trigger " + (open ? "active" : "")}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Usage remaining: 5-hour and weekly limits"
        onClick={() => setOpen(!open)}
      >
        {glances.map(([p, g]) => (
          <span
            className={`usage-chip ${p.id} ${g.level}`}
            key={p.id}
            title={usageVerificationLabel(p) ?? undefined}
            aria-label={`${p.name}: ${usageVerificationLabel(p) ?? g.bars
              .map((b) =>
                b.remaining === null
                  ? "usage unknown"
                  : `${b.remaining}% of ${b.name.toLowerCase()} left`,
              )
              .join(", ")}`}
          >
            {g.bars.map((b, i) => (
              <span className={"usage-chip-row " + b.level} key={i}>
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
                {b.short && <span className="usage-chip-span">{b.short}</span>}
              </span>
            ))}
          </span>
        ))}
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
                {usageVerificationLabel(p) && (
                  <p className="muted small" role="status" title={p.usage.lastConfirmedAt}>
                    {usageVerificationLabel(p)}
                  </p>
                )}
                {windows.length ? (
                  windows.map((w, i) => (
                    <div className="usage-meter" key={i}>
                      <div>
                        <span>{w.name}</span>
                        <strong>{w.remaining}% left{p.usage?.verificationStatus === "unknown" && " (last confirmed)"}</strong>
                      </div>
                      <progress max="100" value={w.remaining} />
                      {w.resetsAt && <small>{resetLabel(w.resetsAt)}</small>}
                    </div>
                  ))
                ) : (
                  <p className="muted small">
                    {p.connected
                      ? "This integration doesn’t report quota."
                      : (p.blockReason ?? "Not connected")}
                  </p>
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
