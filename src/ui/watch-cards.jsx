import React, { useEffect, useState } from "react";
import { api } from "./api.mjs";

const pending = (w) =>
  ["registering", "pending", "settling", "retrying"].includes(w.status);
const labels = {
  registering: "Connecting to GitHub",
  pending: "Waiting for CI",
  settling: "Confirming CI result",
  retrying: "Waiting to retry",
  success: "CI passed",
  failure: "CI failed",
  cancelled: "CI cancelled",
  skipped: "CI skipped",
  expired: "Watch expired",
  error: "Watch needs attention",
  superseded: "Revision changed",
  stopped: "Watch cancelled",
};
const time = (at) =>
  at
    ? new Date(at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not yet";

export function WatchCards({ chat, reload, refresh, report }) {
  const [busy, setBusy] = useState(null);
  const watches = chat?.watches ?? [],
    ongoing = watches.some(pending);
  useEffect(() => {
    if (!ongoing) return;
    // Read host bookkeeping, never force another GitHub check or model turn.
    const timer = setInterval(() => reload(chat.id).catch(report), 60_000);
    return () => clearInterval(timer);
  }, [chat?.id, ongoing, reload, report]);
  if (!watches.length) return null;
  const act = async (watch, continuation) => {
    setBusy(watch.id);
    try {
      await api(
        `/api/chats/${chat.id}/watches/${watch.id}${continuation ? "/continue" : ""}`,
        continuation ? { actionId: crypto.randomUUID() } : undefined,
        continuation ? "POST" : "DELETE",
      );
      await reload(chat.id);
      await refresh();
    } catch (error) {
      report(error);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="watch-cards" aria-label="Background CI watchers">
      {watches.map((watch) => (
        <article className={`watch-card ${watch.status}`} key={watch.id}>
          <div className="watch-title">
            <strong>{labels[watch.status] ?? watch.status}</strong>
            <a href={watch.url} target="_blank" rel="noreferrer">
              {watch.repository}
              {watch.pr ? ` #${watch.pr}` : ""}
            </a>
            {(watch.sha || watch.commit) && (
              <code title={watch.sha ?? watch.commit}>
                {(watch.sha ?? watch.commit).slice(0, 8)}
              </code>
            )}
          </div>
          {pending(watch) && (
            <p>
              CI monitoring uses no model calls.
              {watch.armed
                ? " Authorized follow-up is armed."
                : " Notification only."}
            </p>
          )}
          <div className="watch-times">
            Last check: {time(watch.lastCheckedAt)}
            {pending(watch) && (
              <>
                {" "}
                · Next: {time(watch.nextCheckAt)} · Expires:{" "}
                {time(watch.expiresAt)}
              </>
            )}
          </div>
          {watch.reason && <p>{watch.reason}</p>}
          {!pending(watch) && watch.delivery === "pending" && (
            <p>Follow-up is queued behind current work.</p>
          )}
          {watch.delivery === "delivered" && (
            <p>Follow-up sent to the agent.</p>
          )}
          {watch.items?.length > 0 && (
            <details>
              <summary>{watch.items.length} CI results</summary>
              <ul>
                {watch.items.map((item) => (
                  <li key={item.id}>
                    {item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer">
                        {item.name}
                      </a>
                    ) : (
                      item.name
                    )}
                    : {item.state}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="watch-actions">
            {(pending(watch) || watch.delivery === "pending") && (
              <button
                disabled={busy === watch.id}
                onClick={() => act(watch, false)}
              >
                Cancel watch
              </button>
            )}
            {!pending(watch) &&
              watch.status !== "stopped" &&
              watch.delivery !== "delivered" &&
              watch.delivery !== "pending" && (
                <button
                  disabled={
                    busy === watch.id || !!chat.activeRun || !!chat.archived_at
                  }
                  title={`Continue with ${watch.provider} / ${watch.model}`}
                  onClick={() => act(watch, true)}
                >
                  Continue with agent
                </button>
              )}
          </div>
        </article>
      ))}
    </section>
  );
}
