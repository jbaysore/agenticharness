import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, Modal } from "./components.jsx";

export function DirectoryPicker({ project, projects, disabled, onChange }) {
  const [open, setOpen] = useState(false),
    [choice, setChoice] = useState(""),
    [path, setPath] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    trigger = useRef(null);
  const close = () => {
    if (saving) return;
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  useEffect(() => {
    if (!open) return;
    const escape = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, saving]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="directory-picker"
        aria-label="Change directory"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          project ? `Change directory: ${project.path}` : "Choose a directory"
        }
        disabled={disabled}
        onClick={() => {
          setChoice(project?.id ?? "");
          setPath("");
          setError("");
          setOpen(true);
        }}
      >
        <Icon name="folder" size={14} />
        <span>{project?.name ?? "Choose a directory"}</span>
        <span className="directory-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open &&
        createPortal(
          <Modal title="Choose a directory" onClose={close}>
            <p>Choose a project or enter a folder on the Windows host.</p>
            <form
              className="directory-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (saving) return;
                setSaving(true);
                setError("");
                try {
                  await onChange({
                    project: projects.find((p) => p.id === choice),
                    path: path.trim(),
                  });
                  setOpen(false);
                  requestAnimationFrame(() => trigger.current?.focus());
                } catch (e) {
                  setError(e.message);
                } finally {
                  setSaving(false);
                }
              }}
            >
              <label>
                Project directory
                <select
                  autoFocus
                  value={choice}
                  disabled={saving}
                  onChange={(event) => setChoice(event.target.value)}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.path}
                    </option>
                  ))}
                  <option value="">Another directory…</option>
                </select>
              </label>
              {!choice && (
                <label>
                  Folder path
                  <input
                    required
                    placeholder="C:\Users\Joshua\Projects\my-project"
                    value={path}
                    disabled={saving}
                    onChange={(event) => setPath(event.target.value)}
                  />
                </label>
              )}
              {error && <p role="alert">{error}</p>}
              <button className="primary" disabled={saving}>
                {saving ? "Changing directory…" : "Use directory"}
              </button>
            </form>
          </Modal>,
          document.body,
        )}
    </>
  );
}
