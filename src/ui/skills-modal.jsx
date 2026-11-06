import React, {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
        command, such as /review-notes, and that message includes the full text,
        for Codex, Claude Code and Cursor. A long skill spends included usage
        each time you invoke it. Text that every chat should always see belongs
        in Agent rules.
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
              disabled={saving || (!editing && skills.length >= MAX_SKILLS)}
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
              <li
                key={skill.id}
                className={editing === skill.id ? "editing" : undefined}
              >
                <header>
                  <div className="skill-title">
                    <strong>{skill.name}</strong>
                    <span className="skill-command">/{skill.command}</span>
                  </div>
                  <div className="skill-actions">
                    <button
                      type="button"
                      className="text-button"
                      disabled={saving}
                      aria-label={`Edit ${skill.name}`}
                      onClick={() => edit(skill)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={saving}
                      aria-label={`Delete ${skill.name}`}
                      onClick={() => remove(skill)}
                    >
                      Delete
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
// command being typed changes. Enter and Tab insert the highlighted skill, or
// switch to the highlighted mode.
export function SkillSlash({
  ref,
  skills,
  modes = [],
  commands = [],
  text,
  caret,
  onPick,
  onMode,
  onCreate,
}) {
  const token = slashToken(text, caret),
    key = token ? `${token.start}:${token.query}` : "";
  const matches = token
    ? [
        ...commands.map((entry) => ({
          ...entry,
          id: "delivery:" + entry.command,
          isDelivery: true,
        })),
        ...modes.map((entry) => ({
          ...entry,
          id: "mode:" + entry.command,
          isMode: true,
        })),
        ...skills,
      ]
        .filter((item) => item.command.startsWith(token.query))
        .slice(0, 10)
    : [];
  const choose = (item) =>
    item.isMode ? onMode(item.mode) : onPick(item.command);
  const detail = (item) =>
    item.isDelivery && item.description ? item.description : item.name;
  const skillMatches = matches.filter((item) => !item.isMode && !item.isDelivery);
  const [hidden, setHidden] = useState(""),
    [highlight, setHighlight] = useState(0);
  const menuRef = useRef(null);
  useEffect(() => setHighlight(0), [key]);
  const open = !!token && hidden !== key;
  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu) return;
    const pane = menu.closest(".chat-pane");
    const fit = () => {
      const ceiling = pane ? pane.getBoundingClientRect().top + 8 : 8;
      const room = menu.getBoundingClientRect().bottom - ceiling;
      menu.style.maxHeight = Math.max(48, Math.min(320, room)) + "px";
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (pane) observer.observe(pane);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [open, key]);
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const option = menu?.querySelector('[aria-selected="true"]');
    const scroller = menu?.querySelector('[role="listbox"]');
    if (!option || !scroller) return;
    const optionBox = option.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    if (optionBox.top < box.top) scroller.scrollTop -= box.top - optionBox.top;
    else if (optionBox.bottom > box.bottom)
      scroller.scrollTop += optionBox.bottom - box.bottom;
  }, [open, highlight, key]);
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
          choose(matches[Math.min(highlight, matches.length - 1)]);
          return true;
        }
        return false;
      },
    }),
    [open, key, matches, highlight, onPick, onMode],
  );
  if (!open) return null;
  return (
    <div className="slash-menu" ref={menuRef}>
      <div role="listbox" aria-label="Skills and modes">
        {matches.map((skill, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === highlight}
            key={skill.id}
            className={index === highlight ? "active" : ""}
            title={skill.description ?? skill.instructions}
            onMouseDown={(event) => {
              event.preventDefault();
              choose(skill);
            }}
            onMouseEnter={() => setHighlight(index)}
          >
            <strong>/{skill.command}</strong>
            <span>{detail(skill)}</span>
          </button>
        ))}
        {skills.length === 0 ? (
          <p>No skills yet.</p>
        ) : (
          skillMatches.length === 0 && <p>No skill for /{token.query}.</p>
        )}
      </div>
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
