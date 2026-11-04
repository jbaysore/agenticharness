import React, { useState } from "react";

export function OwnerPauseCard({ goal, disabled, onAnswer }) {
  const [choice, setChoice] = useState(null),
    [reason, setReason] = useState(""),
    [problem, setProblem] = useState(""),
    [submitting, setSubmitting] = useState(false);
  const submit = async (answer) => {
    if (submitting || disabled) return;
    setProblem("");
    setSubmitting(true);
    try {
      await onAnswer(answer);
    } catch (error) {
      setProblem(error.message);
      setSubmitting(false);
    }
  };
  const sendReason = () => {
    const text = reason.trim();
    if (!text) {
      setProblem(
        choice === "deny"
          ? "Deny needs a reason."
          : "Other needs a reason.",
      );
      return;
    }
    submit({ choice, reason: text });
  };
  return (
    <section className="notice owner-pause" aria-label="Waiting on you">
      <strong>Waiting on you.</strong>{" "}
      The goal resumes when you confirm this is done, or when you deny it or
      choose Other and give a reason.
      {goal.objective && (
        <span className="goal-objective" title={goal.objective}>
          {goal.objective}
        </span>
      )}
      <p className="owner-pause-statement">{goal.ownerPause.statement}</p>
      {choice && (
        <label className="question-custom">
          {choice === "deny" ? "Why not?" : "What should happen instead?"}
          <textarea
            rows={3}
            autoFocus
            value={reason}
            disabled={submitting || disabled}
            placeholder={
              choice === "deny"
                ? "Say why this will not be done."
                : "Say what you want the goal to do instead."
            }
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      )}
      {problem && <p className="error-text">{problem}</p>}
      <div className="owner-pause-actions">
        <button
          type="button"
          className="notice-action primary"
          disabled={submitting || disabled}
          onClick={() => submit({ choice: "done" })}
        >
          I've done this
        </button>
        <button
          type="button"
          className="notice-action"
          disabled={submitting || disabled}
          aria-pressed={choice === "deny"}
          onClick={() => {
            setProblem("");
            setChoice("deny");
          }}
        >
          Deny
        </button>
        <button
          type="button"
          className="notice-action"
          disabled={submitting || disabled}
          aria-pressed={choice === "other"}
          onClick={() => {
            setProblem("");
            setChoice("other");
          }}
        >
          Other
        </button>
        {choice && (
          <button
            type="button"
            className="notice-action primary"
            disabled={submitting || disabled || !reason.trim()}
            onClick={sendReason}
          >
            Resume goal
          </button>
        )}
      </div>
    </section>
  );
}
