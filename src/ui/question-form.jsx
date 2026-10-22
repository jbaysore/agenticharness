import React, { useId } from "react";
import { questionIdentity } from "../core/questions.mjs";

export const questionId = questionIdentity;
const multipleChoice = (q) => q.multiple || q.multiSelect;
const optionValue = (q, option) =>
  q.selectionOnly ? option.id : (option.label ?? option);

export function questionAnswer(q, response = {}) {
  if (response.other && !response.text?.trim()) return undefined;
  const values = (response.selected ?? []).map((i) =>
    optionValue(q, q.options[i]),
  );
  if (response.other || !q.options?.length) {
    if (response.text?.trim()) values.push(response.text.trim());
  }
  if (!values.length) return undefined;
  return multipleChoice(q) ? values : values[0];
}

export function QuestionField({ question: q, value = {}, onChange, disabled }) {
  const id = useId(),
    multiple = multipleChoice(q),
    hasOptions = q.options?.length > 0,
    custom = value.other || !hasOptions,
    inputType = multiple ? "checkbox" : "radio";
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
