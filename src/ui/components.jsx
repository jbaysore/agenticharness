import React, { useEffect, useState, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { providerName } from "./voice.mjs";
import { secondsRemaining, serverClock } from "./clock.mjs";
import { QuestionField, questionId, questionAnswer } from "./question-form.jsx";
import { questionPage } from "../core/questions.mjs";

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
  link: "m9 15 6-6M7 14l-2 2a3 3 0 0 0 4 4l4-4M11 8l4-4a3 3 0 0 1 4 4l-2 2",
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
      <path d={paths[name] ?? paths.file} />
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
        marked
          .parse(text ?? "", { breaks: true })
          .replace(
            /href="harness:\/\/conversation\/([^"#]+)(#[^"]*)?"/g,
            'href="/?chat=$1$2"',
          ),
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

export function Approval({ approval, onAnswer }) {
  const [responses, setResponses] = useState({}),
    [page, setPage] = useState(0),
    [submitting, setSubmitting] = useState(false),
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
      {problem && <p className="error-text">{problem}</p>}
      <div className="approval-buttons">
        <button
          className="secondary"
          disabled={submitting}
          onClick={() => respond({ allow: false })}
        >
          {r.kind === "plan"
            ? "Keep planning"
            : r.kind === "mode-change"
              ? "Keep current mode"
              : "Decline"}
        </button>
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
            (r.kind === "plan" && !r.plan?.trim()) ||
            (step && !step.primaryEnabled)
          }
          onClick={() => {
            if (step?.primary === "next") setPage(step.index + 1);
            else respond({ allow: true, answers });
          }}
        >
          {r.kind === "question"
            ? step?.primary === "next"
              ? "Next"
              : "Send answer"
            : r.kind === "plan"
              ? "Confirm and build"
              : r.kind === "mode-change"
                ? "Approve mode change"
                : "Allow once"}
        </button>
      </div>
    </section>
  );
}
