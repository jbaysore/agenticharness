import React, { useEffect, useRef, useState } from "react";
import { api } from "./api.mjs";
import { Icon } from "./components.jsx";
import { ISSUE_CATEGORIES } from "../core/reliability.mjs";

const base = (id) => `/api/chats/${encodeURIComponent(id)}/reliability`;
const changed = (id) =>
  window.dispatchEvent(
    new CustomEvent("harness-reliability", {
      detail: { conversationId: id, type: "reliability-update" },
    }),
  );
const when = (value) =>
  value ? new Date(value).toLocaleString() : "Unavailable";
const duration = (ms) =>
  ms == null
    ? "Unknown"
    : ms < 60000
      ? `${Math.floor(ms / 1000)}s`
      : `${Math.floor(ms / 3600000)}h ${Math.floor(ms / 60000) % 60}m`;
export async function reliabilityAction(id, action) {
  const result = await api(base(id) + "/actions", {
    actionId: crypto.randomUUID(),
    ...action,
  });
  changed(id);
  return result;
}

export function useReliability(chat, provider, model, open) {
  const [data, setData] = useState(null),
    [error, setError] = useState(null),
    sequence = useRef(0);
  const generation = chat?.contextByProvider?.[provider]?.generation;
  const session = chat?.contextByProvider?.[provider]?.sessionId;
  useEffect(() => {
    if (!chat?.id) return;
    let disposed = false,
      timer,
      floor = 0;
    const load = async (refresh = false) => {
      const request = ++sequence.current;
      try {
        const value = await api(
          base(chat.id) +
            `?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}${refresh ? "&refresh=1" : ""}`,
        );
        if (
          !disposed &&
          sequence.current === request &&
          value.lastEventId >= floor
        ) {
          setData({ ...value, chatId: chat.id });
          setError(null);
        }
      } catch (e) {
        if (!disposed && sequence.current === request) setError(e.message);
      }
    };
    void load(open);
    const update = (event) => {
      if (event.detail.conversationId !== chat.id) return;
      floor = Math.max(floor, event.detail.id ?? 0);
      clearTimeout(timer);
      timer = setTimeout(() => load(open), 180);
    };
    window.addEventListener("harness-reliability", update);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("harness-reliability", update);
    };
  }, [chat?.id, provider, model, open, generation, session]);
  const matches =
    data?.chatId === chat?.id &&
    data?.provider === provider &&
    data?.model === model;
  return { data: matches ? data : null, error };
}

export function IssueButton({ chatId, messageId, eventId, menu = false }) {
  const [open, setOpen] = useState(false),
    [menuOpen, setMenuOpen] = useState(false),
    [category, setCategory] = useState(ISSUE_CATEGORIES[0]),
    [note, setNote] = useState(""),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false),
    box = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event) => {
        if (!box.current?.contains(event.target)) setMenuOpen(false);
      },
      escape = (event) => {
        if (event.key === "Escape") setMenuOpen(false);
      };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);
  if (!chatId || (!messageId && !eventId)) return null;
  const form = open && (
    <span className="issue-form">
      <label>
        Issue category
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {ISSUE_CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label>
        Optional issue note
        <textarea
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {error && <span role="alert">{error}</span>}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await reliabilityAction(chatId, {
              kind: "report",
              category,
              note,
              ...(messageId ? { messageId } : { eventId }),
            });
            setOpen(false);
            setNote("");
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Record issue
      </button>
    </span>
  );
  if (!menu)
    return (
      <span className="issue-control">
        <button
          type="button"
          className="text-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Flag reliability issue
        </button>
        {form}
      </span>
    );
  return (
    <span
      className={"issue-control message-actions" + (open || menuOpen ? " open" : "")}
      ref={box}
    >
      <button
        type="button"
        className="icon-button"
        aria-label="Message actions"
        title="Message actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => {
          e.stopPropagation();
          if (open) {
            setOpen(false);
            setMenuOpen(false);
            return;
          }
          setMenuOpen(!menuOpen);
        }}
      >
        <Icon name="more" size={14} />
      </button>
      {menuOpen && (
        <span className="message-actions-menu" role="menu" aria-label="Message actions">
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(false);
              setOpen(true);
            }}
          >
            Flag reliability issue
          </button>
        </span>
      )}
      {form}
    </span>
  );
}

