import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const storageKey = "harness.restart-progress.v1";
const restarting = (status) => ["restarting", "recovering"].includes(status);
function readPending() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    return saved?.id && restarting(saved.status) ? saved : null;
  } catch {
    return null;
  }
}
function savePending(value) {
  try {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
  } catch {
    /* Feedback still works for this page if storage is unavailable. */
  }
}

function RestartDialog({ recovering }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current,
      previous = document.activeElement;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="modal restart-progress-modal"
      aria-labelledby="restart-progress-title"
      aria-describedby="restart-progress-message restart-progress-note"
      tabIndex={-1}
      onCancel={(event) => event.preventDefault()}
    >
      <header>
        <h2 id="restart-progress-title">
          {recovering ? "Restoring Harness" : "Harness is restarting"}
        </h2>
      </header>
      <p id="restart-progress-message">
        {recovering
          ? "Sorry! The update couldn't start. Harness is restoring the previous version."
          : "Sorry! Harness is restarting to apply the latest changes."}
      </p>
      <progress
        className="restart-progress-bar"
        aria-label="Harness restart progress"
      />
      <p className="restart-progress-status" role="status">
        {recovering
          ? "Restoring your workspace…"
          : "Waiting for Harness to be ready…"}
      </p>
      <p id="restart-progress-note">
        Your chats and drafts are saved. This dialog will close automatically
        when Harness is ready to use.
      </p>
    </dialog>,
    document.body,
  );
}

// A per-tab marker keeps the dialog visible across the client reload. A status
// event alone cannot dismiss it: the new client and its workspace must be ready.
export function useRestartProgress({ restart, ready, ensureReady }) {
  const [pending, setPending] = useState(readPending);
  const finished = useRef(null),
    check = useRef(ensureReady);
  check.current = ensureReady;
  useEffect(() => {
    if (
      !restart?.id ||
      !restarting(restart.status) ||
      finished.current === restart.id
    )
      return;
    const next = { id: restart.id, status: restart.status };
    savePending(next);
    setPending(next);
  }, [restart?.id, restart?.status]);
  useEffect(() => {
    if (!pending || !ready) return;
    let cancelled = false,
      timer;
    const poll = async () => {
      try {
        if (await check.current()) {
          if (cancelled) return;
          finished.current = pending.id;
          savePending(null);
          setPending(null);
          return;
        }
      } catch {
        /* Keep the dialog up while HTTP and SSE reconnect. */
      }
      if (!cancelled) timer = setTimeout(poll, 1000);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pending?.id, ready]);
  return pending ? (
    <RestartDialog recovering={pending.status === "recovering"} />
  ) : null;
}
