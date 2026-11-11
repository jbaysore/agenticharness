import React, { useId } from "react";
import {
  questionAnswer,
  questionIdentity,
  questionKind,
} from "../core/questions.mjs";

export const questionId = questionIdentity;
export { questionAnswer };

const multipleChoice = (q) => q.multiple || q.multiSelect;

export function QuestionField({ question: q, value = {}, onChange, disabled }) {
  const id = useId(),
    kind = questionKind(q),
    multiple = multipleChoice(q),
    hasOptions = kind === "choice" && q.options?.length > 0,
    custom = kind === "choice" && value.other,
    inputType = multiple ? "checkbox" : "radio";
  if (kind === "done")
    return (
      <fieldset className="agent-question" disabled={disabled}>
        <legend>{q.question ?? q.header}</legend>
        <p className="question-hint">Confirm when this is done.</p>
      </fieldset>
    );
  if (kind === "text") {
    const legendId = `${id}-legend`;
    return (
      <fieldset className="agent-question" disabled={disabled}>
        <legend id={legendId}>{q.question ?? q.header}</legend>
        <div className="question-custom">
          <textarea
            rows={3}
            autoFocus
            aria-labelledby={legendId}
            value={value.text ?? ""}
            placeholder={q.placeholder?.trim() || "Write your answer…"}
            autoComplete="off"
            onChange={(e) => onChange({ ...value, text: e.target.value })}
          />
        </div>
      </fieldset>
    );
  }
  const select = (index, checked) => {
    const selected = value.selected ?? [];
    onChange({
      ...value,
      selected: multiple
        ? checked
          ? [...selected, index]
          : selected.filter((i) => i !== index)
        : [index],
      other: multiple ? value.other : false,
    });
  };
  return (
    <fieldset className="agent-question" disabled={disabled}>
      <legend>{q.question ?? q.header}</legend>
      {hasOptions && (
        <>
          <p className="question-hint">
            {multiple
              ? "Choose all that apply, or add your own response."
              : "Choose one, or write your own response."}
          </p>
          <div className="question-options">
            {q.options.map((option, index) => {
              const label = option.label ?? option;
              // Older requests may already include Other; use the response field.
              if (
                typeof label === "string" &&
                /^other(?:\s*\([^)]*\))?$/i.test(label.trim())
              )
                return null;
              const split =
                  typeof label === "string" ? label.indexOf(" — ") : -1,
                title =
                  !option.description && split > 0
                    ? label.slice(0, split)
                    : label,
                description =
                  option.description ||
                  (split > 0 ? label.slice(split + 3) : ""),
                selected = value.selected?.includes(index) ?? false;
              return (
                <label
                  className={"question-option" + (selected ? " selected" : "")}
                  key={index}
                >
                  <input
                    type={inputType}
                    name={id}
                    checked={selected}
                    aria-labelledby={`${id}-option-${index}-title`}
                    aria-describedby={
                      description ? `${id}-option-${index}` : undefined
                    }
                    onChange={(e) => select(index, e.target.checked)}
                  />
                  <span className="question-option-mark" aria-hidden="true" />
                  <span className="question-option-copy">
                    <span
                      className="question-option-title"
                      id={`${id}-option-${index}-title`}
                    >
                      {title}
                    </span>
                    {description && (
                      <span
                        className="question-option-description"
                        id={`${id}-option-${index}`}
                      >
                        {description}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
            <label
              className={"question-option" + (value.other ? " selected" : "")}
            >
              <input
                type={inputType}
                name={id}
                checked={value.other ?? false}
                aria-labelledby={`${id}-other-title`}
                aria-describedby={`${id}-other-hint`}
                onChange={(e) =>
                  onChange({
                    ...value,
                    selected: multiple ? value.selected : [],
                    other: e.target.checked,
                  })
                }
              />
              <span className="question-option-mark" aria-hidden="true" />
              <span className="question-option-copy">
                <span
                  className="question-option-title"
                  id={`${id}-other-title`}
                >
                  Other
                </span>
                <span
                  className="question-option-description"
                  id={`${id}-other-hint`}
                >
                  Share a different answer or explain what you need.
                </span>
              </span>
            </label>
          </div>
        </>
      )}
      {custom && (
        <label className="question-custom">
          {hasOptions ? "Your Other response" : "Your response"}
          <textarea
            rows={3}
            autoFocus={hasOptions}
            value={value.text ?? ""}
            placeholder="Write your answer…"
            autoComplete="off"
            onChange={(e) => onChange({ ...value, text: e.target.value })}
          />
        </label>
      )}
    </fieldset>
  );
}
