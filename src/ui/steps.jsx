import React, { useState } from "react";
import { presentTense, summarize, verbLabels } from "../core/steps.mjs";

const duration = (ms) =>
  ms == null ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
function Delta({ added, removed }) {
  if (!added && !removed) return null;
  return (
    <span className="delta">
      {added ? <ins>+{added}</ins> : null}
      {removed ? <del>−{removed}</del> : null}
    </span>
  );
}

// One quiet line saying what a turn did; it opens into the individual steps.
export function StepSummary({ steps, active, onOpenWork }) {
  const [open, setOpen] = useState(false);
  if (!steps?.length) return null;
  const current = active ? steps.findLast((s) => s.status === "running") : null;
  return (
    <div className={"steps" + (open ? " open" : "")}>
      <button
        className="steps-line"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {current && <span className="pulse-dot" />}
        <span className="steps-count">
          {steps.length === 1 ? "1 step" : `${steps.length} steps`}
        </span>
        <span className="steps-parts">
          {current ? (
            <span className="steps-part now">{presentTense(current)}…</span>
          ) : (
            summarize(steps).map((part) => (
              <span
                key={part.verb}
                className={"steps-part" + (part.failed ? " failed" : "")}
              >
                {part.text}
                <Delta {...part} />
                {part.verb === "run" && (part.failed ? " ✗" : " ✓")}
              </span>
            ))
          )}
        </span>
        <svg className="steps-chevron" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      <div className="steps-body" inert={!open}>
        <div>
          <ol className="steps-list">
            {steps.map((s) => (
              <li key={s.id} className={"step " + s.status}>
                <span className="step-verb">{verbLabels[s.verb] ?? "Tool"}</span>
                <span className="step-target" title={s.target}>
                  {s.target}
                </span>
                <Delta {...s} />
                <span className="step-meta">
                  {s.status === "running" ? (
                    <span className="pulse-dot" />
                  ) : s.status === "failed" ? (
                    "failed"
                  ) : (
                    duration(s.ms)
                  )}
                </span>
              </li>
            ))}
          </ol>
          {onOpenWork && (
            <button className="text-button steps-log" onClick={onOpenWork}>
              Open in Work log
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
