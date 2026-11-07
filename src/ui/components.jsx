import React, { useEffect, useState, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { providerName } from "./voice.mjs";
import { secondsRemaining, serverClock } from "./clock.mjs";
import { QuestionField, questionId, questionAnswer } from "./question-form.jsx";
import { questionPage } from "../core/questions.mjs";
import { rewriteHarnessLinks } from "./file-links.mjs";

function useClock(active) {
  const [now, setNow] = useState(() => serverClock.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(serverClock.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const paths = {
  attach: "m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9m-2 14 7-7",
  plus: "M12 5v14M5 12h14",
  chat: "M5 4h14v12H9l-4 4V4Z",
  folder: "M3 6h7l2 3h9v11H3V6Z",
  chevron: "M9 6l6 6-6 6",
  search: "m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  terminal: "m5 7 5 5-5 5m8 0h6",
  review: "M8 4H4v16h4M16 4h4v16h-4M9 8h6M9 12h6M9 16h6",
  file: "M6 3h8l4 4v14H6V3Zm8 0v5h5",
  activity: "M2 12h5l3-8 4 16 3-8h5",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
  arrow: "M12 20V4m-6 6 6-6 6 6",
  stop: "M6 6h12v12H6Z",
  close: "m6 6 12 12M6 18 18 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  sidebar: "M3 4h18v16H3V4Zm6 0v16",
  panel: "M3 4h18v16H3V4Zm12 0v16",
  split: "M3 4h18v16H3V4Zm9 0v16",
  edit: "M4 20h4L19 9l-4-4L4 16v4Zm10-14 4 4",
  archive: "M3 5h18v4H3V5Zm2 4v10h14V9M10 13h4",
  pin: "M12 16v6M8 4h8l-1 7h3l-6 5-6-5h3L8 4z",
  rules:
    "m4 6 1.5 1.5L8 5m3 1h9M4 12l1.5 1.5L8 11m3 1h9M4 18l1.5 1.5L8 17m3 1h9",
  skill: "M6 3h12v18l-6-4-6 4V3Z",
  refresh: "M20 10a8 8 0 1 0-1 7M20 4v6h-6",
  check: "m5 12 4 4 10-10",
  info: "M12 11v6m0-10v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  link: "m9 15 6-6M7 14l-2 2a3 3 0 0 0 4 4l4-4M11 8l4-4a3 3 0 0 1 4 4l-2 2",
  globe:
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z",
  back: "M19 12H5m6-6-6 6 6 6",
  forward: "M5 12h14m-6-6 6 6-6 6",
  expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
  collapse: "M19 11h-6V5M5 13h6v6M13 11l7-7M11 13l-7 7",
};
export function Icon({ name, size = 18 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "more" ? (
        <>
          <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
        </>
      ) : (
        <path d={paths[name] ?? paths.file} />
      )}
    </svg>
  );
}
export function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
export function Markdown({ text }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(
        rewriteHarnessLinks(marked.parse(text ?? "", { breaks: true })),
      )
        // Code blocks get a header naming the language, with a copy button.
        .replace(
          /<pre><code(?: class="language-([\w+#.-]+)")?>/g,
          (open, lang) =>
            `<div class="code-block"><div class="code-head"><span>${lang ?? "code"}</span><button type="button" data-copy>Copy</button></div>${open}`,
        )
        .replaceAll("</code></pre>", "</code></pre></div>"),
    [text],
  );
  const copy = (e) => {
    const button = e.target.closest?.("[data-copy]");
    if (!button) return;
    const code = button.closest(".code-block")?.querySelector("code");
    navigator.clipboard?.writeText(code?.textContent ?? "").then(() => {
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy"), 1500);
    });
  };
  return (
    <div
      className="markdown"
      onClick={copy}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
export function Modal({ title, children, onClose, wide = false }) {
  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={"modal " + (wide ? "wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

const PLAN_ASSESSMENTS = {
  sound: "Sound",
  sound_with_suggestions: "Sound with suggestions",
  needs_revision: "Needs revision",
};
function reviewFeedback(result) {
  const lines = [
    `Independent review (${PLAN_ASSESSMENTS[result.assessment]}): ${result.summary}`,
  ];
  if (result.concerns.length) {
    lines.push("", "Concerns:");
    for (const concern of result.concerns)
      lines.push(
        `- ${concern.title} (${concern.severity}, ${concern.confidence} confidence): ${concern.scenario} Evidence: ${concern.evidence} Suggestion: ${concern.suggestion}`,
      );
  }
  if (result.improvements.length) {
    lines.push("", "Improvements:");
    for (const item of result.improvements)
      lines.push(`- ${item.title}: ${item.detail}`);
  }
  return lines.join("\n");
}
function PlanReview({ review, disabled, onSend }) {
  const [showMinor, setShowMinor] = useState(false);
  if (!review) return null;
  if (review.status === "running")
    return (
      <p className="plan-review-status">
        {review.reviewer?.name
          ? `Reviewing with ${review.reviewer.name}…`
          : "Reviewing the plan…"}
      </p>
    );
  if (review.status === "failed" || review.status === "cancelled")
    return (
      <p className="error-text">
        {review.error || "The plan review did not finish."}
      </p>
    );
  if (review.status !== "done" || !review.result) return null;
  const { result } = review;
  const minor = (concern) =>
    concern.severity === "low" && concern.confidence === "low";
  const hidden = result.concerns.filter(minor);
  const shown = showMinor
    ? result.concerns
    : result.concerns.filter((concern) => !minor(concern));
  return (
    <div className="plan-review">
      <p className={"plan-assessment " + result.assessment}>
        {PLAN_ASSESSMENTS[result.assessment]}
      </p>
      <p>{result.summary}</p>
      <h4>Concerns</h4>
      {shown.length ? (
        <ul>
          {shown.map((concern, index) => (
            <li key={index}>
              <strong>{concern.title}</strong>{" "}
              <span className="muted small">
                {concern.severity}, {concern.confidence} confidence
              </span>
              <div>{concern.scenario}</div>
              <div className="muted small">Evidence: {concern.evidence}</div>
              <div className="muted small">
                Suggestion: {concern.suggestion}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No significant concerns found</p>
      )}
      {hidden.length > 0 && (
        <button
          type="button"
          className="secondary"
          onClick={() => setShowMinor((open) => !open)}
        >
          {showMinor
            ? "Hide minor notes"
            : `Show ${hidden.length} minor ${hidden.length === 1 ? "note" : "notes"}`}
        </button>
      )}
      {result.improvements.length > 0 && (
        <>
          <h4>Improvements</h4>
          <ul>
            {result.improvements.map((item, index) => (
              <li key={index}>
                <strong>{item.title}</strong>
                <div>{item.detail}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      {result.questions.length > 0 && (
        <>
          <h4>Open questions</h4>
          <ul>
            {result.questions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ul>
        </>
      )}
      <button
        type="button"
        className="secondary"
        disabled={disabled}
        onClick={onSend}
      >
        Send review to agent
      </button>
    </div>
  );
}

export function Approval({ approval, onAnswer, review, onReview }) {
  const [responses, setResponses] = useState({}),
    [page, setPage] = useState(0),
    [revisingPlan, setRevisingPlan] = useState(false),
    [feedback, setFeedback] = useState(""),
    [submitting, setSubmitting] = useState(false),
    [copied, setCopied] = useState(false),
    r = approval.request,
    now = useClock(r.kind === "question" && Number.isFinite(r.deadline)),
    remaining = secondsRemaining(r.deadline, now);
  const answers = Object.fromEntries(
    (r.questions ?? []).map((q) => [
      questionId(q),
      questionAnswer(q, responses[questionId(q)]),
    ]),
  );
  const step =
    r.kind === "question" ? questionPage(r.questions, answers, page) : null;
  const current = r.questions?.[step?.index ?? 0];
  const [problem, setProblem] = useState("");
  const respond = async (answer) => {
    if (submitting) return;
    setProblem("");
    setSubmitting(true);
    try {
      await onAnswer(answer);
    } catch (error) {
      setProblem(error.message);
      setSubmitting(false);
    }
  };
  const copyPlan = () =>
    navigator.clipboard?.writeText(r.plan).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <section className={"approval " + (approval.provider ?? "")}>
      <div className="eyebrow">
        {r.kind === "question"
          ? `${providerName(approval.provider)} has a question`
          : r.kind === "plan"
            ? `${providerName(approval.provider)} has a plan`
            : r.kind === "mode-change"
              ? `${providerName(approval.provider)} suggests a mode change`
              : `${providerName(approval.provider)} needs you`}
      </div>
      <h3>{r.title}</h3>
      {r.reviewReason && (
        <p className="muted small">Auto-review: {r.reviewReason}</p>
      )}
      {r.kind === "plan" ? (
        r.plan ? (
          <div className="plan-body">
            <Markdown text={r.plan} />
          </div>
        ) : (
          <p className="muted">
            The plan is unavailable. Ask the agent to present the complete plan
            before confirming.
          </p>
        )
      ) : r.kind === "mode-change" ? (
        <>
          <p>{r.reason}</p>
          {r.objective && (
            <p>
              <strong>Goal:</strong> {r.objective}
            </p>
          )}
          <p className="muted small">
            Your approval switches this chat to {r.mode} mode and continues the
            current task.
          </p>
        </>
      ) : r.kind === "question" ? (
        <>
          {remaining != null && (
            <p className="muted small">
              {remaining === 0
                ? "The agent is choosing."
                : `The agent chooses in ${remaining} ${remaining === 1 ? "second" : "seconds"} if you do not answer.`}
            </p>
          )}
          {step?.paged && <p className="question-page">{step.label}</p>}
          {current && (
            <QuestionField
              key={questionId(current)}
              question={current}
              value={responses[questionId(current)]}
              disabled={submitting}
              onChange={(value) =>
                setResponses((prior) => ({
                  ...prior,
                  [questionId(current)]: value,
                }))
              }
            />
          )}
        </>
      ) : (
        <details>
          <summary>Review requested action</summary>
          <pre>{JSON.stringify(r.details, null, 2)}</pre>
        </details>
      )}
      {r.kind === "plan" && (
        <PlanReview
          review={review}
          disabled={submitting}
          onSend={() => {
            if (!review?.result) return;
            setFeedback(reviewFeedback(review.result));
            setRevisingPlan(true);
          }}
        />
      )}
      {r.kind === "plan" && revisingPlan && (
        <label className="question-custom">
          What should change?
          <textarea
            autoFocus
            rows={3}
            value={feedback}
            disabled={submitting}
            placeholder="Tell the agent what is wrong or missing in the plan."
            onChange={(e) => setFeedback(e.target.value)}
          />
        </label>
      )}
      {problem && <p className="error-text">{problem}</p>}
      <div className="approval-buttons">
        {r.kind === "plan" && r.plan && (
          <button className="secondary copy-plan" onClick={copyPlan}>
            {copied ? "Copied" : "Copy plan"}
          </button>
        )}
        <button
          className="secondary"
          disabled={submitting}
          onClick={() => {
            if (r.kind === "plan") setRevisingPlan(!revisingPlan);
            else respond({ allow: false });
          }}
        >
          {r.kind === "plan"
            ? revisingPlan
              ? "Back"
              : "Keep planning"
            : r.kind === "mode-change"
              ? "Keep current mode"
              : "Decline"}
        </button>
        {r.kind === "plan" && onReview && !revisingPlan && (
          <button
            className="secondary"
            disabled={
              submitting ||
              !r.plan?.trim() ||
              review?.status === "running" ||
              review?.status === "done"
            }
            onClick={async () => {
              setProblem("");
              try {
                await onReview();
              } catch (error) {
                setProblem(error.message);
              }
            }}
          >
            Get independent review
          </button>
        )}
        {step?.canBack && (
          <button
            className="secondary"
            disabled={submitting}
            onClick={() => setPage(step.index - 1)}
          >
            Back
          </button>
        )}
        <button
          className="primary"
          disabled={
            submitting ||
            (r.kind === "plan" &&
              (revisingPlan ? !feedback.trim() : !r.plan?.trim())) ||
            (step && !step.primaryEnabled)
          }
          onClick={() => {
            if (r.kind === "plan" && revisingPlan)
              respond({ allow: false, reason: feedback.trim() });
            else if (step?.primary === "next") setPage(step.index + 1);
            else respond({ allow: true, answers });
          }}
        >
          {r.kind === "question"
            ? step?.primary === "next"
              ? "Next"
              : "Send answer"
            : r.kind === "plan"
              ? revisingPlan
                ? "Send feedback"
                : "Confirm and build"
              : r.kind === "mode-change"
                ? "Approve mode change"
                : "Allow once"}
        </button>
      </div>
    </section>
  );
}
