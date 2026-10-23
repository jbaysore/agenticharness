import React, { useRef, useState } from "react";
import { Icon } from "./components.jsx";
import { chatMarker, chatMarkerLabel } from "./status.mjs";

// One chat in the sidebar. The opening button's name is exactly the chat's
// title; status and the hover actions sit beside it.
export function ChatRow({
  chat,
  placement = "",
  detail,
  canSplit,
  onOpen,
  onRename,
  onPin,
  onArchive,
  onDismissUsage,
}) {
  const [title, setTitle] = useState(null),
    settled = useRef(true);
  const marker = chatMarker(chat),
    label = chatMarkerLabel(marker);
  // Enter, Escape and losing focus can all end a rename; only the first counts.
  const finish = (keep) => {
    if (settled.current) return;
    settled.current = true;
    const next = title.trim();
    setTitle(null);
    if (keep && next && next !== chat.title) onRename(next);
  };
  if (title !== null)
    return (
      <form
        className={"chat-row renaming " + placement}
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        <input
          autoFocus
          aria-label={"Rename " + chat.title}
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") finish(false);
          }}
        />
      </form>
    );
  return (
    <div
      className={
        `chat-row ${chat.provider} ${placement}` +
        (chat.archived_at ? " archived" : "") +
        (chat.pinned_at ? " pinned" : "") +
        (canSplit ? " can-split" : "")
      }
      onClick={(e) => {
        if (!e.target.closest("button")) onOpen(e.ctrlKey || e.metaKey);
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && !e.target.closest("button")) onOpen(true);
      }}
      title={
        [label, chat.pinned_at && "Pinned"].filter(Boolean).join(" · ") ||
        undefined
      }
    >
      <button
        className="chat-open"
        onClick={(e) => onOpen(e.ctrlKey || e.metaKey)}
        onAuxClick={(e) => {
          if (e.button === 1) onOpen(true);
        }}
      >
        <span className={"provider-dot " + chat.provider} aria-hidden="true" />
        {chat.pinned_at && (
          <span className="chat-pin" aria-hidden="true">
            <Icon name="pin" size={12} />
          </span>
        )}
        <span>{chat.title}</span>
      </button>
      {detail && (
        <small className="chat-detail" aria-hidden="true">
          {detail}
        </small>
      )}
      {marker && (
        <span
          className={"chat-marker marker-" + marker}
          role="img"
          aria-label={`${chat.title}: ${label}`}
        />
      )}
      <span className="row-actions">
        {chat.usage_stopped_at && (
          <button
            className="icon-button"
            aria-label={`Dismiss usage flag for ${chat.title}`}
            title="Dismiss usage flag"
            onClick={() => onDismissUsage?.()}
          >
            <Icon name="close" size={13} />
          </button>
        )}
        {canSplit && (
          <button
            className="icon-button"
            aria-label={`Open ${chat.title} beside`}
            title="Open beside the current chat"
            onClick={() => onOpen(true)}
          >
            <Icon name="split" size={13} />
          </button>
        )}
        <button
          className={"icon-button" + (chat.pinned_at ? " active" : "")}
          aria-label={`${chat.pinned_at ? "Unpin" : "Pin"} ${chat.title}`}
          aria-pressed={!!chat.pinned_at}
          title={chat.pinned_at ? "Unpin" : "Pin"}
          onClick={() => onPin(!chat.pinned_at)}
        >
          <Icon name="pin" size={13} />
        </button>
        <button
          className="icon-button"
          aria-label={`Rename ${chat.title}`}
          title="Rename"
          onClick={() => {
            settled.current = false;
            setTitle(chat.title);
          }}
        >
          <Icon name="edit" size={13} />
        </button>
        <button
          className="icon-button"
          aria-label={`${chat.archived_at ? "Unarchive" : "Archive"} ${chat.title}`}
          title={chat.archived_at ? "Unarchive" : "Archive"}
          onClick={() => onArchive(!chat.archived_at)}
        >
          <Icon name="archive" size={13} />
        </button>
      </span>
    </div>
  );
}
