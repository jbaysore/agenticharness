import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./components.jsx";
import { waitingPhrase } from "./status.mjs";

const statusLabels = {
  starting: "Starting",
  active: "In progress",
  paused: "Paused",
  blocked: "Blocked",
  waiting: "Waiting for CI",
  owner: "Waiting for you",
  usageLimited: "Usage limit reached",
  budgetLimited: "Budget limit reached",
  complete: "Complete",
  cleared: "Ended",
  unknown: "Progress last reported",
};

function SavedObjective({ objective }) {
  const [open, setOpen] = useState(false),
    root = useRef(null),
    trigger = useRef(null),
    tooltip = useRef(null),
    closeTimer = useRef(null),
    id = useId();
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const tip = tooltip.current, box = trigger.current.getBoundingClientRect(),
      width = Math.min(360, innerWidth - 24),
      above = box.top - 16, below = innerHeight - box.bottom - 16,
      upwards = above >= Math.min(220, below);
    Object.assign(tip.style, {
      width: `${width}px`,
      left: `${Math.max(12, Math.min(box.right - width, innerWidth - width - 12))}px`,
      maxHeight: `${Math.max(40, Math.min(300, upwards ? above : below))}px`,
      ...(upwards
        ? { bottom: `${innerHeight - box.top + 6}px`, top: "auto" }
        : { top: `${box.bottom + 6}px`, bottom: "auto" }),
    });
    tip.showPopover();
    const close = () => setOpen(false),
      outside = (e) => { if (!root.current.contains(e.target)) close(); },
      details = root.current.closest("details"),
      toggled = () => { if (!details.open) close(); },
      escape = (e) => {
        if (e.key !== "Escape") return;
        if (tip.contains(document.activeElement)) trigger.current.focus();
        close();
        e.stopPropagation();
        e.preventDefault();
      };
    window.addEventListener("resize", close);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    details.addEventListener("toggle", toggled);
    return () => {
      tip.hidePopover();
      window.removeEventListener("resize", close);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
      details.removeEventListener("toggle", toggled);
    };
  }, [open]);
  return (
    <span
      className="goal-objective-tip"
      ref={root}
      onMouseEnter={() => {
        clearTimeout(closeTimer.current);
        setOpen(true);
      }}
      onMouseLeave={() => {
        closeTimer.current = setTimeout(() => {
          if (!root.current.contains(document.activeElement)) setOpen(false);
        }, 150);
      }}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button ref={trigger} type="button" aria-label="Saved objective" aria-describedby={open ? id : undefined} onClick={() => setOpen(true)}>
        <Icon name="info" size={14} />
      </button>
      {open && <span ref={tooltip} id={id} className="goal-objective-tooltip" role="tooltip" popover="manual" tabIndex={0}>
        <strong>Saved objective</strong>
        <span>{objective}</span>
      </span>}
    </span>
  );
}

export function GoalProgress({ chat, compact = false }) {
  const details = useRef(null);
  useEffect(() => {
    const outside = (e) => {
      if (details.current?.open && !details.current.contains(e.target)) details.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  if (chat?.mode !== "goal") return null;
  const progress = chat.goalProgress,
    objective = chat.sessions?.[progress?.provider ?? chat.provider]?.goal?.objective,
    phases = progress?.phases ?? [],
    completed = phases.filter((phase) => phase.status === "completed").length,
    live = chat.activeRun?.id === progress?.runId && ["starting", "active"].includes(progress?.status),
    status = progress?.status === "waiting"
      ? waitingPhrase(chat)
      : progress?.status === "active" && !live
        ? "Progress last reported"
        : statusLabels[progress?.status],
    current = phases.find((phase) => phase.status === "in_progress") ?? phases.find((phase) => phase.status === "pending"),
    count = phases.length ? `${completed} of ${phases.length} phases complete` : "No phases recorded yet",
    phaseLabel = !phases.length ? "Waiting for the agent to record phases" : current?.label ?? "Finishing the Goal",
    activity = progress?.status === "complete" ? "Goal complete" :
      status && !live ? `${status} · ${phaseLabel}` : phaseLabel,
    chip = progress?.status === "complete" ? "Complete" :
      status && !live ? status : !phases.length ? "Waiting for phases" : current?.label ?? "Finishing";
  return (
    <section className="goal-progress" aria-label="Goal progress">
      <details
        key={progress?.goalId ?? chat.id}
        ref={details}
        onKeyDown={(e) => {
          if (e.key === "Escape" && e.currentTarget.open) {
            e.currentTarget.open = false;
            e.currentTarget.querySelector("summary").focus();
            e.stopPropagation();
          }
        }}
      >
        <summary aria-label={`Goal progress: ${count}. ${activity}`} title={`${count}. ${activity}`}>
          {live && <span className="pulse-dot" aria-hidden="true" />}
          <span className="goal-progress-count" aria-hidden="true">
            {phases.length ? `${completed}/${phases.length}` : "Goal"}
          </span>
          {!compact && <span className="goal-progress-current" aria-hidden="true">{chip}</span>}
          <span className="sr-text" aria-live="polite">{count}. {activity}</span>
          <span className="goal-progress-chevron"><Icon name="chevron" size={11} /></span>
        </summary>
        <div className="goal-progress-body">
          <div className="goal-progress-header">
            <strong>Goal progress</strong>
            {objective && <SavedObjective key={`${progress?.goalId}:${objective}`} objective={objective} />}
          </div>
          <span className="goal-progress-status">{status ? `${status} · ${count}` : count}</span>
          {phases.length > 0 && <ol aria-label="Goal phases">
            {phases.map((phase, index) => (
              <li key={index} className={phase.status}>
                <span className="goal-phase-mark" aria-hidden="true">
                  {phase.status === "completed" ? <Icon name="check" size={12} /> : index + 1}
                </span>
                <span>{phase.label}</span>
                <small>{({ pending: "Pending", in_progress: "In progress", completed: "Complete" })[phase.status]}</small>
              </li>
            ))}
          </ol>}
          {progress?.explanation && <p>{progress.explanation}</p>}
          {progress?.updatedAt && <time dateTime={progress.updatedAt}>
            Last updated {new Date(progress.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </time>}
        </div>
      </details>
    </section>
  );
}
