import React, { useEffect, useState } from "react";
import { api } from "./api.mjs";

const pending = (w) =>
  ["registering", "pending", "settling", "retrying"].includes(w.status);
const ciLabels = {
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
const kindLabels = {
  command: {
    registering: "Starting command",
    pending: "Waiting for command",
    retrying: "Retrying command monitoring",
    success: "Command finished",
    failure: "Command failed",
    expired: "Command watch expired",
    error: "Command needs attention",
    stopped: "Watch cancelled",
  },
  pr: {
    registering: "Connecting to GitHub",
    pending: "Waiting for pull request",
    settling: "Confirming pull request",
    retrying: "Waiting to retry",
    success: "Pull request ready",
    failure: "Pull request needs changes",
    updated: "Pull request updated",
    expired: "Watch expired",
    error: "Watch needs attention",
    stopped: "Watch cancelled",
  },
  file: {
    registering: "Checking file",
    pending: "Waiting for file",
    retrying: "Retrying file monitoring",
    success: "File condition met",
    expired: "Watch expired",
    error: "File watch needs attention",
    stopped: "Watch cancelled",
  },
};
const labelFor = (watch) =>
  (kindLabels[watch.kind] ?? ciLabels)[watch.status] ??
  ciLabels[watch.status] ??
  watch.status;
const ringFor = (watch) =>
  ({
    command: "Watching command",
    pr: "Watching pull request",
    file: "Watching file",
  })[watch.kind] ?? "Watching CI";
const titleFor = (watch) => {
  if (watch.kind === "command")
    return (watch.command ?? "").split("\n")[0].slice(0, 160);
  if (watch.kind === "file") return watch.path;
  return `${watch.repository ?? ""}${watch.pr ? ` #${watch.pr}` : ""}`;
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
  const local = (chat?.watches ?? []).some(
    (w) => pending(w) && ["command", "file"].includes(w.kind),
  );
  useEffect(() => {
    if (!ongoing) return;
    // Read host bookkeeping, never force another GitHub check or model turn.
    const timer = setInterval(
      () => reload(chat.id).catch(report),
      local ? 5_000 : 60_000,
    );
    return () => clearInterval(timer);
  }, [chat?.id, ongoing, local, reload, report]);
}

export function WatchCards({ chat, watches = [], reload, refresh, report }) {
  const [busy, setBusy] = useState(null);
  const [now, setNow] = useState(Date.now);
  const ongoing = watches.some(pending);
  useEffect(() => {
    if (!ongoing) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [ongoing]);
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
    <section className="watch-cards" aria-label="Background watchers">
      {watches.map((watch) => {
        const live = pending(watch) && !chat.activeRun;
        const overdue =
          pending(watch) &&
          watch.nextCheckAt &&
          now - watch.nextCheckAt > 30_000;
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
                  aria-label={ringFor(watch)}
                />
              )}
              <strong>{labelFor(watch)}</strong>
              {watch.url ? (
                <a href={watch.url} target="_blank" rel="noreferrer">
                  {titleFor(watch)}
                </a>
              ) : (
                <span>{titleFor(watch)}</span>
              )}
              {(watch.sha || watch.commit) && (
                <code title={watch.sha ?? watch.commit}>
                  {(watch.sha ?? watch.commit).slice(0, 8)}
                </code>
              )}
            </div>
            {pending(watch) ? (
              <p className="watch-times">
                Monitoring uses no model calls.
                {watch.armed
                  ? " Authorized follow-up is armed."
                  : " Notification only."}{" "}
                · Last check: {time(watch.lastCheckedAt)} · Next:{" "}
                {time(watch.nextCheckAt)}
                {watch.armed && watch.reviewAt
                  ? ` · Agent review: ${time(watch.reviewAt)}`
                  : ""}{" "}
                · Expires: {time(watch.expiresAt)}
              </p>
            ) : (
              <div className="watch-times">
                Last check: {time(watch.lastCheckedAt)}
              </div>
            )}
            {watch.reason && <p>{watch.reason}</p>}
            {overdue && (
              <p role="status">
                Monitoring check overdue. Last host check:{" "}
                {time(watch.lastCheckedAt)}.
              </p>
            )}
            {["command", "file"].includes(watch.kind) && (
              <p className="watch-times">
                Last activity: {time(watch.lastActivityAt)}
                {watch.kind === "command" &&
                  ` · Runner heartbeat: ${time(watch.lastHeartbeatAt)}`}
                {watch.kind === "file" &&
                  watch.fileObserved &&
                  (watch.fileObserved.exists
                    ? ` · File present (${watch.fileObserved.size.toLocaleString()} bytes)`
                    : " · File not present yet")}
              </p>
            )}
            {watch.excerpt && (
              <details className="watch-output">
                <summary>
                  {watch.kind === "command"
                    ? "Latest command output"
                    : "Latest file output"}
                </summary>
                <pre>{watch.excerpt}</pre>
              </details>
            )}
            {watch.delivery === "pending" && (
              <p>{watch.deliveryReason ?? "Follow-up is queued."}</p>
            )}
            {watch.delivery === "blocked" &&
              watch.deliveryReason &&
              watch.deliveryReason !== watch.reason && (
                <p>{watch.deliveryReason}</p>
              )}
            {watch.delivery === "delivered" && (
              <p>
                {watch.followupStatus === "failed"
                  ? `Agent follow-up failed: ${watch.followupError ?? "Unknown error"}`
                  : ["cancelled", "interrupted"].includes(watch.followupStatus)
                    ? "Agent follow-up was interrupted."
                    : watch.followupStatus === "completed"
                      ? "Agent follow-up completed."
                      : watch.followupRunId
                        ? "Agent follow-up is running."
                        : "Follow-up sent to the agent."}
              </p>
            )}
            {watch.items?.length > 0 && (
              <ul aria-label="Watch results">
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
                (watch.delivery !== "delivered" ||
                  ["failed", "cancelled", "interrupted"].includes(
                    watch.followupStatus,
                  )) &&
                watch.delivery !== "pending" && (
                  <button
                    disabled={
                      busy === watch.id ||
                      !!chat.activeRun ||
                      !!chat.archived_at
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
