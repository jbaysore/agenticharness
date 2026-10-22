import React from "react";
import { Icon } from "./components.jsx";

export function Attachments({ files = [], onRemove, disabled = false }) {
  if (!files.length) return null;
  return (
    <ul
      className="attachments"
      aria-label={onRemove ? "Attached files" : "Message attachments"}
    >
      {files.map((file) => (
        <li key={file.id} className="attachment">
          <a href={file.url} target="_blank" rel="noreferrer" title={file.name}>
            {file.type?.startsWith("image/") ? (
              <img src={file.url} alt={file.name} />
            ) : (
              <Icon name="file" size={22} />
            )}
            <span>
              <strong>{file.name}</strong>
              <small>
                {file.size < 1024
                  ? `${file.size} B`
                  : file.size < 1024 * 1024
                    ? `${Math.ceil(file.size / 1024)} KB`
                    : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}
              </small>
            </span>
          </a>
          {onRemove && (
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove ${file.name}`}
              disabled={disabled}
              onClick={() => onRemove(file.id)}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
