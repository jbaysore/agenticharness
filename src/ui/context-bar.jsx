import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { contextView, cacheReuse } from "./context.mjs";

const count = (n) => (n == null ? "Unavailable" : n.toLocaleString("en-US"));
const short = (n) =>
  n == null
    ? "—"
    : Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(n);

export function ContextBar({ chat, provider, model }) {
  const [open, setOpen] = useState(false),
    [placement, setPlacement] = useState({}),
    root = useRef(null),
    trigger = useRef(null);
  const active = !!chat?.activeRun && chat.activeRun.provider === provider;
  const view = contextView(chat?.contextByProvider?.[provider], {
    model,
    active,
    started: chat?.runs?.some((r) => r.provider === provider),
  });
  const { reading, percent } = view;
  const reuse = cacheReuse(reading?.cache);
  useEffect(() => setOpen(false), [chat?.id, provider, model]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current.getBoundingClientRect(),
        viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0,
        height = viewport?.height ?? innerHeight;
      const above = box.top - top - 12,
        below = top + height - box.bottom - 12;
      const upwards = above >= Math.min(200, below);
      setPlacement({
        maxHeight: Math.max(40, Math.min(420, upwards ? above : below)),
        ...(upwards
          ? { bottom: "calc(100% + 6px)", top: "auto" }
          : { top: "calc(100% + 6px)", bottom: "auto" }),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    const escape = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
        e.stopPropagation();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const description = `${view.label}${view.used !== null && percent !== null ? `, ${count(view.used)} of ${count(view.window)} tokens` : ""}${view.outdated ? ", last reading" : ""}${view.updating ? ", updating" : ""}`;
  return (
    <div
      className={`context-meter ${view.level}${view.outdated ? " outdated" : ""}`}
      ref={root}
    >
      <button
        type="button"
        className="context-trigger"
        ref={trigger}
        aria-label={description}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <span className="context-label">{view.label}</span>
        <span
          className="context-track"
          role="progressbar"
          aria-label="Context used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent === null ? undefined : view.fill}
          aria-valuetext={description}
        >
          <span style={{ width: `${view.fill}%` }} />
        </span>
        <span className="context-count">
          {view.used !== null && reading?.state !== "compacting"
            ? `${short(view.used)}${view.window > 0 ? ` / ${short(view.window)}` : " tokens"}`
            : "—"}
        </span>
        {view.outdated && <span className="context-note">Last reading</span>}
        {view.updating && (
          <span className="context-updating" aria-hidden="true">
            ↻
          </span>
        )}
      </button>
      {open && (
        <div
          className="context-popover"
          style={placement}
          role="dialog"
          aria-label="Context details"
        >
          <strong>Conversation context</strong>
          {reading?.state === "compacting" && (
            <p>
              Updating after compaction. These are the last values reported
              before compaction.
            </p>
          )}
          {view.outdated && (
            <p>
              Last recorded reading. Waiting for a new provider measurement.
            </p>
          )}
          <dl>
            <dt>Model</dt>
            <dd>
              {reading?.resolvedModel ??
                reading?.model ??
                model ??
                "Unavailable"}
            </dd>
            <dt>Used</dt>
            <dd>{count(reading?.usedTokens)} tokens</dd>
            <dt>Working window</dt>
            <dd>{count(reading?.windowTokens)} tokens</dd>
            <dt>Available</dt>
            <dd>
              {reading?.usedTokens != null && reading?.windowTokens > 0
                ? `${count(Math.max(0, reading.windowTokens - reading.usedTokens))} tokens`
                : "Unavailable"}
            </dd>
            <dt>Source</dt>
            <dd>{reading?.source ?? "No provider measurement"}</dd>
            <dt>Measurement</dt>
            <dd>
              {reading?.basis === "last-request"
                ? "Last request estimate"
                : reading?.accuracy === "provider-estimated"
                  ? "Provider estimate"
                  : reading?.accuracy === "provider-reported"
                    ? "Provider report"
                    : "Unavailable"}
            </dd>
            <dt>Observed</dt>
            <dd>
              {reading?.observedAt
                ? new Date(reading.observedAt).toLocaleString()
                : "Awaiting a report"}
            </dd>
            <dt>Last request cache reuse</dt>
            <dd>
              {reuse === null
                ? "Unavailable"
                : `${Math.round(reuse)}% (${count(reading.cache.cacheReadTokens)} input tokens)`}
            </dd>
            {reading?.cache?.cacheWriteTokens != null && (
              <>
                <dt>Last request cache writes</dt>
                <dd>{count(reading.cache.cacheWriteTokens)} tokens</dd>
              </>
            )}
          </dl>
          {reading?.categories?.length > 0 && (
            <dl className="context-categories">
              {reading.categories.map((c, i) => (
                <React.Fragment key={i}>
                  <dt>
                    {c.name}
                    {c.kind === "buffer" ? " (reserve)" : ""}
                  </dt>
                  <dd>{count(c.tokens)}</dd>
                </React.Fragment>
              ))}
            </dl>
          )}
          {view.previous && (
            <p>
              Previous model reading: {view.previous.model},{" "}
              {count(view.previous.usedTokens)} tokens.
            </p>
          )}
          <p>
            Cached tokens still occupy context. This is separate from your
            subscription allowance.
          </p>
          <p>
            The working window may follow the provider’s compaction policy.
            Unsent drafts and unprocessed attachments are excluded. Measurements
            update when the provider reports them.
          </p>
        </div>
      )}
    </div>
  );
}
