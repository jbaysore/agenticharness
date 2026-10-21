import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { api } from "./api.mjs";
import { Icon, Mark, Modal } from "./components.jsx";
import { ChatPane } from "./chat-pane.jsx";
import { ChatRow } from "./chat-row.jsx";
import { RulesModal } from "./rules-modal.jsx";
import {
  activeChats,
  attentionCount,
  workspacePeers,
  workspacePeersLabel,
} from "./status.mjs";
import { readAllPending } from "./outbox.mjs";
import { ResizeHandle, useSidebarLayout } from "./sidebar-layout.jsx";
import {
  closePane,
  focusedPane,
  focusPane,
  initialPanes,
  openBeside,
  openInFocused,
  parseSearch,
  readPanes,
  savePanes,
  setPaneChat,
  toSearch,
  visiblePanes,
} from "./panes.mjs";

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
  const [chats, setChats] = useState({}),
    [view, setView] = useState(() => initialPanes()),
    [selectedProject, setSelectedProject] = useState(""),
    [showArchived, setShowArchived] = useState(false),
    [windowVisible, setWindowVisible] = useState(
      () => document.visibilityState === "visible",
    );
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
    paneLimit,
    leftWidth,
    rightWidth,
    leftMax,
    rightMax,
  } = useSidebarLayout(view.panes.length);
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
    [projectDirectory, setProjectDirectory] = useState("");
  const tracked = useRef(new Set()),
    lastEvent = useRef(0),
    floors = useRef({}),
    selection = useRef({
      provider: "codex",
      model: "",
      effort: "",
      permissions: "manual",
    }),
    paneRefs = useRef({}),
    limit = useRef(paneLimit),
    marking = useRef(new Set()),
    errorTimer = useRef(null);
  limit.current = paneLimit;
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
  // A chat is tracked from the moment its snapshot arrives, so no streamed
  // text between that snapshot and the next render is dropped.
  const admit = useCallback((next) => {
    floors.current[next.id] = next.lastEventId;
    tracked.current.add(next.id);
    setChats((all) => ({ ...all, [next.id]: next }));
    return next;
  }, []);
  const reload = useCallback(
    async (id) => {
      const next = await api("/api/chats/" + id);
      return tracked.current.has(id) ? admit(next) : next;
    },
    [admit],
  );
  const openChat = useCallback(
    async (id, beside = false) => {
      const next = admit(await api("/api/chats/" + id));
      setView((current) =>
        beside
          ? openBeside(current, id, next.project_id, limit.current)
          : openInFocused(current, id, next.project_id),
      );
      setSelectedProject(next.project_id);
      setSidebar(false);
      return next;
    },
    [admit],
  );
  const openIds = view.panes.map((p) => p.chatId).filter(Boolean);
  useEffect(() => {
    const open = new Set(openIds);
    for (const id of tracked.current)
      if (!open.has(id)) tracked.current.delete(id);
    setChats((all) => {
      const kept = Object.entries(all).filter(([id]) => open.has(id));
      return kept.length === Object.keys(all).length
        ? all
        : Object.fromEntries(kept);
    });
    if (!ready) return;
    history.replaceState({}, "", toSearch(view));
    savePanes(view);
  }, [openIds.join(","), view.focused, ready]);
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
        // Chats with an unconfirmed send come first, then the address, then the last layout.
        const linked = parseSearch(location.search),
          saved = readPanes(),
          wanted = parseSearch(
            "?chat=" +
              [
                ...Object.keys(readAllPending()),
                ...(linked.length ? linked : saved.chats),
              ].join(","),
          );
        const found = (
          await Promise.all(
            wanted.map((id) => api("/api/chats/" + id).catch(() => null)),
          )
        ).filter(Boolean);
        if (ignore) return;
        if (found.length) {
          found.forEach(admit);
          // A reload returns to the pane that had focus; a link to other chats does not.
          const remembered =
            !linked.length || linked.join() === saved.chats.join()
              ? saved.chats[saved.focused]
              : linked[0];
          const restored = initialPanes(
            found.map((c) => c.id),
            Math.max(
              0,
              found.findIndex((c) => c.id === remembered),
            ),
          );
          setView(restored);
          setSelectedProject(
            found.find((c) => c.id === focusedPane(restored).chatId).project_id,
          );
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
      await Promise.all([...tracked.current].map((id) => reload(id)));
    });
    stream.onmessage = (event) => {
      const e = JSON.parse(event.data);
      if (e.id <= lastEvent.current) return;
      lastEvent.current = e.id;
      if (e.type === "providers")
        setState((s) => ({ ...s, providers: e.payload.providers }));
      if (
        [
          "projects",
          "chat",
          "run",
          "approval",
          "approval-resolved",
          "rules",
        ].includes(e.type)
      )
        refresh().catch(report);
      if (e.type.startsWith("terminal-"))
        window.dispatchEvent(new CustomEvent(e.type, { detail: e.payload }));
      if (e.type === "usage" && e.payload.provider) {
        const { provider, ...usage } = e.payload;
        setState((s) => ({
          ...s,
          providers: s.providers.map((p) =>
            p.id === provider ? { ...p, usage } : p,
          ),
        }));
      }
      if (!tracked.current.has(e.conversationId)) return;
      if (e.type === "text" && e.id > (floors.current[e.conversationId] ?? 0))
        setChats((all) => {
          const c = all[e.conversationId];
          if (!c) return all;
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
            ...all,
            [c.id]: {
              ...c,
              messages: existing
                ? c.messages.map((m) => (m.id === next.id ? next : m))
                : [...c.messages, next],
            },
          };
        });
      if (["run", "approval", "approval-resolved", "chat"].includes(e.type))
        reload(e.conversationId).catch(report);
      window.dispatchEvent(new CustomEvent("harness-activity", { detail: e }));
    };
    return () => stream.close();
  }, [ready]);
  useEffect(() => {
    const changed = () =>
      setWindowVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const shown = visiblePanes(view, paneLimit),
    current = focusedPane(view),
    chat = (current.chatId && chats[current.chatId]) || null;
  const paneProject = (p) =>
    state.projects.find(
      (candidate) =>
        candidate.id ===
        (chats[p.chatId]?.project_id ?? (p.projectId || selectedProject)),
    );
  // The work panel and breadcrumb follow whichever pane has focus.
  const project = paneProject(current);
  useEffect(() => {
    if (project) setSelectedProject(project.id);
  }, [view.focused]);
  // Looking at a chat is what marks its finished turn as read.
  const shownIds = shown.map((p) => p.chatId).filter(Boolean);
  useEffect(() => {
    if (!windowVisible) return;
    for (const id of shownIds) {
      const unread = state.conversations.find((c) => c.id === id)?.unread;
      if (!unread || marking.current.has(id)) continue;
      marking.current.add(id);
      api(`/api/chats/${id}/read`, {})
        .catch(() => {})
        .finally(() => marking.current.delete(id));
    }
  }, [windowVisible, shownIds.join(","), state.conversations]);
  useEffect(() => {
    const jump = (event) => {
      const target = event.altKey && shown[Number(event.key) - 1];
      if (!target || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      setView((v) => focusPane(v, target.key));
      paneRefs.current[target.key]?.focus();
    };
    window.addEventListener("keydown", jump);
    return () => window.removeEventListener("keydown", jump);
  }, [shown.map((p) => p.key).join(",")]);
  // The taskbar shows how many chats are waiting while the window is in the background.
  const active = activeChats(state.conversations),
    attention = attentionCount(state.conversations);
  useEffect(() => {
    document.title =
      (attention ? `(${attention}) ` : "") + "Harness — Your coding workspace";
  }, [attention]);
  const emptyPane = (projectId) =>
    setView((v) => openInFocused(v, null, projectId));
  async function archiveChat(c, archived) {
    await api("/api/chats/" + c.id, { archived }, "PATCH");
    if (archived)
      setView((v) => {
        const open = v.panes.find((p) => p.chatId === c.id);
        return open ? closePane(v, open.key, selectedProject) : v;
      });
    await refresh();
  }
  const chatRow = (c, detail) => (
    <ChatRow
      key={c.id}
      chat={c}
      detail={detail}
      placement={
        c.id === chat?.id ? "selected" : openIds.includes(c.id) ? "open" : ""
      }
      canSplit={
        !mobile &&
        !!current.chatId &&
        !openIds.includes(c.id) &&
        view.panes.length < paneLimit
      }
      onOpen={(beside) => action(() => openChat(c.id, beside))()}
      onRename={(title) =>
        action(() => api("/api/chats/" + c.id, { title }, "PATCH"))()
      }
      onArchive={(archived) => action(() => archiveChat(c, archived))()}
    />
  );
  async function newChat(beside = false) {
    const target = state.projects.find((p) => p.id === selectedProject);
    if (!target) {
      setModal("project");
      return;
    }
    const c = await api("/api/chats", {
      projectId: target.id,
      ...selection.current,
    });
    await openChat(c.id, beside);
    await refresh();
  }
  // The pane that asked keeps its key, so its composer survives the chat's creation.
  async function ensureChat(p, chosen) {
    const c = await api("/api/chats", {
      projectId: paneProject(p).id,
      ...chosen,
    });
    const next = admit(await api("/api/chats/" + c.id));
    setView((v) => setPaneChat(v, p.key, c.id));
    return next;
  }
  async function followLink(id, beside, anchor) {
    await openChat(id, beside);
    if (anchor)
      setTimeout(
        () =>
          document.getElementById(anchor)?.scrollIntoView({ block: "start" }),
        60,
      );
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
        (showPanel && docked ? "with-panel " : "") +
        (sidebarVisible ? "sidebar-open" : "sidebar-collapsed")
      }
      style={{
        "--sidebar-width": `${leftWidth}px`,
        "--panel-width": `${rightWidth}px`,
        "--panes": shown.length,
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
        <button
          className="new-chat"
          title="New conversation. Ctrl-click to open it beside this one."
          onClick={(e) => action(() => newChat(e.ctrlKey || e.metaKey))()}
        >
          <Icon name="plus" />
          New conversation<span>＋</span>
        </button>
        <button className="sidebar-action" onClick={() => setModal("search")}>
          <Icon name="search" />
          Search conversations
        </button>
        {active.length > 0 && (
          <>
            <div className="section-label">ACTIVE</div>
            <div className="active-list" aria-label="Active chats">
              {active.map((c) =>
                chatRow(
                  c,
                  state.projects.find((p) => p.id === c.project_id)?.name,
                ),
              )}
            </div>
          </>
        )}
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
          {state.projects.map((p) => {
            const mine = state.conversations.filter(
                (c) => c.project_id === p.id,
              ),
              archived = mine.filter((c) => c.archived_at);
            return (
              <div key={p.id}>
                <button
                  className={
                    "project-row " +
                    (p.id === selectedProject ? "selected" : "")
                  }
                  onClick={() => {
                    setSelectedProject(p.id);
                    // Browsing another project never closes a chat that is open.
                    if (!current.chatId) emptyPane(p.id);
                    setSidebar(false);
                  }}
                >
                  <Icon name="folder" />
                  <span>{p.name}</span>
                  <small>{mine.length - archived.length}</small>
                </button>
                {p.id === selectedProject && (
                  <>
                    {mine.filter((c) => !c.archived_at).map((c) => chatRow(c))}
                    {archived.length > 0 && (
                      <button
                        className="archived-toggle"
                        aria-expanded={showArchived}
                        onClick={() => setShowArchived(!showArchived)}
                      >
                        {showArchived
                          ? "Hide archived"
                          : `Show archived (${archived.length})`}
                      </button>
                    )}
                    {showArchived && archived.map((c) => chatRow(c))}
                  </>
                )}
              </div>
            );
          })}
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
          <button className="sidebar-action" onClick={() => setModal("rules")}>
            <Icon name="rules" />
            <span>Agent rules</span>
            <span className="connection-count">
              {state.rules?.delegate.enabled ? "On" : ""}
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
          {view.panes.length > shown.length && (
            <span
              className="badge"
              title="Widen the window or collapse the sidebar to show every open chat."
            >
              {shown.length} of {view.panes.length} chats shown
            </span>
          )}
          {!mobile && (
            <button
              className="icon-button"
              aria-label="Add a pane beside"
              title={
                view.panes.length >= paneLimit
                  ? "No room for another chat at this window size"
                  : "Open another chat beside this one"
              }
              disabled={view.panes.length >= paneLimit || !current.chatId}
              onClick={() =>
                setView((v) =>
                  openBeside(v, null, project?.id ?? "", limit.current),
                )
              }
            >
              <Icon name="split" />
            </button>
          )}
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
        <div className="pane-strip">
          {shown.map((p) => (
            <ChatPane
              key={p.key}
              ref={(handle) => {
                if (handle) paneRefs.current[p.key] = handle;
                else delete paneRefs.current[p.key];
              }}
              chat={(p.chatId && chats[p.chatId]) || null}
              project={paneProject(p)}
              providers={state.providers}
              focused={p.key === current.key}
              solo={view.panes.length === 1}
              peers={workspacePeers(
                state.conversations,
                paneProject(p)?.id,
                p.chatId,
              )}
              selection={selection.current}
              onSelection={(chosen) => {
                if (p.key === view.focused) selection.current = chosen;
              }}
              onFocus={() => setView((v) => focusPane(v, p.key))}
              onClose={() =>
                setView((v) => closePane(v, p.key, selectedProject))
              }
              onOpenChat={(id, beside, anchor) =>
                followLink(id, beside, anchor).catch(report)
              }
              ensureChat={(chosen) => ensureChat(p, chosen)}
              reload={reload}
              refresh={refresh}
              report={report}
              onOpenConnections={() => setModal("connections")}
            />
          ))}
        </div>
      </main>
      {showPanel && (
        <aside
          className={"work-panel" + (docked ? "" : " overlay")}
          id="work-panel"
          aria-label="Work panel"
        >
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
              peers={workspacePeers(state.conversations, project.id, chat?.id)}
              onRevision={(text) => paneRefs.current[current.key]?.send(text)}
              onChatRefresh={() => chat && reload(chat.id)}
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
                emptyPane(p.id);
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
          </section>
        </Modal>
      )}
      {modal === "rules" && state.rules && (
        <RulesModal
          rules={state.rules}
          providers={state.providers}
          delegation={state.delegation ?? {}}
          onSaved={refresh}
          onClose={() => setModal(null)}
        />
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
                  await openChat(r.conversation_id);
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

function WorkspacePanel({
  panel,
  project,
  chat,
  peers,
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
  // The panel follows the focused chat, so an answer for the repository it
  // just left must not overwrite the one it is showing now.
  const wanted = useRef(query);
  wanted.current = query;
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api("/api/repository?" + query);
      if (wanted.current !== query) return;
      setState(next);
      setProblem("");
    } catch (e) {
      if (wanted.current === query) setProblem(e.message);
    } finally {
      if (wanted.current === query) setLoading(false);
    }
  }, [query]);
  useEffect(() => {
    setSelectedFile("");
    setDiff(null);
    setFile(null);
    setState(null);
    setProblem("");
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
      {peers.length > 0 && (
        <p className="notice workspace-peers">
          {workspacePeersLabel(peers)}: {peers.map((c) => c.title).join(", ")}.
          These changes may belong to more than one chat.
        </p>
      )}
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
