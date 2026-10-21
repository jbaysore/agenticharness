import React, { useEffect, useRef, useState } from "react";
import { api } from "./api.mjs";
import { Modal } from "./components.jsx";
import {
  MAX_INSTRUCTIONS,
  MAX_NAME,
  MAX_PER_CHAT,
  MAX_SKILLS,
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
        A skill is a name and instructions you turn on for a chat. The next
        message includes the full text, for Codex, Claude Code and Cursor. A
        long skill spends included usage on every message that uses it. Text
        that every chat should always see belongs in Agent rules.
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

// Ticked skills travel with the next message. The menu stays out of the
// permission control, which another part of the composer owns.
export function SkillPicker({
  skills,
  skillIds,
  disabled,
  onChange,
  onCreate,
}) {
  const [open, setOpen] = useState(false),
    root = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const selected = skills.filter((skill) => skillIds.includes(skill.id));
  return (
    <div className="skills-control" ref={root}>
      <button
        type="button"
        aria-label="Skills for this chat"
        aria-expanded={open}
        aria-haspopup="true"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {selected.length ? `Skills · ${selected.length}` : "Skills"}
      </button>
      {open && (
        <div className="skills-menu" role="group" aria-label="Skills for this chat">
          <p>The next message includes the ones you tick. Up to {MAX_PER_CHAT}.</p>
          {skills.length === 0 ? (
            <p>No skills yet.</p>
          ) : (
            skills.map((skill) => {
              const on = skillIds.includes(skill.id),
                full = !on && skillIds.length >= MAX_PER_CHAT;
              return (
                <label key={skill.id} title={skill.instructions}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={disabled || full}
                    onChange={() =>
                      onChange(
                        on
                          ? skillIds.filter((id) => id !== skill.id)
                          : [...skillIds, skill.id],
                      )
                    }
                  />
                  {skill.name}
                </label>
              );
            })
          )}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setOpen(false);
              onCreate();
            }}
          >
            Create a skill
          </button>
        </div>
      )}
    </div>
  );
}