export function TrackCheckButton({ chatId, targetId }) {
  const [state, setState] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <span className="check-control">
      <button
        type="button"
        className="text-button"
        disabled={busy || state === "Tracked"}
        onClick={async () => {
          setBusy(true);
          try {
            await reliabilityAction(chatId, { kind: "track", targetId });
            setState("Tracked");
          } catch (e) {
            setState(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Track as check
      </button>
      {state && <span role="status">{state}</span>}
    </span>
  );
}

function Evidence({ chatId, eventId, messageId }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(null);
  if (messageId)
    return <a href={`/?chat=${chatId}#${messageId}`}>View source message</a>;
  if (!eventId) return null;
  return (
    <details
      onToggle={async (e) => {
        if (!e.currentTarget.open || data) return;
        try {
          setData(await api(base(chatId) + "/evidence/" + eventId));
        } catch (failure) {
          setError(failure.message);
        }
      }}
    >
      <summary>View evidence</summary>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <pre>
          {data?.text ?? "Loading recorded evidence…"}
          {data?.truncated ? "\n[Evidence display truncated]" : ""}
        </pre>
      )}
    </details>
  );
}

function ContextHistory({ data }) {
  const points = data.history;
  if (!points.length)
    return <p>No completed-turn context history is available.</p>;
  const max = Math.max(1, ...points.map((p) => p.usedTokens ?? 0));
  const comparable = (a, b) =>
    a &&
    b &&
    a.generation === b.generation &&
    a.basis === b.basis &&
    a.source === b.source &&
    a.windowTokens === b.windowTokens &&
    Number.isSafeInteger(a.usedTokens) &&
    Number.isSafeInteger(b.usedTokens);
  return (
    <>
      <svg
        className="context-history"
        viewBox="0 0 300 64"
        role="img"
        aria-label="Context tokens over up to 30 completed turns. Lines break at measurement transitions."
      >
        {points.map((p, i) => {
          if (!Number.isSafeInteger(p.usedTokens)) return null;
          const x =
              points.length === 1 ? 150 : 8 + (i * 284) / (points.length - 1),
            y = 57 - (p.usedTokens / max) * 49;
          const prev = points[i - 1];
          return (
            <g key={p.runId}>
              {comparable(prev, p) && (
                <line
                  x1={8 + ((i - 1) * 284) / (points.length - 1)}
                  y1={57 - (prev.usedTokens / max) * 49}
                  x2={x}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth="2"
                />
              )}
              {prev && prev.generation !== p.generation && (
                <line
                  x1={x}
                  x2={x}
                  y1="3"
                  y2="62"
                  stroke="currentColor"
                  strokeDasharray="2 3"
                />
              )}
              <circle cx={x} cy={y} r="3" fill="currentColor">
                <title>
                  {p.usedTokens.toLocaleString()} tokens · {when(p.observedAt)}{" "}
                  · generation {p.generation}
                </title>
              </circle>
            </g>
          );
        })}
      </svg>
      <p>
        {data.growth == null
          ? "Recent growth unavailable across comparable readings."
          : `Recent change: ${data.growth >= 0 ? "+" : ""}${data.growth.toLocaleString()} tokens across comparable completed-turn readings.`}
      </p>
      <details>
        <summary>History measurements</summary>
        <ol>
          {points.map((p) => (
            <li key={p.runId}>
              {p.usedTokens?.toLocaleString() ?? "Unavailable"} tokens ·{" "}
              {when(p.observedAt)} · {p.basis}
            </li>
          ))}
        </ol>
      </details>
    </>
  );
}

export function ReliabilityPanel({ chatId, data, error, reading }) {
  const [actionError, setError] = useState(null);
  const act = async (kind, targetId) => {
    try {
      await reliabilityAction(chatId, { kind, targetId });
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  };
  if (!data)
    return (
      <p role={error ? "alert" : "status"}>
        {error ?? "Loading reliability records…"}
      </p>
    );
  return (
    <div className="reliability-panel">
      <strong>{data.status}</strong>
      <p>
        Task-wide reliability is not assessed. Capacity and session age do not
        measure correctness.
      </p>
      {(error || actionError) && <p role="alert">{error ?? actionError}</p>}
      {data.notices.map((n) => (
        <div className="reliability-notice" key={n.id}>
          <p>{n.title}</p>
          {n.note && <p>{n.note}</p>}
          <Evidence chatId={chatId} {...n} />
          <div className="reliability-actions">
            {["compaction", "handoff", "interruption"].includes(n.type) && (
              <button
                type="button"
                className="text-button"
                onClick={() => act("acknowledge", n.id)}
              >
                Mark reviewed
              </button>
            )}
            {n.type === "user-report" && (
              <button
                type="button"
                className="text-button"
                onClick={() => act("resolve", n.id.slice(6))}
              >
                Resolve issue
              </button>
            )}
            <button
              type="button"
              className="text-button"
              onClick={() => act("dismiss", n.id)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
      <h4>Context</h4>
      <p>
        {reading?.usedTokens?.toLocaleString() ?? "Unavailable"} /{" "}
        {reading?.windowTokens?.toLocaleString() ?? "Unknown window"} tokens ·{" "}
        {reading?.usedTokens != null && reading?.windowTokens > 0
          ? `${Math.max(0, reading.windowTokens - reading.usedTokens).toLocaleString()} available`
          : "Available capacity unknown"}
      </p>
      <p>
        Capacity warnings at 75% and 90% do not indicate hallucination
        thresholds.
      </p>
      <ContextHistory data={data} />
      <h4>Continuity</h4>
      <dl>
        <dt>Observed compactions</dt>
        <dd>{data.compactions}</dd>
        <dt>Last transition</dt>
        <dd>
          {data.latestTransition
            ? `${data.latestTransition.kind} · ${when(data.latestTransition.observedAt)}`
            : "None recorded"}
        </dd>
        <dt>Completed turns since transition</dt>
        <dd>{data.turnsSinceTransition ?? "Unavailable"}</dd>
      </dl>
      <h4>Recorded checks</h4>
      {data.checksCurrent && (
        <p>Checks current for the recorded workspace scope.</p>
      )}
      {!data.checks.length && (
        <p>
          No checks recorded. Successful commands alone do not establish
          correctness.
        </p>
      )}
      {data.checks.map((c) => (
        <div className="recorded-check" key={c.id}>
          <strong>
            {c.outcome === "passed"
              ? "Command succeeded"
              : c.outcome === "failed"
                ? "Check failed"
                : c.outcome}
          </strong>
          <code>{c.command}</code>
          <p>
            {c.freshness} · {c.basis}
          </p>
          <p>
            {c.cwd ?? "Execution directory unavailable"} · {when(c.observedAt)}
          </p>
          <Evidence chatId={chatId} eventId={c.eventId} />
        </div>
      ))}
      <details>
        <summary>Other completed commands</summary>
        {data.commands
          .filter((c) => !data.checks.some((v) => v.id === c.id))
          .map((c) => (
            <div className="recorded-check" key={c.id}>
              <code>{c.command}</code>
              <p>
                Outcome: {c.outcome} · {c.basis}
              </p>
              <TrackCheckButton chatId={chatId} targetId={c.id} />
            </div>
          ))}
      </details>
      <p>{data.coverage}</p>
      {data.workspace && (
        <p>
          Workspace observation: {when(data.workspace.observedAt)}
          {data.workspace.reason ? ` · ${data.workspace.reason}` : ""}
        </p>
      )}
      <h4>Conversation timing</h4>
      <dl>
        <dt>Active run time</dt>
        <dd>{duration(data.timing.activeMs)}</dd>
        <dt>Idle time</dt>
        <dd>{duration(data.timing.idleMs)}</dd>
        <dt>Total elapsed</dt>
        <dd>{duration(data.timing.totalMs)}</dd>
      </dl>
      <p>
        Run time includes provider, tool and approval waits.{" "}
        {data.timing.incomplete
          ? "Timing coverage is incomplete after an interruption."
          : "Based on recorded run intervals."}
      </p>
      {(data.noticeHistory.length > 0 ||
        data.issues.some((i) => i.resolved)) && (
        <details>
          <summary>Review history</summary>
          {data.noticeHistory.map((n) => (
            <div key={n.id}>
              <p>
                {n.title} · {n.acknowledged ? "Reviewed by you" : "Dismissed"}
              </p>
              <Evidence chatId={chatId} {...n} />
              {n.type === "user-report" && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => act("resolve", n.id.slice(6))}
                >
                  Resolve issue
                </button>
              )}
            </div>
          ))}
          {data.issues
            .filter((i) => i.resolved)
            .map((i) => (
              <p key={i.actionId}>Resolved report: {i.category}</p>
            ))}
        </details>
      )}
    </div>
  );
}
