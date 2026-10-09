import React, { useState, useEffect, useRef, useImperativeHandle } from "react";
import { api } from "./api.mjs";
import { Icon, Markdown, Approval } from "./components.jsx";
import { readPending, savePending } from "./outbox.mjs";
import { readDraft, saveDraft } from "./drafts.mjs";
import {
  chatMarker,
  chatMarkerLabel,
  providerStatusLabel,
  workspacePeersLabel,
} from "./status.mjs";

export function ChatPane({
  ref,
  chat,
  project,
  providers,
  focused,
  solo,
  peers,
  selection,
  onSelection,
  onFocus,
  onClose,
  onOpenChat,
  ensureChat,
  reload,
  refresh,
  report,
  onOpenConnections,
}) {
  const draftKey = chat?.id ?? "new:" + (project?.id ?? "");
  const [provider, setProvider] = useState(
      chat ? chat.provider : selection.provider,
    ),
    [model, setModel] = useState(chat ? chat.model : selection.model),
    [effort, setEffort] = useState(
      chat ? (chat.effort ?? "") : selection.effort,
    ),
    [draft, setDraft] = useState(() => readDraft(draftKey)),
    [busy, setBusy] = useState(false);
  const bottom = useRef(null),
    input = useRef(null),
    sending = useRef(false);
  const connected = providers.find((p) => p.id === provider),
    selectedModel = connected?.models?.find((m) => m.id === model);
  useEffect(() => {
    saveDraft(draftKey, draft);
  }, [draftKey, draft]);
  useEffect(() => {
    onSelection({ provider, model, effort });
  }, [provider, model, effort]);
  // A saved chat brings its own agent. An unconfirmed send is settled with the
  // host before its text is restored, so it is never submitted twice.
  useEffect(() => {
    if (!chat) return;
    setProvider(chat.provider);
    setModel(chat.model);
    setEffort(chat.effort ?? "");
    const pending = readPending(chat.id);
    if (!pending || sending.current) return;
    let ignore = false;
    api("/api/actions/" + encodeURIComponent(pending.actionId))
      .then(({ run }) => {
        if (ignore || sending.current) return;
        if (run) {
          savePending(chat.id, null);
          setDraft("");
          return reload(chat.id);
        }
        setDraft(pending.text);
        setProvider(pending.provider);
        setModel(pending.model);
        setEffort(pending.effort ?? "");
        report(
          new Error(
            "Your unconfirmed message was restored. Sending it again uses the same action ID.",
          ),
        );
      })
      .catch(report);
    return () => {
      ignore = true;
    };
  }, [chat?.id]);
  useEffect(() => {
    if (!connected?.models?.length) return;
    const available = connected.models.some(
      (m) => m.id === model && !m.disabled,
    );
    if (model && !available) {
      setModel("");
      setEffort("");
    }
  }, [provider, model, connected]);
  useEffect(() => {
    if (selectedModel && effort && !selectedModel.efforts.includes(effort))
      setEffort("");
  }, [model]);
  useEffect(() => {
    if (bottom.current && chat?.activeRun)
      bottom.current.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [chat?.messages?.at(-1)?.content]);
  async function send(override) {
    const text = typeof override === "string" ? override : draft;
    if (
      !text.trim() ||
      !project ||
      busy ||
      chat?.activeRun ||
      !model ||
      (selectedModel?.efforts?.length && !effort)
    )
      return;
    setBusy(true);
    sending.current = true;
    try {
      const c = chat ?? (await ensureChat({ provider, model, effort }));
      if (!chat) saveDraft(draftKey, "");
      const prior = readPending(c.id);
      const body =
        prior &&
        prior.text === text &&
        prior.provider === provider &&
        prior.model === model
          ? prior
          : {
              chatId: c.id,
              actionId: crypto.randomUUID(),
              text,
              provider,
              model,
              effort: effort || null,
            };
      savePending(c.id, body);
      await api(`/api/chats/${c.id}/messages`, body);
      savePending(c.id, null);
      setDraft("");
      await reload(c.id);
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  useImperativeHandle(ref, () => ({
    send,
    focus: () => input.current?.focus(),
  }));
  const act = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      report(e);
    }
  };
  // Links to other chats open in a pane instead of replacing the whole workspace.
  const followLink = (e) => {
    const link = e.target.closest?.('a[href^="/?chat="]');
    if (!link) return;
    const url = new URL(link.href),
      id = url.searchParams.get("chat");
    if (!id || id.includes(",")) return;
    e.preventDefault();
    onOpenChat(id, e.ctrlKey || e.metaKey, url.hash.slice(1));
  };
  const title = chat?.title ?? "New conversation",
    marker = chatMarker(chat);
  return (
    <section
      className={"chat-pane" + (focused ? " focused" : "")}
      aria-label={title}
      onPointerDown={onFocus}
      onFocus={onFocus}
    >
      {!solo && (
        <header className="pane-header">
          <span className={"provider-dot " + (chat?.provider ?? provider)} />
          <strong title={title}>{title}</strong>
          {["approval", "running"].includes(marker) && (
            <span
              className={"chat-marker marker-" + marker}
              role="img"
              aria-label={chatMarkerLabel(marker)}
            />
          )}
          {project && <span>{project.name}</span>}
          <button
            className="icon-button"
            aria-label="Close pane"
            title="Close this pane. The chat keeps running."
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </header>
      )}
      <div className="messages" onClick={followLink}>
        {!chat?.messages?.length ? (
          <div className="welcome">
            <div className="eyebrow">ONE WORKSPACE. YOUR AGENTS.</div>
            <h1>What are we building?</h1>
            <p>
              Start with a task, pick an agent, and keep the whole story
              together.
            </p>
            <div className="provider-cards">
              {providers.map((p) => (
                <button
                  className={
                    "provider-card " + (provider === p.id ? "chosen" : "")
                  }
                  key={p.id}
                  onClick={() => setProvider(p.id)}
                >
                  <span className={"provider-emblem " + p.id}>
                    {p.id === "codex" ? "C" : p.id === "claude" ? "✳" : "↗"}
                  </span>
                  <strong>{p.name}</strong>
                  <span>
                    <i
                      className={
                        "status-dot " +
                        (!p.connected || p.blockReason ? "warning" : "")
                      }
                    />
                    {providerStatusLabel(p)}
                  </span>
                </button>
              ))}
            </div>
            <div className="starter-grid">
              {[
                "Explain this codebase",
                "Review my current changes",
                "Help me implement a feature",
              ].map((t, i) => (
                <button key={t} onClick={() => setDraft(t)}>
                  <Icon name={["search", "review", "plus"][i]} />
                  {t}
                  <span>↗</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          chat.messages.map((m) => (
            <article className={"message " + m.role} key={m.id} id={m.id}>
              {m.role === "assistant" && (
                <div className="message-byline">
                  <span className={"provider-dot " + m.provider} />
                  <strong>
                    {m.provider === "claude"
                      ? "Claude Code"
                      : m.provider === "cursor"
                        ? "Cursor"
                        : "Codex"}
                  </strong>
                  <span>{m.model}</span>
                  <a
                    href={`/?chat=${chat.id}#${m.id}`}
                    title="Link to this message"
                  >
                    <Icon name="link" size={12} />
                  </a>
                </div>
              )}
              <Markdown text={m.content} />
            </article>
          ))
        )}
        {chat?.activeRun && (
          <div className="working-indicator">
            <span className="pulse-dot" />
            {chat.activeRun.status === "waiting"
              ? "Waiting for your approval"
              : "Working"}
            <span>
              {chat.activeRun.provider} · {chat.activeRun.model}
            </span>
          </div>
        )}
        {!chat?.activeRun && chat?.runs?.[0]?.status === "interrupted" && (
          <div className="notice">
            The host restarted during this turn. Review partial work, then send
            a message to continue. No action was replayed.
          </div>
        )}
        {!chat?.activeRun && chat?.runs?.[0]?.status === "failed" && (
          <div className="notice">
            Work stopped:{" "}
            {chat.runs[0].error ?? "The provider could not finish this turn."}{" "}
            Send a message to continue after resolving the issue.
          </div>
        )}
        {chat?.approvals?.map((a) => (
          <Approval
            key={a.id}
            approval={a}
            onAnswer={(answer) => api("/api/approvals/" + a.id, answer)}
          />
        ))}
        <div ref={bottom} />
      </div>
      <div className="composer-area">
        {connected?.blockReason && (
          <button className="billing-notice" onClick={onOpenConnections}>
            <span className="status-dot warning" />
            {connected.blockReason}
            <span>View setup ↗</span>
          </button>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            ref={input}
            aria-label="Message your coding agent"
            placeholder={
              project
                ? "Describe a task, ask a question, or request a review…"
                : "Add a project to start a conversation…"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                send();
              }
            }}
            disabled={!project}
          />
          <div className="composer-controls">
            <div className="model-control">
              <span className={"provider-dot " + provider} />
              <select
                aria-label="Agent and model"
                value={model ? provider + "|" + model : ""}
                onChange={(e) => {
                  if (!e.target.value) {
                    setModel("");
                    setEffort("");
                    return;
                  }
                  const [p, ...m] = e.target.value.split("|");
                  setProvider(p);
                  setModel(m.join("|"));
                  setEffort("");
                }}
              >
                <option value="">Choose a model</option>
                {providers.map((p) => (
                  <optgroup label={p.name + " · " + p.route} key={p.id}>
                    {p.models?.map((m) => (
                      <option
                        key={m.id}
                        value={p.id + "|" + m.id}
                        disabled={m.disabled}
                      >
                        {p.name} · {m.name}
                        {m.disabled ? " · unavailable" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <select
              className="effort-select"
              aria-label="Reasoning effort"
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
              disabled={!selectedModel?.efforts?.length}
            >
              <option value="">
                {selectedModel?.efforts?.length
                  ? "Choose effort"
                  : "Provider preset"}
              </option>
              {selectedModel?.efforts?.map((e) => (
                <option key={e} value={e}>
                  {e[0].toUpperCase() + e.slice(1)}
                </option>
              ))}
            </select>
            <span className="composer-spacer" />
            {chat?.activeRun ? (
              <button
                type="button"
                className="send-button stopping"
                aria-label="Stop work"
                onClick={act(() => api(`/api/chats/${chat.id}/cancel`, {}))}
              >
                <Icon name="stop" size={16} />
              </button>
            ) : (
              <button
                className="send-button"
                aria-label="Send message"
                disabled={
                  busy ||
                  !draft.trim() ||
                  !project ||
                  !model ||
                  (selectedModel?.efforts?.length && !effort) ||
                  !!connected?.blockReason
                }
              >
                <Icon name="arrow" size={18} />
              </button>
            )}
          </div>
        </form>
        <div className="composer-footer">
          <span>
            <Icon name="check" size={12} />
            Subscription only
          </span>
          {peers.length > 0 && (
            <span
              className="workspace-peers"
              title={
                "Also working here: " +
                peers.map((c) => c.title).join(", ") +
                ". Each agent is told about the others and to commit only its own files."
              }
            >
              {workspacePeersLabel(peers)}
            </span>
          )}
          {chat ? (
            <label>
              History{" "}
              <select
                aria-label="Shared history scope"
                value={chat.scope}
                disabled={!!chat.activeRun}
                onChange={(e) => {
                  api(
                    "/api/chats/" + chat.id,
                    { scope: e.target.value },
                    "PATCH",
                  )
                    .then(() => reload(chat.id))
                    .catch(report);
                }}
              >
                <option value="none">This conversation</option>
                <option value="project">This project</option>
                <option value="all">All projects</option>
              </select>
            </label>
          ) : (
            <span>Code and history stay on your Windows host</span>
          )}
          <span className="keyboard-hint">↵ send · shift ↵ newline</span>
        </div>
      </div>
    </section>
  );
}
