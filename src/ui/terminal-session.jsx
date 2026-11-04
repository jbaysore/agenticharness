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
import { connectTerminal } from "./terminal-stream.mjs";
import { cursorMoveFor } from "./terminal-click.mjs";
import { Icon } from "./components.jsx";
import { SHELL_CHOICES, activeTab } from "./terminal-groups.mjs";

// One live shell on the host, drawn with xterm. The host keeps it running, so
// this only attaches to it: it replays what it has already printed, then
// follows the stream.
export function TerminalView({ id, report, focus = false }) {
  const container = useRef(null),
    handle = useRef(null),
    clipboard = useRef(null),
    [selected, setSelected] = useState(false),
    [status, setStatus] = useState("Connecting…");
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
    const copy = async () => {
      if (!t.hasSelection()) return;
      try {
        if (navigator.clipboard?.writeText)
          await navigator.clipboard.writeText(t.getSelection());
        else if (!document.execCommand("copy"))
          throw new Error("Copy was blocked");
      } catch (error) {
        report(error);
      }
      t.focus();
    };
    const paste = async () => {
      try {
        t.paste(await navigator.clipboard.readText());
      } catch {
        report(
          new Error(
            "Clipboard access was blocked. Use Ctrl+V or Shift+Insert to paste.",
          ),
        );
      }
      t.focus();
    };
    clipboard.current = { copy, paste };
    const selection = t.onSelectionChange(() => setSelected(t.hasSelection()));
    t.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase(),
        command = event.ctrlKey || event.metaKey;
      if (
        !event.altKey &&
        command &&
        ((key === "c" && (event.shiftKey || t.hasSelection())) ||
          (key === "insert" && t.hasSelection()))
      ) {
        if (event.type === "keydown") {
          event.preventDefault();
          copy();
        }
        return false;
      }
      // Let the browser deliver a native paste event; xterm then handles line
      // endings and bracketed paste. Ctrl+C without selection still interrupts.
      if (
        !event.altKey &&
        ((command && key === "v") || (event.shiftKey && key === "insert"))
      )
        return false;
      return true;
    });
    let ended = false;
    const connection = connectTerminal(id, {
      report,
      onOpen: () => resize(),
      onReconnect: () => setStatus("Reconnecting…"),
      onMessage: (message) => {
        if (message.type === "snapshot") {
          t.reset();
          t.write(message.output);
          ended = message.status === "exited";
          setStatus(ended ? "Ended" : "");
          if (ended) t.write("\r\n[Terminal has ended]\r\n");
        }
        if (message.type === "output") t.write(message.data);
        if (message.type === "exit") {
          ended = true;
          setStatus("Ended");
          t.write(`\r\n[Terminal exited: ${message.exitCode}]\r\n`);
        }
        if (message.type === "error") {
          setStatus("Disconnected");
          report(new Error(message.error));
        }
      },
    });
    const resize = () => {
      try {
        fit.fit();
        connection.resize(t.cols, t.rows);
      } catch {}
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    resize();
    const input = t.onData((data) => connection.input(data));
    // A plain click on the line being typed moves the cursor there, as in an
    // editor. Drags, double clicks, scrolled-back views and full-screen or
    // mouse-driven programs keep xterm's own handling.
    let press = null;
    const area = container.current,
      pressed = (event) => {
        press = { x: event.clientX, y: event.clientY };
      },
      clicked = (event) => {
        const buffer = t.buffer.active,
          screen = t.element?.querySelector(".xterm-screen");
        if (
          ended ||
          !press ||
          !screen ||
          event.button !== 0 ||
          event.detail !== 1 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4 ||
          t.hasSelection() ||
          t.modes.mouseTrackingMode !== "none" ||
          buffer.type !== "normal" ||
          buffer.viewportY !== buffer.baseY
        )
          return;
        const box = screen.getBoundingClientRect(),
          col = Math.floor(((event.clientX - box.left) / box.width) * t.cols),
          row = Math.floor(((event.clientY - box.top) / box.height) * t.rows);
        if (row < 0 || row >= t.rows) return;
        const move = cursorMoveFor(buffer, {
          cols: t.cols,
          col,
          row: buffer.viewportY + row,
          applicationCursor: t.modes.applicationCursorKeysMode,
        });
        if (move) connection.input(move);
      };
    area.addEventListener("pointerdown", pressed, true);
    area.addEventListener("click", clicked);
    return () => {
      area.removeEventListener("pointerdown", pressed, true);
      area.removeEventListener("click", clicked);
      observer.disconnect();
      input.dispose();
      selection.dispose();
      connection.dispose();
      t.dispose();
      handle.current = null;
      clipboard.current = null;
    };
  }, [id]);
  useEffect(() => {
    if (focus) handle.current?.focus();
  }, [focus, id]);
  return (
    <div className="terminal-view">
      <div className="terminal-tools">
        <span role="status">{status}</span>
        <button
          type="button"
          disabled={!selected}
          onClick={() => clipboard.current?.copy()}
          aria-label="Copy terminal selection"
          title="Copy selection (Ctrl+C or Ctrl+Shift+C)"
        >
          Copy
        </button>
        <button
          type="button"
          onClick={() => clipboard.current?.paste()}
          aria-label="Paste into terminal"
          title="Paste (Ctrl+V, Ctrl+Shift+V or Shift+Insert)"
        >
          Paste
        </button>
      </div>
      <div className="terminal-container" ref={container} />
    </div>
  );
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
// shell on the host; closing the pane ends them all.
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
          title={group ? "Close this terminal and all its tabs" : "Close pane"}
          onClick={(e) => {
            e.stopPropagation();
            if (group) onEnd();
            else onClose();
          }}
        >
          <Icon name="close" size={14} />
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
