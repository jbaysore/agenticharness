import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { readPending, savePending } from "./outbox.mjs";
import { providerStatusLabel } from "./status.mjs";
import { ResizeHandle, useSidebarLayout } from "./sidebar-layout.jsx";

async function api(path, body, method) {
  const response = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "X-Harness-Client": "1",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error ?? "Request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}
const paths = {
  plus: "M12 5v14M5 12h14",
  chat: "M5 4h14v12H9l-4 4V4Z",
  folder: "M3 6h7l2 3h9v11H3V6Z",
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
  refresh: "M20 10a8 8 0 1 0-1 7M20 4v6h-6",
  check: "m5 12 4 4 10-10",
  link: "m9 15 6-6M7 14l-2 2a3 3 0 0 0 4 4l4-4M11 8l4-4a3 3 0 0 1 4 4l-2 2",
};
function Icon({ name, size = 18 }) {
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
function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
function Markdown({ text }) {
  const html = DOMPurify.sanitize(
    marked
      .parse(text ?? "", { breaks: true })
      .replace(
        /href="harness:\/\/conversation\/([^"#]+)(#[^"]*)?"/g,
        'href="/?chat=$1$2"',
      ),
  );
  return (
    <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
function Modal({ title, children, onClose, wide = false }) {
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

function App() {
  const [state, setState] = useState({
      projects: [],
      conversations: [],
      providers: [],
    }),
    [ready, setReady] = useState(false),
    [needsPair, setNeedsPair] = useState(false),
    [pair, setPair] = useState(""),
    [error, setError] = useState("");
  const [chat, setChat] = useState(null),
    [selectedProject, setSelectedProject] = useState(""),
    [provider, setProvider] = useState("codex"),
    [model, setModel] = useState(""),
    [effort, setEffort] = useState(""),
    [draft, setDraft] = useState("");
  const [panel, setPanel] = useState("review"),
    [overlayPanel, setOverlayPanel] = useState(false),
    [sidebar, setSidebar] = useState(false),
    [modal, setModal] = useState(null),
    [online, setOnline] = useState(true),
    [busy, setBusy] = useState(false);
  const {
    layout,
    setLayout,
    mobile,
    docked,
    leftWidth,
    rightWidth,
    leftMax,
    rightMax,
  } = useSidebarLayout();
  const sidebarVisible = mobile ? sidebar : layout.leftOpen;
  const showPanel = docked ? layout.rightOpen : overlayPanel;
  const setShowPanel = (open) => {
    if (docked) setLayout((current) => ({ ...current, rightOpen: open }));
    else setOverlayPanel(open);
  };
  const toggleSidebar = () => {
    if (mobile) setSidebar((open) => !open);
    else setLayout((current) => ({ ...current, leftOpen: !current.leftOpen }));
  };
  useEffect(() => {
    setSidebar(false);
    setOverlayPanel(false);
  }, [mobile, docked]);
  useEffect(() => {
    const dismiss = (event) => {
      if (event.key === "Escape") {
        setSidebar(false);
        setOverlayPanel(false);
      }
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, []);
  const [search, setSearch] = useState(""),
    [results, setResults] = useState([]),
    [searchScope, setSearchScope] = useState("project");
  const [projectName, setProjectName] = useState(""),
    [projectDirectory, setProjectDirectory] = useState(""),
    [remoteCode, setRemoteCode] = useState(null);
  const currentChat = useRef(null),
    lastEvent = useRef(0),
    floors = useRef({}),
    pendingSend = useRef(readPending()),
    bottom = useRef(null),
    errorTimer = useRef(null);
  const report = useCallback((e) => {
    setError(e.message ?? String(e));
    clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(""), 14000);
  }, []);
  useEffect(() => {
    const offline = () => setOnline(false),
      online = () =>
        api("/api/state")
          .then(() => setOnline(true))
          .catch(() => setOnline(false));
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, []);
  const refresh = useCallback(async () => {
    const next = await api("/api/state");
    setState(next);
    setSelectedProject((p) => p || next.projects[0]?.id || "");
    return next;
  }, []);
  const loadChat = useCallback(async (id) => {
    const next = await api("/api/chats/" + id);
    floors.current[id] = next.lastEventId;
    currentChat.current = id;
    setChat(next);
    setSelectedProject(next.project_id);
    setProvider(next.provider);
    setModel(next.model);
    setEffort(next.effort ?? "");
    setSidebar(false);
    history.replaceState({}, "", `/?chat=${id}`);
    return next;
  }, []);
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const fragment = new URLSearchParams(location.hash.slice(1));
        if (fragment.has("pair")) {
          await api("/api/pair", { code: fragment.get("pair") });
          history.replaceState({}, "", location.pathname + location.search);
        }
        const next = await refresh();
        if (ignore) return;
        lastEvent.current = next.lastEventId;
        const pending = pendingSend.current;
        const id =
          pending?.chatId ?? new URLSearchParams(location.search).get("chat");
        if (id) await loadChat(id);
        if (pending) {
          const { run } = await api(
            "/api/actions/" + encodeURIComponent(pending.actionId),
          );
          if (run) {
            pendingSend.current = null;
            savePending(null);
            setDraft("");
          } else {
            setDraft(pending.text);
            setProvider(pending.provider);
            setModel(pending.model);
            setEffort(pending.effort ?? "");
            report(
              new Error(
                "Your unconfirmed message was restored. Sending it again uses the same action ID.",
              ),
            );
          }
        }
        setReady(true);
      } catch (e) {
        if (e.status === 401) setNeedsPair(true);
        else {
          report(e);
          setNeedsPair(true);
        }
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const stream = new EventSource("/api/events?after=" + lastEvent.current);
    stream.onopen = () => setOnline(true);
    stream.onerror = () => setOnline(false);
    stream.addEventListener("resync", async (event) => {
      lastEvent.current = JSON.parse(event.data).lastEventId;
      await refresh();
      if (currentChat.current) await loadChat(currentChat.current);
    });
    stream.onmessage = (event) => {
      const e = JSON.parse(event.data);
      if (e.id <= lastEvent.current) return;
      lastEvent.current = e.id;
      if (e.type === "providers")
        setState((s) => ({ ...s, providers: e.payload.providers }));
      if (["projects", "chat"].includes(e.type)) refresh().catch(report);
      if (e.type.startsWith("terminal-"))
        window.dispatchEvent(new CustomEvent(e.type, { detail: e.payload }));
      if (e.conversationId !== currentChat.current) return;
      if (e.type === "text" && e.id > (floors.current[e.conversationId] ?? 0))
        setChat((c) => {
          if (!c || c.id !== e.conversationId) return c;
          const p = e.payload,
            existing = c.messages.find((m) => m.id === p.messageId);
          const next = existing
            ? {
                ...existing,
                content:
                  p.text !== undefined
                    ? p.text
                    : existing.content + (p.delta ?? ""),
              }
            : {
                id: p.messageId,
                role: "assistant",
                provider: p.provider,
                model: p.model,
                content: p.text ?? p.delta ?? "",
                created_at: new Date().toISOString(),
              };
          return {
            ...c,
            messages: existing
              ? c.messages.map((m) => (m.id === next.id ? next : m))
              : [...c.messages, next],
          };
        });
      if (["run", "approval", "approval-resolved"].includes(e.type)) {
        api("/api/chats/" + e.conversationId)
          .then((next) => {
            if (currentChat.current === next.id) {
              floors.current[next.id] = next.lastEventId;
              setChat(next);
            }
          })
          .catch(report);
        if (e.type === "run") refresh().catch(report);
      }
      if (e.type === "usage")
        setState((s) => ({
          ...s,
          providers: s.providers.map((p) =>
            p.id === provider ? { ...p, usage: e.payload } : p,
          ),
        }));
      window.dispatchEvent(new CustomEvent("harness-activity", { detail: e }));
    };
    return () => stream.close();
  }, [ready, provider]);
  const connected = state.providers.find((p) => p.id === provider),
    selectedModel = connected?.models?.find((m) => m.id === model),
    project = state.projects.find((p) => p.id === selectedProject);
  useEffect(() => {
    if (!connected?.models?.length) return;
    const available = connected.models.some(
      (m) => m.id === model && !m.disabled,
    );
    if (model && !available) {
      setModel("");
      setEffort("");
    }
  }, [provider, model, connected]);
  useEffect(() => {
    if (selectedModel && effort && !selectedModel.efforts.includes(effort))
      setEffort("");
  }, [model]);
  useEffect(() => {
    if (bottom.current && chat?.activeRun)
      bottom.current.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [chat?.messages?.at(-1)?.content]);
  async function newChat() {
    if (!project) {
      setModal("project");
      return;
    }
    const c = await api("/api/chats", {
      projectId: project.id,
      provider,
      model,
      effort,
    });
    await loadChat(c.id);
    await refresh();
  }
  async function sendMessage(override) {
    const text = typeof override === "string" ? override : draft;
    if (
      !text.trim() ||
      busy ||
      chat?.activeRun ||
      !model ||
      (selectedModel?.efforts?.length && !effort)
    )
      return;
    setBusy(true);
    try {
      let c = chat;
      if (!c) {
        c = await api("/api/chats", {
          projectId: selectedProject,
          provider,
          model,
          effort,
        });
        await loadChat(c.id);
      }
      const prior = pendingSend.current;
      const body =
        prior &&
        prior.text === text &&
        prior.chatId === c.id &&
        prior.provider === provider &&
        prior.model === model
          ? prior
          : {
              chatId: c.id,
              actionId: crypto.randomUUID(),
              text,
              provider,
              model,
              effort: effort || null,
            };
      pendingSend.current = body;
      savePending(body);
      await api(`/api/chats/${c.id}/messages`, body);
      pendingSend.current = null;
      savePending(null);
      setDraft("");
      await loadChat(c.id);
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  const action = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      report(e);
    }
  };
  async function connectBrowser() {
    try {
      await api("/api/pair", { code: pair.trim() });
      setNeedsPair(false);
      await refresh();
      setReady(true);
    } catch (e) {
      report(e);
    }
  }
  if (needsPair)
    return (
      <main className="pair-page">
        <Mark />
        <h1>Your workspace, connected.</h1>
        <p>Enter the pairing code from Harness on your Windows computer.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            connectBrowser();
          }}
        >
          <label>
            Pairing code
            <input
              autoFocus
              value={pair}
              onChange={(e) => setPair(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button className="primary">Connect this browser</button>
        </form>
        <p className="muted">
          On the host, double-click Launch Harness to open a paired browser.
        </p>
        {error && <p className="error-text">{error}</p>}
      </main>
    );
  if (!ready)
    return (
      <main className="pair-page">
        <Mark />
        <p>Opening your workspace…</p>
      </main>
    );
  return (
    <div
      className={
        "workspace " +
        (showPanel ? "with-panel " : "") +
        (sidebarVisible ? "sidebar-open" : "sidebar-collapsed")
      }
      style={{
        "--sidebar-width": `${leftWidth}px`,
        "--panel-width": `${rightWidth}px`,
      }}
    >
      {mobile && sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="Dismiss sidebar"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        className="sidebar"
        id="project-sidebar"
        aria-label="Projects and conversations"
        hidden={!sidebarVisible}
      >
        <div className="brand">
          <Mark />
          <span>Harness</span>
          <span className="version">LOCAL</span>
          <button
            className="icon-button sidebar-close"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            aria-controls="project-sidebar"
            aria-expanded={sidebarVisible}
            onClick={toggleSidebar}
          >
            <Icon name="sidebar" size={17} />
          </button>
        </div>
        <button className="new-chat" onClick={action(newChat)}>
          <Icon name="plus" />
          New conversation<span>＋</span>
        </button>
        <button className="sidebar-action" onClick={() => setModal("search")}>
          <Icon name="search" />
          Search conversations
        </button>
        <div className="section-label">
          PROJECTS
          <button
            className="icon-button"
            aria-label="Add project"
            onClick={() => setModal("project")}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        <div className="project-list">
          {state.projects.map((p) => (
            <div key={p.id}>
              <button
                className={
                  "project-row " + (p.id === selectedProject ? "selected" : "")
                }
                onClick={() => {
                  setSelectedProject(p.id);
                  setChat(null);
                  currentChat.current = null;
                  history.replaceState({}, "", "/");
                  setSidebar(false);
                }}
              >
                <Icon name="folder" />
                <span>{p.name}</span>
                <small>
                  {
                    state.conversations.filter((c) => c.project_id === p.id)
                      .length
                  }
                </small>
              </button>
              {p.id === selectedProject &&
                state.conversations
                  .filter((c) => c.project_id === p.id)
                  .map((c) => (
                    <button
                      key={c.id}
                      className={
                        "chat-row " + (c.id === chat?.id ? "selected" : "")
                      }
                      onClick={action(() => loadChat(c.id))}
                    >
                      <span className={"provider-dot " + c.provider} />
                      <span>{c.title}</span>
                    </button>
                  ))}
            </div>
          ))}
          {!state.projects.length && (
            <p className="sidebar-hint">
              Add a folder to begin. Your code stays on this computer.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className="sidebar-action"
            onClick={() => setModal("connections")}
          >
            <Icon name="settings" />
            <span>Connections & usage</span>
            <span className="connection-count">
              {
                state.providers.filter((p) => p.connected && !p.blockReason)
                  .length
              }
              /3
            </span>
          </button>
          <div className="host-status">
            <span className={"status-dot " + (!online ? "offline" : "")} />
            <span>
              {online ? "Windows host connected" : "Reconnecting to host…"}
            </span>
          </div>
        </div>
        <ResizeHandle
          side="left"
          controls="project-sidebar"
          width={leftWidth}
          min={220}
          max={leftMax}
          onResize={(leftWidth) =>
            setLayout((current) => ({ ...current, leftWidth }))
          }
        />
      </aside>
      <main className="chat-main">
        <header className="topbar">
          <button
            className="icon-button"
            aria-label={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
            title={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
            aria-controls="project-sidebar"
            aria-expanded={sidebarVisible}
            onClick={toggleSidebar}
          >
            <Icon name="sidebar" />
          </button>
          <div className="breadcrumbs">
            <span>{project?.name ?? "Your workspace"}</span>
            <b>/</b>
            <strong>{chat?.title ?? "New conversation"}</strong>
          </div>
          <button
            className={"icon-button " + (showPanel ? "active" : "")}
            aria-label="Toggle work panel"
            title={showPanel ? "Collapse work panel" : "Show work panel"}
            aria-controls="work-panel"
            aria-expanded={showPanel}
            onClick={() => setShowPanel(!showPanel)}
          >
            <Icon name="panel" />
          </button>
        </header>
        {!online && (
          <div className="reconnect-banner">
            Reconnecting… Work continues on the host. Your messages won’t be
            sent twice.
          </div>
        )}
        <div className="messages">
          {!chat?.messages?.length ? (
            <div className="welcome">
              <div className="eyebrow">ONE WORKSPACE. YOUR AGENTS.</div>
              <h1>What are we building?</h1>
              <p>
                Start with a task, pick an agent, and keep the whole story
                together.
              </p>
              <div className="provider-cards">
                {state.providers.map((p) => (
                  <button
                    className={
                      "provider-card " + (provider === p.id ? "chosen" : "")
                    }
                    key={p.id}
                    onClick={() => setProvider(p.id)}
                  >
                    <span className={"provider-emblem " + p.id}>
                      {p.id === "codex" ? "C" : p.id === "claude" ? "✳" : "↗"}
                    </span>
                    <strong>{p.name}</strong>
                    <span>
                      <i
                        className={
                          "status-dot " +
                          (!p.connected || p.blockReason ? "warning" : "")
                        }
                      />
                      {providerStatusLabel(p)}
                    </span>
                  </button>
                ))}
              </div>
              <div className="starter-grid">
                {[
                  "Explain this codebase",
                  "Review my current changes",
                  "Help me implement a feature",
                ].map((t, i) => (
                  <button key={t} onClick={() => setDraft(t)}>
                    <Icon name={["search", "review", "plus"][i]} />
                    {t}
                    <span>↗</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            chat.messages.map((m) => (
              <article className={"message " + m.role} key={m.id} id={m.id}>
                {m.role === "assistant" && (
                  <div className="message-byline">
                    <span className={"provider-dot " + m.provider} />
                    <strong>
                      {m.provider === "claude"
                        ? "Claude Code"
                        : m.provider === "cursor"
                          ? "Cursor"
                          : "Codex"}
                    </strong>
                    <span>{m.model}</span>
                    <a
                      href={`/?chat=${chat.id}#${m.id}`}
                      title="Link to this message"
                    >
                      <Icon name="link" size={12} />
                    </a>
                  </div>
                )}
                <Markdown text={m.content} />
              </article>
            ))
          )}
          {chat?.activeRun && (
            <div className="working-indicator">
              <span className="pulse-dot" />
              {chat.activeRun.status === "waiting"
                ? "Waiting for your approval"
                : "Working"}
              <span>
                {chat.activeRun.provider} · {chat.activeRun.model}
              </span>
            </div>
          )}
          {!chat?.activeRun && chat?.runs?.[0]?.status === "interrupted" && (
            <div className="notice">
              The host restarted during this turn. Review partial work, then
              send a message to continue. No action was replayed.
            </div>
          )}
          {!chat?.activeRun && chat?.runs?.[0]?.status === "failed" && (
            <div className="notice">
              Work stopped:{" "}
              {chat.runs[0].error ?? "The provider could not finish this turn."}{" "}
              Send a message to continue after resolving the issue.
            </div>
          )}
          {chat?.approvals?.map((a) => (
            <Approval
              key={a.id}
              approval={a}
              onAnswer={(answer) => api("/api/approvals/" + a.id, answer)}
            />
          ))}
          <div ref={bottom} />
        </div>
        <div className="composer-area">
          {connected?.blockReason && (
            <button
              className="billing-notice"
              onClick={() => setModal("connections")}
            >
              <span className="status-dot warning" />
              {connected.blockReason}
              <span>View setup ↗</span>
            </button>
          )}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage();
            }}
          >
            <textarea
              aria-label="Message your coding agent"
              placeholder={
                project
                  ? "Describe a task, ask a question, or request a review…"
                  : "Add a project to start a conversation…"
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              disabled={!project}
            />
            <div className="composer-controls">
              <div className="model-control">
                <span className={"provider-dot " + provider} />
                <select
                  aria-label="Agent and model"
                  value={model ? provider + "|" + model : ""}
                  onChange={(e) => {
                    if (!e.target.value) {
                      setModel("");
                      setEffort("");
                      return;
                    }
                    const [p, ...m] = e.target.value.split("|");
                    setProvider(p);
                    setModel(m.join("|"));
                    setEffort("");
                  }}
                >
                  <option value="">Choose a model</option>
                  {state.providers.map((p) => (
                    <optgroup label={p.name + " · " + p.route} key={p.id}>
                      {p.models?.map((m) => (
                        <option
                          key={m.id}
                          value={p.id + "|" + m.id}
                          disabled={m.disabled}
                        >
                          {p.name} · {m.name}
                          {m.disabled ? " · unavailable" : ""}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <select
                className="effort-select"
                aria-label="Reasoning effort"
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                disabled={!selectedModel?.efforts?.length}
              >
                <option value="">
                  {selectedModel?.efforts?.length
                    ? "Choose effort"
                    : "Provider preset"}
                </option>
                {selectedModel?.efforts?.map((e) => (
                  <option key={e} value={e}>
                    {e[0].toUpperCase() + e.slice(1)}
                  </option>
                ))}
              </select>
              <span className="composer-spacer" />
              {chat?.activeRun ? (
                <button
                  type="button"
                  className="send-button stopping"
                  aria-label="Stop work"
                  onClick={action(() =>
                    api(`/api/chats/${chat.id}/cancel`, {}),
                  )}
                >
                  <Icon name="stop" size={16} />
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label="Send message"
                  disabled={
                    busy ||
                    !draft.trim() ||
                    !project ||
                    !model ||
                    (selectedModel?.efforts?.length && !effort) ||
                    !!connected?.blockReason
                  }
                >
                  <Icon name="arrow" size={18} />
                </button>
              )}
            </div>
          </form>
          <div className="composer-footer">
            <span>
              <Icon name="check" size={12} />
              Subscription only
            </span>
            {chat ? (
              <label>
                History{" "}
                <select
                  aria-label="Shared history scope"
                  value={chat.scope}
                  disabled={!!chat.activeRun}
                  onChange={(e) => {
                    api(
                      "/api/chats/" + chat.id,
                      { scope: e.target.value },
                      "PATCH",
                    )
                      .then(() => loadChat(chat.id))
                      .catch(report);
                  }}
                >
                  <option value="none">This conversation</option>
                  <option value="project">This project</option>
                  <option value="all">All projects</option>
                </select>
              </label>
            ) : (
              <span>Code and history stay on your Windows host</span>
            )}
            <span className="keyboard-hint">↵ send · shift ↵ newline</span>
          </div>
        </div>
      </main>
      {showPanel && (
        <aside className="work-panel" id="work-panel" aria-label="Work panel">
          {!mobile && (
            <ResizeHandle
              side="right"
              controls="work-panel"
              width={rightWidth}
              min={320}
              max={rightMax}
              onResize={(rightWidth) =>
                setLayout((current) => ({ ...current, rightWidth }))
              }
            />
          )}
          <header className="panel-tabs">
            {[
              ["review", "review", "Review"],
              ["activity", "activity", "Work"],
              ["files", "file", "Files"],
              ["terminal", "terminal", "Terminal"],
            ].map(([id, icon, label]) => (
              <button
                title={label}
                key={id}
                className={panel === id ? "active" : ""}
                onClick={() => setPanel(id)}
              >
                <Icon name={icon} size={16} />
                <span>{label}</span>
              </button>
            ))}
            <button
              className="icon-button panel-close"
              aria-label="Close work panel"
              title="Collapse work panel"
              aria-controls="work-panel"
              aria-expanded={showPanel}
              onClick={() => setShowPanel(false)}
            >
              <Icon name="close" size={16} />
            </button>
          </header>
          {project ? (
            <WorkspacePanel
              panel={panel}
              project={project}
              chat={chat}
              onRevision={sendMessage}
              onChatRefresh={() => chat && loadChat(chat.id)}
              report={report}
            />
          ) : (
            <div className="panel-empty">
              <Icon name="folder" size={30} />
              <h3>A place for the work</h3>
              <p>
                Add a project to browse files, review changes, and open a
                terminal.
              </p>
              <button className="secondary" onClick={() => setModal("project")}>
                Add project
              </button>
            </div>
          )}
        </aside>
      )}
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            onClick={() => setError("")}
            aria-label="Dismiss error"
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      )}
      {modal === "project" && (
        <Modal title="Add a project" onClose={() => setModal(null)}>
          <p>
            Choose a folder on the Windows host. Harness works directly with the
            files in this folder.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              action(async () => {
                const p = await api("/api/projects", {
                  name: projectName || undefined,
                  path: projectDirectory,
                });
                await refresh();
                setSelectedProject(p.id);
                setChat(null);
                currentChat.current = null;
                setModal(null);
                setProjectName("");
                setProjectDirectory("");
              })();
            }}
          >
            <label>
              Project folder
              <input
                autoFocus
                required
                placeholder="C:\Users\Joshua\Projects\my-project"
                value={projectDirectory}
                onChange={(e) => setProjectDirectory(e.target.value)}
              />
            </label>
            <label>
              Name <span className="muted">optional</span>
              <input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
              />
            </label>
            <button className="primary">Add project</button>
          </form>
        </Modal>
      )}
      {modal === "connections" && (
        <Modal title="Connections & usage" wide onClose={() => setModal(null)}>
          <div className="modal-intro">
            <p>Each agent uses its own subscription and native sign-in.</p>
            <button
              className="secondary"
              onClick={action(async () => {
                setBusy(true);
                try {
                  const r = await api("/api/providers/refresh", {});
                  setState((s) => ({ ...s, providers: r.providers }));
                } finally {
                  setBusy(false);
                }
              })}
            >
              <Icon name="refresh" size={14} />
              {busy ? "Checking…" : "Refresh"}
            </button>
          </div>
          <div className="connections">
            {state.providers.map((p) => (
              <section className="connection" key={p.id}>
                <header>
                  <span className={"provider-dot " + p.id} />
                  <h3>{p.name}</h3>
                  <span className="badge">
                    {p.connected ? "Connected" : "Not connected"}
                  </span>
                </header>
                <p>
                  {p.route} <span className="muted">· {p.plan}</span>
                </p>
                {p.blockReason && <p className="error-text">{p.blockReason}</p>}
                {p.usage?.authoritative ? (
                  p.usage.windows.map((w, i) => (
                    <div className="usage-meter" key={i}>
                      <div>
                        <span>
                          {w.label ?? w.bucket}
                          {w.windowMinutes
                            ? " · " +
                              (w.windowMinutes >= 1440
                                ? Math.round(w.windowMinutes / 1440) + " days"
                                : Math.round(w.windowMinutes / 60) + " hours")
                            : ""}
                        </span>
                        <strong>
                          {Math.max(0, 100 - w.usedPercent)}% remaining
                        </strong>
                      </div>
                      <progress
                        max="100"
                        value={Math.max(0, 100 - w.usedPercent)}
                      />
                      <small>
                        {w.resetsAt
                          ? "Resets " +
                            new Date(
                              typeof w.resetsAt === "number"
                                ? w.resetsAt * 1000
                                : w.resetsAt,
                            ).toLocaleString()
                          : ""}
                      </small>
                    </div>
                  ))
                ) : (
                  <div className="unavailable">
                    Quota information unavailable through this integration
                  </div>
                )}
                {p.note && <p className="muted small">{p.note}</p>}
                {p.id === "cursor" && (
                  <div className="confirmation">
                    <a
                      href="https://cursor.com/dashboard"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open Cursor spending settings ↗
                    </a>
                    <button
                      className="secondary"
                      onClick={action(async () => {
                        const r = await api("/api/providers/cursor/confirm", {
                          disabled: true,
                        });
                        setState((s) => ({ ...s, providers: r.providers }));
                      })}
                    >
                      I’ve verified on-demand usage is off
                    </button>
                    <small>
                      This confirmation stays with the signed-in Cursor account.
                      Model responses are not billing proof.
                    </small>
                  </div>
                )}
                <div className="capability-list">
                  <span>Native sessions</span>
                  {p.capabilities?.nativeSubagents && (
                    <span>Native subagents</span>
                  )}
                  <span>
                    {p.capabilities?.effort
                      ? "Effort controls"
                      : "Fixed effort presets"}
                  </span>
                </div>
              </section>
            ))}
          </div>
          <section className="remote-settings">
            <h3>Remote access</h3>
            <p>
              {state.remoteOrigin ? (
                <>
                  Private remote address:{" "}
                  <a href={state.remoteOrigin}>{state.remoteOrigin}</a>
                </>
              ) : (
                "This host is currently available only on this computer. Secure remote access setup is pending."
              )}
            </p>
            {state.remoteOrigin && (
              <button
                className="secondary"
                onClick={action(async () =>
                  setRemoteCode(await api("/api/pairing-code", {})),
                )}
              >
                Pair another browser
              </button>
            )}
            {remoteCode && (
              <p>
                <code>{remoteCode.code}</code>
                <br />
                <small>Expires in 10 minutes. Keep this code private.</small>
              </p>
            )}
            <button
              className="secondary"
              onClick={action(async () => {
                const b = await api("/api/backup", {});
                setError("Backup saved on the Windows host: " + b.path);
              })}
            >
              Back up workspace
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={action(async () => {
                setBusy(true);
                try {
                  const result = await api("/api/history/import", {});
                  await refresh();
                  setError(
                    result.imported
                      ? `Imported ${result.imported} conversations from Cursor, Codex, and Claude.`
                      : "No new local conversations to import.",
                  );
                } finally {
                  setBusy(false);
                }
              })}
            >
              {busy ? "Importing…" : "Import local conversations"}
            </button>
            <a className="export-link" href="/api/export" download>
              Export conversation history ↓
            </a>
            <button
              className="text-button"
              onClick={action(async () => {
                await api("/api/browsers/revoke", {});
                location.reload();
              })}
            >
              Revoke all paired browsers
            </button>
          </section>
        </Modal>
      )}
      {modal === "search" && (
        <Modal title="Search conversations" wide onClose={() => setModal(null)}>
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              api(
                "/api/search?q=" +
                  encodeURIComponent(search) +
                  (searchScope === "project" && selectedProject
                    ? "&projectId=" + selectedProject
                    : ""),
              )
                .then(setResults)
                .catch(report);
            }}
          >
            <input
              autoFocus
              aria-label="Search history"
              placeholder="Find a decision, file, or earlier discussion…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="Search scope"
              value={searchScope}
              onChange={(e) => setSearchScope(e.target.value)}
            >
              <option value="project">This project</option>
              <option value="all">All projects</option>
            </select>
            <button className="primary">Search</button>
          </form>
          <div className="search-results">
            {results.map((r) => (
              <button
                key={r.id}
                onClick={action(async () => {
                  await loadChat(r.conversation_id);
                  setModal(null);
                })}
              >
                <strong>{r.title}</strong>
                <span className="muted">
                  {r.provider ?? "You"} ·{" "}
                  {new Date(r.created_at).toLocaleDateString()}
                </span>
                <p>{r.excerpt}</p>
              </button>
            ))}
            {!results.length && (
              <p className="muted">
                Search the saved text of your conversations. Results always link
                back to their source.
              </p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Approval({ approval, onAnswer }) {
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
    <section className="approval">
      <div className="eyebrow">YOUR INPUT IS NEEDED</div>
      <h3>{r.title}</h3>
      {r.kind === "question" ? (
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
          Decline
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
          {r.kind === "question" ? "Send answer" : "Allow once"}
        </button>
      </div>
    </section>
  );
}

function WorkspacePanel({
  panel,
  project,
  chat,
  onRevision,
  onChatRefresh,
  report,
}) {
  const [repo, setRepo] = useState("primary"),
    [state, setState] = useState(null),
    [selectedFile, setSelectedFile] = useState(""),
    [diff, setDiff] = useState(null),
    [file, setFile] = useState(null),
    [line, setLine] = useState(1),
    [comment, setComment] = useState(""),
    [filter, setFilter] = useState(""),
    [events, setEvents] = useState([]),
    [loading, setLoading] = useState(false),
    [problem, setProblem] = useState("");
  const [savingComment, setSavingComment] = useState(false);
  const [notes, setNotes] = useState([]),
    [note, setNote] = useState(""),
    [reference, setReference] = useState(""),
    [showReference, setShowReference] = useState(false);
  const query = "projectId=" + project.id + "&repo=" + encodeURIComponent(repo);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setState(await api("/api/repository?" + query));
      setProblem("");
    } catch (e) {
      setProblem(e.message);
    } finally {
      setLoading(false);
    }
  }, [query]);
  useEffect(() => {
    setSelectedFile("");
    setDiff(null);
    setFile(null);
    refresh();
  }, [query]);
  useEffect(() => {
    if (!selectedFile) return;
    (panel === "review"
      ? api(
          "/api/diff?" + query + "&file=" + encodeURIComponent(selectedFile),
        ).then(setDiff)
      : api(
          "/api/file?" + query + "&file=" + encodeURIComponent(selectedFile),
        ).then(setFile)
    ).catch(report);
  }, [selectedFile, panel, query]);
  useEffect(() => {
    if (panel === "activity" && chat) {
      api("/api/activity?chatId=" + chat.id)
        .then(setEvents)
        .catch(report);
      const onEvent = (e) => {
        if (e.detail.conversationId === chat.id)
          setEvents((list) => [e.detail, ...list].slice(0, 150));
      };
      window.addEventListener("harness-activity", onEvent);
      return () => window.removeEventListener("harness-activity", onEvent);
    }
  }, [panel, chat?.id]);
  useEffect(() => {
    if (panel === "files")
      api("/api/notes?projectId=" + project.id)
        .then(setNotes)
        .catch(report);
  }, [panel, project.id]);
  const act = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      report(e);
    }
  };
  if (panel === "terminal")
    return <TerminalPane project={project} report={report} />;
  if (panel === "activity")
    return (
      <div className="activity-panel">
        <div className="panel-heading">
          <h3>Work log</h3>
          <span className="badge">{chat?.activeRun ? "Live" : "Saved"}</span>
        </div>
        <p className="muted small">
          Native agent work and verification results. Subagents are labeled by
          the provider that runs them.
        </p>
        {events.length ? (
          events.map((e, i) => {
            const p = e.payload,
              item = p.item ?? {};
            return (
              <details className="work-item" key={e.id ?? i}>
                <summary>
                  <span
                    className={
                      "work-symbol " +
                      (p.kind === "native-subagent" ? "delegated" : "")
                    }
                  >
                    <Icon
                      name={p.kind === "native-subagent" ? "chat" : "activity"}
                      size={14}
                    />
                  </span>
                  <span>
                    <strong>
                      {p.kind === "native-subagent"
                        ? "Native subagent"
                        : (item.title ??
                          item.name ??
                          p.kind ??
                          p.status ??
                          e.type)}
                    </strong>
                    <small>
                      {item.command ??
                        item.description ??
                        p.error ??
                        p.reason ??
                        p.provider ??
                        ""}
                    </small>
                  </span>
                </summary>
                <pre>
                  {item.aggregatedOutput ??
                    item.text ??
                    JSON.stringify(p, null, 2)}
                </pre>
              </details>
            );
          })
        ) : (
          <div className="panel-empty">
            <Icon name="activity" size={28} />
            <p>
              Commands, plans, subagent progress, and results appear here as
              work runs.
            </p>
          </div>
        )}
      </div>
    );
  let newLine = 0;
  return (
    <div className="repository-panel">
      <div className="repo-toolbar">
        <select
          aria-label="Repository"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
        >
          <option value="primary">{project.name}</option>
          {project.repositories?.map((r, i) => (
            <option key={r.path} value={String(i)}>
              {r.name} · read-only reference
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          title="Refresh files and changes"
          aria-label="Refresh repository"
          onClick={refresh}
        >
          <Icon name="refresh" size={15} />
        </button>
      </div>
      <div className="branch-line">
        <span>⑂ {state?.branch ?? "Repository"}</span>
        <span>{state?.changes?.length ?? 0} changed</span>
      </div>
      {problem && <p className="notice">{problem}</p>}
      {panel === "review" ? (
        <>
          <div className="file-list changes">
            {state?.changes?.map((c) => (
              <button
                key={c.file}
                className={selectedFile === c.file ? "selected" : ""}
                onClick={() => {
                  setSelectedFile(c.file);
                  setLine(1);
                }}
              >
                <Icon name="file" size={14} />
                <span title={c.file}>{c.file}</span>
                <b className="file-status">{c.status.trim()}</b>
              </button>
            ))}
            {!state?.changes?.length && !problem && (
              <div className="panel-empty">
                <Icon name="check" size={26} />
                <h3>
                  {loading ? "Checking changes…" : "Working tree is clean"}
                </h3>
                <p>Code changes will appear here for review.</p>
              </div>
            )}
          </div>
          {selectedFile && diff && (
            <div className="diff-view">
              <header>
                <strong>{selectedFile}</strong>
                <small>Click a line to comment</small>
              </header>
              <div className="diff-lines">
                {diff.diff.split("\n").map((text, i) => {
                  const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
                  if (hunk) newLine = Number(hunk[1]) - 1;
                  const isContent =
                    !text.startsWith("@@") &&
                    !text.startsWith("---") &&
                    !text.startsWith("+++") &&
                    !text.startsWith("diff ") &&
                    !text.startsWith("index ");
                  if (isContent && !text.startsWith("-")) newLine++;
                  const number =
                    isContent && !text.startsWith("-") ? newLine : null;
                  return (
                    <button
                      key={i}
                      className={
                        "diff-line " +
                        (text.startsWith("+")
                          ? "added "
                          : text.startsWith("-")
                            ? "removed "
                            : text.startsWith("@@")
                              ? "hunk "
                              : "") +
                        (number === line ? "anchored" : "")
                      }
                      disabled={!number || number < 1}
                      onClick={() => setLine(number)}
                    >
                      <span>{number ?? ""}</span>
                      <code>{text || " "}</code>
                    </button>
                  );
                })}
              </div>
              <div className="review-comment">
                <label>
                  Comment on line {line}
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Describe the change you’d like…"
                  />
                </label>
                <button
                  className="secondary"
                  disabled={!chat || !comment.trim() || savingComment}
                  onClick={act(async () => {
                    setSavingComment(true);
                    try {
                      await api("/api/comments", {
                        conversationId: chat.id,
                        repo,
                        file: selectedFile,
                        line,
                        body: comment,
                        revision: diff.revision,
                      });
                      setComment("");
                      await onChatRefresh();
                    } finally {
                      setSavingComment(false);
                    }
                  })}
                >
                  Save comment
                </button>
              </div>
            </div>
          )}
          {chat?.comments?.length > 0 && (
            <div className="review-summary">
              <h4>{chat.comments.length} review comments</h4>
              {chat.comments.slice(-5).map((c) => (
                <p key={c.id}>
                  <strong>
                    {c.file}:{c.line}
                  </strong>
                  <br />
                  {c.body}
                </p>
              ))}
              <button
                className="primary"
                disabled={!!chat.activeRun || savingComment || !!comment.trim()}
                onClick={() =>
                  onRevision(
                    "Please address these review comments. Inspect the current diff and run relevant verification:\n\n" +
                      chat.comments
                        .map(
                          (c) =>
                            `${c.file}:${c.line} (reviewed diff ${c.revision})\n${c.body}`,
                        )
                        .join("\n\n"),
                  )
                }
              >
                Ask for revisions
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="file-filter">
            <Icon name="search" size={14} />
            <input
              aria-label="Filter files"
              placeholder="Find a file…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="file-list tree">
            {state?.files
              ?.filter((f) => f.toLowerCase().includes(filter.toLowerCase()))
              .slice(0, 300)
              .map((f) => (
                <button
                  key={f}
                  className={selectedFile === f ? "selected" : ""}
                  onClick={() => setSelectedFile(f)}
                >
                  <Icon name="file" size={14} />
                  <span title={f}>{f}</span>
                </button>
              ))}
          </div>
          {file && selectedFile && (
            <div className="file-preview">
              <header>
                <strong>{file.file}</strong>
                <button
                  className="secondary"
                  disabled={!chat}
                  onClick={act(async () => {
                    await api("/api/artifacts", {
                      conversationId: chat.id,
                      repo,
                      file: selectedFile,
                    });
                    await onChatRefresh();
                  })}
                >
                  Pin artifact
                </button>
              </header>
              <pre>{file.content}</pre>
            </div>
          )}
          <section className="saved-context">
            <h3>Artifacts</h3>
            {chat?.artifacts?.length ? (
              chat.artifacts.map((a) => (
                <button
                  className="artifact-row"
                  key={a.id}
                  onClick={() => {
                    setSelectedFile(a.file);
                    const index = project.repositories.findIndex(
                      (r) => r.path === a.repository,
                    );
                    setRepo(index < 0 ? "primary" : String(index));
                  }}
                >
                  <Icon name="file" />
                  <span>
                    <strong>{a.title}</strong>
                    <small>{a.file}</small>
                  </span>
                  <span>↗</span>
                </button>
              ))
            ) : (
              <p className="muted small">
                Open a file and pin it to keep it with this conversation.
              </p>
            )}
            <h3>Project decisions</h3>
            {notes.map((n) => (
              <div
                className={"project-note " + (n.stale ? "stale" : "")}
                key={n.id}
              >
                <p>{n.content}</p>
                <small>
                  {n.stale
                    ? "Flagged for refresh"
                    : "Saved with source evidence"}
                </small>
                {!n.stale && (
                  <button
                    onClick={act(async () => {
                      await api("/api/notes/" + n.id + "/stale", {});
                      setNotes(await api("/api/notes?projectId=" + project.id));
                    })}
                  >
                    Flag stale
                  </button>
                )}
              </div>
            ))}
            <textarea
              aria-label="Save project decision"
              placeholder="Save a decision from this conversation…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              className="secondary"
              disabled={!chat || !note.trim()}
              onClick={act(async () => {
                await api("/api/notes", {
                  projectId: project.id,
                  conversationId: chat.id,
                  content: note,
                  evidence: [`harness://conversation/${chat.id}`],
                });
                setNote("");
                setNotes(await api("/api/notes?projectId=" + project.id));
              })}
            >
              Save with conversation source
            </button>
            <button
              className="text-button"
              onClick={() => setShowReference(!showReference)}
            >
              + Add upstream reference
            </button>
            {showReference && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  act(async () => {
                    await api("/api/projects/" + project.id + "/references", {
                      path: reference,
                    });
                    setReference("");
                    setShowReference(false);
                    location.reload();
                  })();
                }}
              >
                <label>
                  Read-only reference folder
                  <input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="C:\path\to\upstream"
                    required
                  />
                </label>
                <p className="muted small">
                  One-way reference for this project. Its Git state stays
                  separate.
                </p>
                <button className="secondary">Add reference</button>
              </form>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function TerminalPane({ project, report }) {
  const container = useRef(null),
    terminal = useRef(null),
    active = useRef(null),
    [sessions, setSessions] = useState([]),
    [id, setId] = useState("");
  useEffect(() => {
    api("/api/terminals")
      .then((all) => {
        const list = all.filter((s) => s.projectId === project.id);
        setSessions(list);
        setId(list.at(-1)?.id ?? "");
      })
      .catch(report);
  }, [project.id]);
  useEffect(() => {
    if (!id || !container.current) return;
    const t = new Terminal({
        fontFamily: "Cascadia Code, Consolas, monospace",
        fontSize: 12,
        theme: {
          background: "#101010",
          foreground: "#dedede",
          cursor: "#eeeeee",
        },
        cursorBlink: true,
        scrollback: 5000,
      }),
      fit = new FitAddon();
    t.loadAddon(fit);
    t.open(container.current);
    terminal.current = t;
    active.current = id;
    api("/api/terminals")
      .then((all) => {
        const s = all.find((s) => s.id === id);
        if (s) t.write(s.output);
      })
      .catch(report);
    const resize = () => {
      try {
        fit.fit();
        api(`/api/terminals/${id}/resize`, {
          cols: t.cols,
          rows: t.rows,
        }).catch(() => {});
      } catch {}
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    resize();
    let inputQueue = Promise.resolve();
    const input = t.onData((data) => {
      inputQueue = inputQueue
        .then(() => api(`/api/terminals/${id}/input`, { data }))
        .catch(report);
    });
    const output = (e) => {
      if (e.detail.id === id) t.write(e.detail.data);
    };
    const exit = (e) => {
      if (e.detail.id === id)
        t.write(`\r\n[Terminal exited: ${e.detail.exitCode}]\r\n`);
    };
    window.addEventListener("terminal-output", output);
    window.addEventListener("terminal-exit", exit);
    return () => {
      observer.disconnect();
      input.dispose();
      window.removeEventListener("terminal-output", output);
      window.removeEventListener("terminal-exit", exit);
      t.dispose();
    };
  }, [id]);
  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <select
          aria-label="Terminal session"
          value={id}
          onChange={(e) => setId(e.target.value)}
        >
          {sessions.length ? (
            sessions.map((s, i) => (
              <option key={s.id} value={s.id}>
                PowerShell {i + 1}
              </option>
            ))
          ) : (
            <option>No terminal</option>
          )}
        </select>
        <button
          className="icon-button"
          aria-label="New terminal"
          onClick={() =>
            api("/api/terminals", { projectId: project.id })
              .then((s) => {
                setSessions([...sessions, s]);
                setId(s.id);
              })
              .catch(report)
          }
        >
          <Icon name="plus" size={16} />
        </button>
        {id && (
          <button
            className="icon-button"
            aria-label="Close terminal"
            onClick={() =>
              api(`/api/terminals/${id}/close`, {})
                .then(() => {
                  setSessions(sessions.filter((s) => s.id !== id));
                  setId("");
                })
                .catch(report)
            }
          >
            <Icon name="close" size={15} />
          </button>
        )}
      </div>
      {id ? (
        <div className="terminal-container" ref={container} />
      ) : (
        <div className="panel-empty">
          <Icon name="terminal" size={28} />
          <h3>Your project terminal</h3>
          <p>
            Open a PowerShell session in {project.name}. It keeps running when
            you change panels or disconnect.
          </p>
          <button
            className="secondary"
            onClick={() =>
              api("/api/terminals", { projectId: project.id })
                .then((s) => {
                  setSessions([...sessions, s]);
                  setId(s.id);
                })
                .catch(report)
            }
          >
            Open terminal
          </button>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
