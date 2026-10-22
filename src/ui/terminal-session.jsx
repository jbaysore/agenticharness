import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api.mjs";
import { Icon } from "./components.jsx";

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

// A terminal that sits in the pane strip beside the chats.
export const TerminalSession = forwardRef(function TerminalSession(
  {
    session,
    project,
    focused,
    headerDrag,
    dropTarget,
    onFocus,
    onClose,
    onEnd,
    report,
  },
  ref,
) {
  const view = useRef(null),
    headerDragAllowed = useRef(false);
  useImperativeHandle(ref, () => ({
    focus: () => view.current?.querySelector("textarea")?.focus(),
    send: () => {},
  }));
  const title = session ? session.title : "Terminal";
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
        {session?.status === "exited" && <span>Ended</span>}
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
          title="End this terminal"
          onClick={(e) => {
            e.stopPropagation();
            onEnd();
          }}
        >
          <Icon name="stop" size={13} />
        </button>
      </header>
      {session ? (
        <div className="terminal-body" ref={view}>
          <TerminalView id={session.id} report={report} focus={focused} />
        </div>
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

// One terminal in the sidebar, in the same shape as a chat.
export function TerminalRow({
  session,
  project,
  placement = "",
  onOpen,
  onEnd,
}) {
  const ended = session.status === "exited";
  return (
    <div className={"chat-row terminal-row " + placement}>
      <button
        className="chat-open"
        onClick={(e) => onOpen(e.ctrlKey || e.metaKey)}
        onAuxClick={(e) => {
          if (e.button === 1) onOpen(true);
        }}
      >
        <Icon name="terminal" size={13} />
        <span>{session.title}</span>
      </button>
      <small className="chat-detail" aria-hidden="true">
        {[project?.name, ended && "Ended"].filter(Boolean).join(" · ")}
      </small>
      <span className="row-actions">
        <button
          className="icon-button"
          aria-label={`End ${session.title}`}
          title="End this terminal"
          onClick={onEnd}
        >
          <Icon name="close" size={13} />
        </button>
      </span>
    </div>
  );
}
