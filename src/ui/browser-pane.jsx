import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./components.jsx";
import { terminalInputChunks } from "./terminal-stream.mjs";

// Keys the page handles itself. Ctrl+V and its kin are left to the browser,
// whose paste event then carries the clipboard text in.
const isPaste = (e) =>
  ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") ||
  (e.shiftKey && e.key === "Insert");

// The shared Chrome, which runs on the host without a window. Pages the agents
// open show here live; clicking, scrolling and typing reach the page.
export function BrowserPane({ report }) {
  const canvas = useRef(null),
    socket = useRef(null),
    page = useRef({ width: 0, height: 0 }),
    [tabs, setTabs] = useState([]),
    [status, setStatus] = useState("Starting Chrome…"),
    [address, setAddress] = useState(""),
    [editing, setEditing] = useState(false),
    [hasFrame, setHasFrame] = useState(false),
    [loading, setLoading] = useState(false),
    [agent, setAgent] = useState(null),
    // A desktop page is small in the side panel; expanded, it covers the
    // workspace at close to its own size.
    [expanded, setExpanded] = useState(false),
    slot = useRef(null),
    // The work panel contains its layout, which would trap a fixed overlay.
    // The view lives in its own node, moved between the panel and the page
    // body, so the canvas and its last frame survive the move.
    [mount] = useState(() => document.createElement("div"));
  useLayoutEffect(() => {
    mount.className = "browser-mount";
    (expanded ? document.body : slot.current)?.appendChild(mount);
  }, [expanded]);
  useEffect(() => () => mount.remove(), []);
  const current = tabs.find((tab) => tab.active);
  const send = (message) => {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify(message));
  };
  useEffect(() => {
    if (!editing)
      setAddress(current?.url === "about:blank" ? "" : (current?.url ?? ""));
  }, [current?.url, editing]);
  useEffect(() => {
    const url = new URL("/api/browser/stream", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let disposed = false,
      paused = false,
      timer,
      delay = 500,
      meta = null,
      received = 0,
      drawn = 0;
    const connect = () => {
      const ws = new WebSocket(url);
      ws.binaryType = "blob";
      socket.current = ws;
      ws.onopen = () => {
        delay = 500;
        setStatus("");
      };
      ws.onmessage = async (event) => {
        if (disposed) return;
        if (typeof event.data !== "string") {
          const frame = meta,
            // Frames decode in parallel; one that finishes after a newer
            // frame was drawn is stale.
            seq = ++received;
          meta = null;
          if (!frame || !canvas.current) return;
          const image = await createImageBitmap(event.data);
          const c = canvas.current;
          if (!c || seq < drawn) return image.close();
          drawn = seq;
          if (c.width !== image.width || c.height !== image.height) {
            c.width = image.width;
            c.height = image.height;
          }
          c.getContext("2d").drawImage(image, 0, 0);
          image.close();
          page.current = { width: frame.width, height: frame.height };
          setHasFrame(true);
          return;
        }
        const message = JSON.parse(event.data);
        if (message.type === "frame") meta = message;
        else if (message.type === "state") {
          setTabs(message.tabs);
          setLoading(!!message.loading);
          setAgent(message.agent ?? null);
          if (!message.tabs.some((tab) => tab.active)) setHasFrame(false);
        } else if (message.type === "copied") {
          if (message.text)
            navigator.clipboard
              ?.writeText(message.text)
              .catch(() =>
                report(new Error("The clipboard was not available to copy.")),
              );
        } else if (message.type === "error") report(new Error(message.error));
      };
      ws.onclose = () => {
        if (disposed || paused) return;
        setStatus("Reconnecting…");
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 5000);
      };
    };
    // A hidden Harness tab stops the stream, which also stops Chrome's
    // screencast, and picks it up again when shown.
    const visibility = () => {
      if (document.hidden && !paused) {
        paused = true;
        clearTimeout(timer);
        socket.current?.close();
      } else if (!document.hidden && paused) {
        paused = false;
        delay = 500;
        connect();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    if (document.hidden) paused = true;
    else connect();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", visibility);
      clearTimeout(timer);
      socket.current?.close();
      socket.current = null;
    };
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const escape = (e) => {
      if (e.key === "Escape" && document.activeElement !== canvas.current)
        setExpanded(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [expanded]);
  // Wheel events must be cancellable, which React's listener is not.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    let pending = null;
    const wheel = (e) => {
      e.preventDefault();
      const point = toPage(e);
      if (!point) return;
      if (pending) {
        pending.deltaX += e.deltaX;
        pending.deltaY += e.deltaY;
        return;
      }
      pending = { ...point, deltaX: e.deltaX, deltaY: e.deltaY };
      requestAnimationFrame(() => {
        send({ type: "mouse", action: "wheel", ...pending });
        pending = null;
      });
    };
    c.addEventListener("wheel", wheel, { passive: false });
    return () => c.removeEventListener("wheel", wheel);
  }, []);
  const toPage = (e) => {
    const c = canvas.current,
      { width, height } = page.current;
    if (!c || !width) return null;
    const box = c.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / box.width) * width,
      y: ((e.clientY - box.top) / box.height) * height,
    };
  };
  const moving = useRef(null);
  const pointer = (action) => (e) => {
    if (action === "down") {
      canvas.current?.focus();
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    const point = toPage(e);
    if (!point) return;
    if (action === "move") {
      // One move per animation frame is enough to hover and drag.
      const first = !moving.current;
      moving.current = point;
      if (first)
        requestAnimationFrame(() => {
          send({ type: "mouse", action: "move", ...moving.current });
          moving.current = null;
        });
      return;
    }
    e.preventDefault();
    send({
      type: "mouse",
      action,
      ...point,
      button: e.button,
      clickCount: Math.max(1, e.detail || 1),
    });
  };
  const key = (action) => (e) => {
    if (isPaste(e) || e.key === "Process" || e.key === "Unidentified") return;
    e.preventDefault();
    // Ctrl+C still reaches the page; the panel also copies its selection.
    if (
      action === "down" &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      e.key.toLowerCase() === "c"
    )
      send({ type: "copy" });
    send({ type: "key", action, key: e.key });
  };
  const empty = !current;
  return (
    <div className="browser-slot" ref={slot}>
      {createPortal(view(), mount)}
    </div>
  );
  function view() {
    return (
      <div className={"browser-panel" + (expanded ? " expanded" : "")}>
        <div className="browser-toolbar">
          <button
            className="icon-button"
            aria-label="Back"
            title="Back"
            disabled={empty}
            onClick={() => send({ type: "back" })}
          >
            <Icon name="back" size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="Forward"
            title="Forward"
            disabled={empty}
            onClick={() => send({ type: "forward" })}
          >
            <Icon name="forward" size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="Reload"
            title="Reload"
            disabled={empty}
            onClick={() => send({ type: "reload" })}
          >
            <Icon name="refresh" size={14} />
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!address.trim()) return;
              send({ type: "navigate", url: address.trim() });
              setEditing(false);
              e.currentTarget.querySelector("input").blur();
            }}
          >
            <input
              aria-label="Address"
              placeholder="Enter a web address"
              value={address}
              spellCheck={false}
              onFocus={(e) => {
                setEditing(true);
                e.target.select();
              }}
              onBlur={() => setEditing(false)}
              onChange={(e) => setAddress(e.target.value)}
            />
          </form>
          <button
            className="icon-button"
            aria-label={expanded ? "Return to panel" : "Expand"}
            aria-pressed={expanded}
            title={
              expanded
                ? "Return the browser to the side panel (Esc)"
                : "Expand the browser over the workspace"
            }
            onClick={() => setExpanded(!expanded)}
          >
            <Icon name={expanded ? "collapse" : "expand"} size={14} />
          </button>
        </div>
        {tabs.length > 1 && (
          <div
            className="browser-tabs"
            role="tablist"
            aria-label="Browser tabs"
          >
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={"browser-tab" + (tab.active ? " active" : "")}
              >
                <button
                  role="tab"
                  aria-selected={tab.active}
                  title={tab.url}
                  onClick={() => send({ type: "select", tab: tab.id })}
                >
                  {tab.title || tab.url || "New tab"}
                </button>
                <button
                  className="icon-button"
                  aria-label={`Close ${tab.title || "tab"}`}
                  title="Close this tab"
                  onClick={() => send({ type: "close-tab", tab: tab.id })}
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="browser-view">
          {loading && <div className="browser-progress" aria-hidden="true" />}
          {agent && (
            <div className="browser-agent" role="status">
              <span className="working-dot" aria-hidden="true" />
              Agent: {agent.replace(/^Browser: /, "")}
            </div>
          )}
          <canvas
            ref={canvas}
            tabIndex={0}
            aria-label={
              current ? `Page: ${current.title || current.url}` : "Page"
            }
            className={hasFrame ? "" : "hidden"}
            onPointerDown={pointer("down")}
            onPointerUp={pointer("up")}
            onPointerMove={pointer("move")}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={key("down")}
            onKeyUp={key("up")}
            onPaste={(e) => {
              e.preventDefault();
              const text = e.clipboardData.getData("text/plain");
              for (const chunk of terminalInputChunks(text))
                send({ type: "text", text: chunk });
            }}
          />
          {!hasFrame && (
            <div className="panel-empty">
              <Icon name="globe" size={28} />
              <h3>{status || (empty ? "No page open" : "Loading…")}</h3>
              {!status && empty && (
                <p>
                  Pages an agent opens show here. Enter an address to open one
                  yourself.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
}
