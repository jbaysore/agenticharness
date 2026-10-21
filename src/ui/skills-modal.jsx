import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "./api.mjs";
import { Modal } from "./components.jsx";
import {
  MAX_INSTRUCTIONS,
  MAX_NAME,
  MAX_SKILLS,
  skillCommand,
  slashToken,
} from "../core/skills.mjs";

export function SkillsModal({ skills, onSaved, onClose }) {
  const [name, setName] = useState(""),
    [instructions, setInstructions] = useState(""),
    [editing, setEditing] = useState(null),
    [saving, setSaving] = useState(false),
    [notice, setNotice] = useState(null);
  const nameInput = useRef(null);
  const edit = (skill) => {
    setEditing(skill.id);
    setName(skill.name);
    setInstructions(skill.instructions);
    setNotice(null);
    nameInput.current?.focus();
  };
  const reset = () => {
    setEditing(null);
    setName("");
    setInstructions("");
  };
  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await api(
        editing ? "/api/skills/" + editing : "/api/skills",
        { name, instructions },
        editing ? "PATCH" : "POST",
      );
      await onSaved();
      setNotice({
        text: editing
          ? "Saved. The next message in a chat that uses this skill includes it."
          : "Created. Turn it on under the message box in a chat.",
      });
      reset();
    } catch (error) {
      setNotice({ text: error.message, failed: true });
    } finally {
      setSaving(false);
    }
  };
  const remove = async (skill) => {
    setSaving(true);
    setNotice(null);
    try {
      await api("/api/skills/" + skill.id, {}, "DELETE");
      if (editing === skill.id) reset();
      await onSaved();
      setNotice({ text: `Deleted ${skill.name}.` });
    } catch (error) {
      setNotice({ text: error.message, failed: true });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="Skills" wide onClose={onClose}>
      <p>
        A skill is a name and instructions. In a message, type its slash
        command, such as /review-notes, and that message includes the full
        text, for Codex, Claude Code and Cursor. A long skill spends included
        usage each time you invoke it. Text that every chat should always see
        belongs in Agent rules.
      </p>
      <form
        className="rules-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <section className="connection">
          <header>
            <h3>{editing ? "Edit skill" : "New skill"}</h3>
          </header>
          <label>
            Name
            <input
              ref={nameInput}
              aria-label="Skill name"
              maxLength={MAX_NAME}
              value={name}
            placeholder="For example: Review notes"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className="muted small">
          {/^[a-z]/.test(skillCommand(name))
            ? `Slash command: /${skillCommand(name)}`
            : "The name needs a letter so it can be a /command."}
        </p>
          <label>
            Instructions
            <textarea
              aria-label="Skill instructions"
              maxLength={MAX_INSTRUCTIONS}
              value={instructions}
              placeholder="What the agent should do when this skill is on."
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>
          <div className="skill-actions">
            <button
              className="primary"
              disabled={
                saving || (!editing && skills.length >= MAX_SKILLS)
              }
            >
              {saving ? "Saving…" : editing ? "Save skill" : "Create skill"}
            </button>
            {editing && (
              <button
                type="button"
                className="secondary"
                disabled={saving}
                onClick={reset}
              >
                Cancel
              </button>
            )}
          </div>
          {!editing && skills.length >= MAX_SKILLS && (
            <p className="muted small">
              You can keep {MAX_SKILLS} skills. Delete one to add another.
            </p>
          )}
        </section>
        {skills.length > 0 && (
          <ul className="skill-list">
            {skills.map((skill) => (
              <li key={skill.id}>
                <header>
                  <strong>{skill.name}</strong>
                  <span className="skill-command">/{skill.command}</span>
                  <div className="skill-actions">
                    <button
                      type="button"
                      className="text-button"
                      disabled={saving}
                      onClick={() => edit(skill)}
                    >
                      Edit {skill.name}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={saving}
                      onClick={() => remove(skill)}
                    >
                      Delete {skill.name}
                    </button>
                  </div>
                </header>
                <p className="skill-body">{skill.instructions}</p>
              </li>
            ))}
          </ul>
        )}
        {notice && (
          <p
            className={notice.failed ? "error-text" : "muted small"}
            role={notice.failed ? "alert" : "status"}
          >
            {notice.text}
          </p>
        )}
      </form>
    </Modal>
  );
}

// The menu appears while a /command is being typed. Escape hides it until the
// command being typed changes. Enter and Tab insert the highlighted skill.
export function SkillSlash({ ref, skills, text, caret, onPick, onCreate }) {
  const token = slashToken(text, caret),
    key = token ? `${token.start}:${token.query}` : "";
  const matches = token
    ? skills
        .filter((skill) => skill.command.startsWith(token.query))
        .slice(0, 8)
    : [];
  const [hidden, setHidden] = useState(""),
    [highlight, setHighlight] = useState(0);
  useEffect(() => setHighlight(0), [key]);
  const open = !!token && hidden !== key;
  useImperativeHandle(
    ref,
    () => ({
      onKeyDown(event) {
        if (!open) return false;
        if (event.key === "Escape") {
          setHidden(key);
          return true;
        }
        if (!matches.length) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setHighlight((index) => {
            const step = event.key === "ArrowDown" ? 1 : -1;
            return (index + step + matches.length) % matches.length;
          });
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          onPick(matches[Math.min(highlight, matches.length - 1)].command);
          return true;
        }
        return false;
      },
    }),
    [open, key, matches, highlight, onPick],
  );
  if (!open) return null;
  return (
    <div className="slash-menu" role="listbox" aria-label="Skills">
      {matches.length ? (
        matches.map((skill, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === highlight}
            key={skill.id}
            className={index === highlight ? "active" : ""}
            title={skill.instructions}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(skill.command);
            }}
            onMouseEnter={() => setHighlight(index)}
          >
            <strong>/{skill.command}</strong>
            <span>{skill.name}</span>
          </button>
        ))
      ) : (
        <p>{skills.length ? `No skill for /${token.query}.` : "No skills yet."}</p>
      )}
      <button
        type="button"
        className="text-button"
        onMouseDown={(event) => {
          event.preventDefault();
          onCreate();
        }}
      >
        Create a skill
      </button>
    </div>
  );
}
