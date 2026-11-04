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

// Cards render inline with their turn, so the chat polls once for all of them.
export function useWatchPolling(chat, reload, report) {
  const ongoing = (chat?.watches ?? []).some(pending);
  useEffect(() => {
    if (!ongoing) return;
    // Read host bookkeeping, never force another GitHub check or model turn.
    const timer = setInterval(() => reload(chat.id).catch(report), 60_000);
    return () => clearInterval(timer);
  }, [chat?.id, ongoing, reload, report]);
}

export function WatchCards({ chat, watches = [], reload, refresh, report }) {
  const [busy, setBusy] = useState(null);
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
      {watches.map((watch) => {
        const live = pending(watch) && !chat.activeRun;
        return (
          <article
            className={[
              "watch-card",
              watch.status,
              watch.provider,
              live ? "live" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={watch.id}
          >
            <div className="watch-title">
              {live && (
                <span
                  className="watch-pulse"
                  role="img"
                  aria-label="Watching CI"
                />
              )}
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
            {pending(watch) ? (
              <p className="watch-times">
                CI monitoring uses no model calls.
                {watch.armed
                  ? " Authorized follow-up is armed."
                  : " Notification only."}{" "}
                · Last check: {time(watch.lastCheckedAt)} · Next:{" "}
                {time(watch.nextCheckAt)} · Expires: {time(watch.expiresAt)}
              </p>
            ) : (
              <div className="watch-times">
                Last check: {time(watch.lastCheckedAt)}
              </div>
            )}
            {watch.reason && <p>{watch.reason}</p>}
            {!pending(watch) && watch.delivery === "pending" && (
              <p>Follow-up is queued behind current work.</p>
            )}
            {watch.delivery === "delivered" && (
              <p>Follow-up sent to the agent.</p>
            )}
            {watch.items?.length > 0 && (
              <ul aria-label="CI results">
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
        );
      })}
    </section>
  );
}
