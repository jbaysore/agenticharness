import React, { useEffect, useRef } from "react";
import { Icon } from "./components.jsx";

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
    phases = progress?.phases ?? [],
    completed = phases.filter((phase) => phase.status === "completed").length,
    live = chat.activeRun?.id === progress?.runId && ["starting", "active"].includes(progress?.status),
    status = progress?.status === "active" && !live ? "Progress last reported" : statusLabels[progress?.status],
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
          <strong>Goal progress</strong>
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
