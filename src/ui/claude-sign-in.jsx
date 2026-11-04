import React, { useEffect, useState } from "react";
import { api } from "./api.mjs";

// The login URL arrives after the click, so open the tab first. A later
// provider refresh clears the pending state when the process finishes.
export function ClaudeSignIn({ request, onProviders, report, disabled }) {
  const [waiting, setWaiting] = useState(false);
  const [pending, setPending] = useState(false);
  const [url, setUrl] = useState(null);
  useEffect(() => {
    setPending(false);
  }, [request]);
  async function start() {
    const popup = window.open("about:blank", "_blank");
    setWaiting(true);
    try {
      const result = await api("/api/providers/claude/login", {});
      if (result.url) {
        setUrl(result.url);
        if (popup) popup.location.href = result.url;
      } else popup?.close();
      if (result.pending) setPending(true);
      if (result.providers) onProviders?.(result.providers);
    } catch (error) {
      popup?.close();
      report?.(error);
    } finally {
      setWaiting(false);
    }
  }
  const busy = disabled || waiting || pending;
  return (
    <div className="claude-sign-in">
      <code>{request.command}</code>
      <button type="button" className="secondary" disabled={busy} onClick={start}>
        {busy ? "Waiting for browser sign-in…" : request.label}
      </button>
      {url && (
        <a href={url} target="_blank" rel="noreferrer">
          Open the sign-in page
        </a>
      )}
    </div>
  );
}
