import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api.mjs";
import { Icon } from "./components.jsx";
import { SHELL_CHOICES, activeTab } from "./terminal-groups.mjs";

// One live shell on the host, drawn with xterm. The host keeps it running, so
// this only attaches to it: it replays what it has already printed, then
// follows the stream.
export function TerminalView({ id, report, focus = false }) {
  const container = useRef(null),
    handle = useRef(null);
  useEffect(() => {
    if (!id || !container.current) return;
    const t = new Terminal({
        fontFamily: "Cascadia Code, Consolas, monospace",
        fontSize: 13,
        // The workspace palette, so command output matches the chats.
        theme: {
          background: "#101010",
          foreground: "#e4e4e4",
          cursor: "#ececec",
          selectionBackground: "#3d7bff55",
          black: "#1b1b1b",
          red: "#ff5c5c",
          green: "#4fd18b",
          yellow: "#ffe14d",
          blue: "#5b8dff",
          magenta: "#b57aff",
          cyan: "#4fc4d9",
          white: "#d8d8d8",
          brightBlack: "#6f6f6f",
          brightRed: "#ff8a8a",
          brightGreen: "#7fe0aa",
          brightYellow: "#fff08a",
          brightBlue: "#7ea6ff",
          brightMagenta: "#c197ff",
          brightCyan: "#7fd8e8",
          brightWhite: "#ffffff",
        },
        cursorBlink: true,
        scrollback: 5000,
      }),
      fit = new FitAddon();
    t.loadAddon(fit);
    t.open(container.current);
    handle.current = t;
    api("/api/terminals")
      .then((all) => {
        const s = all.find((s) => s.id === id);
        if (!s) return;
        t.write(s.output);
        if (s.status === "exited") t.write("\r\n[Terminal has ended]\r\n");
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
      handle.current = null;
    };
  }, [id]);
  useEffect(() => {
    if (focus) handle.current?.focus();
  }, [focus, id]);
  return <div className="terminal-container" ref={container} />;
}

// A small menu for choosing which shell a new terminal or tab starts.
export function ShellMenu({ label, className = "", children, onPick }) {
  const [open, setOpen] = useState(false),
    box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
        if (!box.current?.contains(event.target)) setOpen(false);
      },
      escape = (event) => {
        if (event.key === "Escape") setOpen(false);
      };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <span className="shell-menu-anchor" ref={box}>
      <button
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        {children}
      </button>
      {open && (
        <div className="shell-menu" role="menu" aria-label={label}>
          {SHELL_CHOICES.map(([id, name]) => (
            <button
              key={id}
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onPick(id, e);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// A terminal window in the pane strip beside the chats. Each tab is its own
// shell on the host; closing the pane leaves every tab running.
export const TerminalSession = forwardRef(function TerminalSession(
  {
    group,
    project,
    focused,
    headerDrag,
    dropTarget,
    onFocus,
    onClose,
    onEnd,
    onAddTab,
    onCloseTab,
    report,
  },
  ref,
) {
  const view = useRef(null),
    headerDragAllowed = useRef(false),
    [chosen, setChosen] = useState(null);
  useImperativeHandle(ref, () => ({
    focus: () => view.current?.querySelector("textarea")?.focus(),
    send: () => {},
  }));
  const title = group ? group.title : "Terminal",
    tab = activeTab(group, chosen);
  return (
    <section
      className={"chat-pane terminal-pane" + (focused ? " focused" : "")}
      aria-label={title}
      onPointerDown={onFocus}
      onFocus={onFocus}
    >
      <header
        className={"pane-header" + (dropTarget ? " drop-target" : "")}
        draggable={!!headerDrag}
        {...headerDrag}
        onPointerDown={(event) => {
          headerDragAllowed.current = !event.target.closest("button");
        }}
        onDragStart={(event) => {
          if (!headerDragAllowed.current) event.preventDefault();
          else headerDrag?.onDragStart(event);
        }}
      >
        <Icon name="terminal" size={14} />
        <strong title={title}>{title}</strong>
        {project && <span>{project.name}</span>}
        <button
          className="icon-button"
          aria-label="Close pane"
          title="Close this pane. The terminal keeps running."
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <Icon name="close" size={14} />
        </button>
        <button
          className="icon-button"
          aria-label={`End ${title}`}
          title="End this terminal and all its tabs"
          onClick={(e) => {
            e.stopPropagation();
            onEnd();
          }}
        >
          <Icon name="stop" size={13} />
        </button>
      </header>
      {group ? (
        <>
          <div className="terminal-tabs" role="tablist" aria-label="Tabs">
            {group.tabs.map((t) => (
              <div
                key={t.id}
                className={"terminal-tab" + (t.id === tab?.id ? " active" : "")}
              >
                <button
                  role="tab"
                  aria-selected={t.id === tab?.id}
                  onClick={() => setChosen(t.id)}
                >
                  {t.title}
                  {t.status === "exited" && " (ended)"}
                </button>
                <button
                  className="icon-button"
                  aria-label={`Close ${t.title}`}
                  title="Close this tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(t);
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
            <ShellMenu
              label="New tab"
              className="icon-button"
              onPick={(shell) =>
                Promise.resolve(onAddTab(shell))
                  .then((added) => added && setChosen(added.id))
                  .catch(report)
              }
            >
              <Icon name="plus" size={14} />
            </ShellMenu>
          </div>
          <div className="terminal-body" ref={view}>
            {tab && (
              <TerminalView
                key={tab.id}
                id={tab.id}
                report={report}
                focus={focused}
              />
            )}
          </div>
        </>
      ) : (
        <div className="panel-empty">
          <Icon name="terminal" size={28} />
          <h3>This terminal has ended</h3>
          <p>Close the pane and start a new terminal from the sidebar.</p>
        </div>
      )}
    </section>
  );
});

// One terminal window in the sidebar, in the same shape as a chat.
export function TerminalRow({ group, project, placement = "", onOpen, onEnd }) {
  const tabs = group.tabs.length;
  return (
    <div
      className={"chat-row terminal-row " + placement}
      onClick={(e) => {
        if (!e.target.closest("button")) onOpen(e.ctrlKey || e.metaKey);
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && !e.target.closest("button")) onOpen(true);
      }}
    >
      <button
        className="chat-open"
        onClick={(e) => onOpen(e.ctrlKey || e.metaKey)}
        onAuxClick={(e) => {
          if (e.button === 1) onOpen(true);
        }}
      >
        <Icon name="terminal" size={13} />
        <span>{group.title}</span>
      </button>
      <small className="chat-detail" aria-hidden="true">
        {[project?.name, tabs > 1 && `${tabs} tabs`]
          .filter(Boolean)
          .join(" · ")}
      </small>
      <span className="row-actions">
        <button
          className="icon-button"
          aria-label={`End ${group.title}`}
          title="End this terminal and all its tabs"
          onClick={onEnd}
        >
          <Icon name="close" size={13} />
        </button>
      </span>
    </div>
  );
}
