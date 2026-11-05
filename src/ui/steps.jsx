import React, { useState } from "react";
import { activityLabel, verbLabels } from "../core/steps.mjs";
import { IssueButton, TrackCheckButton } from "./reliability.jsx";

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
export function StepSummary({ steps, active, onOpenWork, chatId }) {
  const [open, setOpen] = useState(false);
  if (!steps?.length) return null;
  const running = active && steps.some((step) => step.status === "running");
  const label = activityLabel(steps);
  return (
    <div className={"steps" + (open ? " open" : "")}>
      <button
        className="steps-line"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {running && <span className="pulse-dot" />}
        <span className="steps-count">
          {label || (steps.length === 1 ? "1 step" : `${steps.length} steps`)}
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
                {chatId && s.sourceEventId && <details className="step-actions"><summary>Actions</summary>
                  {s.status !== "running" && s.verb === "run" && <TrackCheckButton chatId={chatId} targetId={s.id} />}
                  <IssueButton chatId={chatId} eventId={s.sourceEventId} />
                </details>}
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
