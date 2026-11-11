import React, { useState } from "react";
import { Markdown } from "./components.jsx";

// The first line is the action; anything after it is supporting detail.
function splitStatement(statement) {
  const text = statement.trim(),
    lines = text.split("\n"),
    index = lines.findIndex((line) => line.trim());
  return {
    headline: lines[index]?.trim() ?? text,
    detail: lines.slice(index + 1).join("\n").trim(),
  };
}

export function OwnerPauseCard({ goal, watching, disabled, onAnswer }) {
  const [choice, setChoice] = useState(null),
    [reason, setReason] = useState(""),
    [output, setOutput] = useState(""),
    [problem, setProblem] = useState(""),
    [submitting, setSubmitting] = useState(false);
  const expectsText = goal.ownerPause.expects === "text";
  const { headline, detail } = splitStatement(goal.ownerPause.statement);
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
    <section className="approval owner-pause" aria-label="Waiting on you">
      <div className="eyebrow">Waiting on you</div>
      <h3>{headline}</h3>
      {detail && (
        <div className="owner-pause-statement">
          <Markdown text={detail} />
        </div>
      )}
      {goal.objective && (
        <span className="goal-objective" title={goal.objective}>
          Goal: {goal.objective}
        </span>
      )}
      {expectsText && !choice && (
        <label className="question-custom">
          {goal.ownerPause.prompt || "Your response"}
          <textarea
            rows={3}
            autoFocus
            value={output}
            disabled={submitting || disabled}
            placeholder={goal.ownerPause.prompt || "Write the requested value…"}
            onChange={(event) => setOutput(event.target.value)}
          />
        </label>
      )}
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
        {expectsText && !choice && (
          <button
            type="button"
            className="notice-action primary"
            disabled={submitting || disabled || !output.trim()}
            onClick={() => submit({ choice: "text", reason: output.trim() })}
          >
            Send
          </button>
        )}
        {!expectsText && (
          <button
            type="button"
            className="notice-action primary"
            disabled={submitting || disabled}
            onClick={() => submit({ choice: "done" })}
          >
            I've done this
          </button>
        )}
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
      <p className="owner-pause-hint">
        {expectsText
          ? "Send the requested value to resume the goal. Deny and Other need a reason."
          : "The goal resumes when you answer. Deny and Other need a reason."}
      </p>
      {watching && (
        <p className="owner-pause-hint">
          Background watchers are still running and may continue the goal
          first.
        </p>
      )}
    </section>
  );
}
