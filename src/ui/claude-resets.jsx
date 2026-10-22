import React from "react";
import { Icon } from "./components.jsx";

// The SDK exposes quota readings, but no reset redemption control. Claude
// owns eligibility, expiry and confirmation on its account usage page.
export function ClaudeResets({ onRefresh, refreshing }) {
  return (
    <div className="claude-resets">
      <p className="muted small">
        If a free reset is available, redeem it in Claude, then refresh your
        usage here.
      </p>
      <div className="claude-reset-actions">
        <a
          href="https://claude.ai/settings/usage"
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Claude resets <span aria-hidden="true">↗</span>
        </a>
        <button
          type="button"
          className="secondary"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <Icon name="refresh" size={14} />
          {refreshing ? "Checking…" : "Refresh usage"}
        </button>
      </div>
    </div>
  );
}
