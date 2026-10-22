import React, { useState, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { providerName } from "./voice.mjs";

const paths = {
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
  const [answers, setAnswers] = useState({}),
    [submitting, setSubmitting] = useState(false),
    r = approval.request;
  const questionId = (q) => q.id ?? q.question ?? q.header;
  const [problem, setProblem] = useState("");
  const respond = async (answer) => {
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
            : `${providerName(approval.provider)} needs you`}
      </div>
      <h3>{r.title}</h3>
      {r.reviewReason && (
        <p className="muted small">Auto-review: {r.reviewReason}</p>
      )}
      {r.kind === "plan" && r.plan ? (
        <div className="plan-body">
          <Markdown text={r.plan} />
        </div>
      ) : r.kind === "question" ? (
        r.questions?.map((q) => (
          <label key={questionId(q)}>
            {q.question ?? q.header}
            {q.selectionOnly ? (
              <select
                multiple={q.multiple}
                value={answers[questionId(q)] ?? (q.multiple ? [] : "")}
                onChange={(e) =>
                  setAnswers({
                    ...answers,
                    [questionId(q)]: q.multiple
                      ? [...e.target.selectedOptions].map((o) => o.value)
                      : e.target.value,
                  })
                }
              >
                <option value="" disabled>
                  Choose an option
                </option>
                {q.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                list={"options-" + questionId(q)}
                value={answers[questionId(q)] ?? ""}
                onChange={(e) =>
                  setAnswers({ ...answers, [questionId(q)]: e.target.value })
                }
              />
            )}
            <datalist id={"options-" + questionId(q)}>
              {q.options?.map((o) => (
                <option key={o.label ?? o} value={o.label ?? o} />
              ))}
            </datalist>
          </label>
        ))
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
          {r.kind === "plan" ? "Keep planning" : "Decline"}
        </button>
        <button
          className="primary"
          disabled={
            submitting ||
            (r.kind === "question" &&
              r.questions?.some((q) =>
                Array.isArray(answers[questionId(q)])
                  ? !answers[questionId(q)].length
                  : !answers[questionId(q)]?.trim(),
              ))
          }
          onClick={() => respond({ allow: true, answers })}
        >
          {r.kind === "question"
            ? "Send answer"
            : r.kind === "plan"
              ? "Approve plan"
              : "Allow once"}
        </button>
      </div>
    </section>
  );
}
