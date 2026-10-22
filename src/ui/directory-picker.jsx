import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api.mjs";
import { Icon, Modal } from "./components.jsx";
import "./directory-picker.css";

function DirectoryExplorer({ project, projects, onChange, onClose }) {
  const [directory, setDirectory] = useState(null),
    [location, setLocation] = useState(project?.path ?? ""),
    [loading, setLoading] = useState(true),
    [validated, setValidated] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    request = useRef(0),
    savingRef = useRef(false),
    body = useRef(null),
    breadcrumbs = useRef(null),
    locationId = useId();
  const close = () => {
    if (!savingRef.current) onClose();
  };
  async function navigate(path) {
    if (savingRef.current) return;
    const id = ++request.current;
    setLoading(true);
    setValidated(false);
    setError("");
    if (path !== undefined) setLocation(path);
    try {
      const data = await api(
        "/api/directories" +
          (path === undefined ? "" : "?" + new URLSearchParams({ path })),
      );
      if (id !== request.current) return;
      setDirectory(data);
      setLocation(data.path);
      setValidated(true);
    } catch (e) {
      if (id !== request.current) return;
      setError(e.message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    navigate(project?.path);
    return () => {
      request.current++;
    };
  }, [project?.path]);
  useEffect(() => {
    if (breadcrumbs.current)
      breadcrumbs.current.scrollLeft = breadcrumbs.current.scrollWidth;
  }, [directory?.path]);
  useEffect(() => {
    const modal = body.current?.closest('[role="dialog"]');
    if (!loading && modal && !modal.contains(document.activeElement))
      (
        body.current.querySelector(
          ".directory-entries button:not(:disabled)",
        ) ??
        body.current.querySelector(".directory-up:not(:disabled)") ??
        body.current.querySelector("input")
      )?.focus();
  }, [directory, loading]);
  useEffect(() => {
    const keyboard = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      } else if (event.key === "Tab") {
        const controls = [
          ...body.current
            .closest('[role="dialog"]')
            .querySelectorAll("button:not(:disabled), input:not(:disabled)"),
        ].filter((element) => element.getClientRects().length);
        const first = controls[0],
          last = controls.at(-1);
        if (!controls.includes(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [onClose]);
  const canUse =
    directory &&
    validated &&
    !loading &&
    !saving &&
    location.trim() === directory.path;
  return (
    <Modal title="Choose a directory" onClose={close} wide>
      <p>
        Browse folders on the Windows host, then choose the folder to work in.
      </p>
      <div className="directory-explorer" ref={body}>
        <form
          className="directory-location"
          onSubmit={(event) => {
            event.preventDefault();
            navigate(location.trim());
          }}
        >
          <label htmlFor={locationId}>Location</label>
          <div>
            <input
              id={locationId}
              autoFocus
              value={location}
              disabled={saving}
              onChange={(event) => {
                request.current++;
                setLoading(false);
                setValidated(event.target.value.trim() === directory?.path);
                setLocation(event.target.value);
                setError("");
              }}
            />
            <button className="secondary" disabled={saving || !location.trim()}>
              Go
            </button>
          </div>
        </form>
        <div className="directory-browser">
          <nav className="directory-shortcuts" aria-label="Directory shortcuts">
            <h3>Locations</h3>
            {(directory?.roots ?? [{ name: "Home", path: undefined }]).map(
              (root) => (
                <button
                  key={root.name}
                  type="button"
                  title={root.path}
                  aria-label={`Go to ${root.name}`}
                  disabled={saving}
                  onClick={() => navigate(root.path)}
                >
                  <Icon name="folder" size={15} />
                  <span>{root.name}</span>
                </button>
              ),
            )}
            {projects.length > 0 && <h3>Projects</h3>}
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                title={p.path}
                aria-label={`Open project ${p.name}`}
                disabled={saving}
                onClick={() => navigate(p.path)}
              >
                <Icon name="folder" size={15} />
                <span>{p.name}</span>
              </button>
            ))}
          </nav>
          <div className="directory-content">
            <div className="directory-navigation">
              <button
                type="button"
                className="directory-up"
                aria-label="Up one folder"
                disabled={saving || !directory?.parent}
                onClick={() => navigate(directory.parent)}
              >
                <Icon name="arrow" size={16} />
              </button>
              <nav
                className="directory-breadcrumbs"
                aria-label="Folder path"
                ref={breadcrumbs}
              >
                {directory?.breadcrumbs.map((crumb, i) => (
                  <React.Fragment key={crumb.path}>
                    {i > 0 && <span aria-hidden="true">›</span>}
                    <button
                      type="button"
                      title={crumb.path}
                      disabled={saving}
                      aria-current={
                        i === directory.breadcrumbs.length - 1
                          ? "location"
                          : undefined
                      }
                      onClick={() => navigate(crumb.path)}
                    >
                      {crumb.name}
                    </button>
                  </React.Fragment>
                ))}
              </nav>
            </div>
            <div className="directory-entries" aria-busy={loading}>
              {loading ? (
                <p role="status">Loading folders…</p>
              ) : (
                directory &&
                (directory.directories.length ? (
                  <ul aria-label="Folders">
                    {directory.directories.map((entry) => (
                      <li key={entry.path}>
                        <button
                          type="button"
                          title={entry.name}
                          disabled={saving}
                          aria-label={`Open folder ${entry.name}`}
                          onClick={() => navigate(entry.path)}
                        >
                          <Icon name="folder" size={18} />
                          <span>{entry.name}</span>
                          <Icon name="chevron" size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p role="status">No subfolders. You can use this folder.</p>
                ))
              )}
            </div>
          </div>
        </div>
        {error && (
          <p className="directory-error" role="alert">
            {error}
          </p>
        )}
        <div className="directory-actions">
          <button
            type="button"
            className="secondary"
            disabled={saving}
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canUse}
            onClick={async () => {
              if (!canUse || savingRef.current) return;
              savingRef.current = true;
              setSaving(true);
              setError("");
              try {
                await onChange({
                  project: projects.find((p) => p.path === directory.path),
                  path: directory.path,
                });
                onClose();
              } catch (e) {
                setError(e.message);
              } finally {
                savingRef.current = false;
                setSaving(false);
              }
            }}
          >
            {saving ? "Changing directory…" : "Use this folder"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function DirectoryPicker({ project, projects, disabled, onChange }) {
  const [open, setOpen] = useState(false),
    trigger = useRef(null);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
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
        onClick={() => setOpen(true)}
      >
        <Icon name="folder" size={14} />
        <span>{project?.name ?? "Choose a directory"}</span>
        <span className="directory-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open &&
        createPortal(
          <DirectoryExplorer
            project={project}
            projects={projects}
            onChange={onChange}
            onClose={close}
          />,
          document.body,
        )}
    </>
  );
}
