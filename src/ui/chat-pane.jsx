import React, { useState, useEffect, useRef, useImperativeHandle } from "react";
import { api } from "./api.mjs";
import { Icon, Markdown, Approval } from "./components.jsx";
import { readPending, savePending } from "./outbox.mjs";
import { readDraft, saveDraft } from "./drafts.mjs";
import { useChatScroll } from "./chat-scroll.jsx";
import { ModelPicker } from "./model-picker.jsx";
import { SkillPicker } from "./skills-modal.jsx";
import {
  chatMarker,
  chatMarkerLabel,
  providerStatusLabel,
  workspacePeersLabel,
} from "./status.mjs";
import { elapsed, greeting, providerName, workingLine } from "./voice.mjs";
import { StepSummary } from "./steps.jsx";

// A turn's byline names the agent once, and the model only when it changed.
// What the turn did sits under the byline as one summary line.
function Conversation({ chat, onOpenWork }) {
  let lastModel = null;
  return chat.messages.map((m, i) => {
    if (m.role !== "assistant") return <UserTurn key={m.id} message={m} />;
    const prev = chat.messages[i - 1],
      sameTurn =
        prev?.role === "assistant" &&
        (prev.run_id ?? null) === (m.run_id ?? null),
      model = !sameTurn && m.model !== lastModel ? m.model : null;
    if (!sameTurn) lastModel = m.model;
    return (
      <article
        className={"message assistant " + (m.provider ?? "")}
        key={m.id}
        id={m.id}
      >
        {!sameTurn && (
          <div className="message-byline">
            <span className={"provider-dot " + m.provider} />
            <strong>{providerName(m.provider)}</strong>
            {model && <span>{model}</span>}
            <a href={`/?chat=${chat.id}#${m.id}`} title="Link to this message">
              <Icon name="link" size={13} />
            </a>
          </div>
        )}
        {!sameTurn && m.run_id && (
          <StepSummary
            steps={chat.steps?.[m.run_id]}
            active={chat.activeRun?.id === m.run_id}
            onOpenWork={onOpenWork}
          />
        )}
        <Markdown text={m.content} />
      </article>
    );
  });
}
function UserTurn({ message }) {
  const [open, setOpen] = useState(false),
    text = message.content ?? "",
    long = text.length > 520 || text.split("\n").length > 6;
  return (
    <article
      className={"message user" + (long && !open ? " clamped" : "")}
      id={message.id}
    >
      <Markdown text={text} />
      {long && (
        <button className="show-more" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </article>
  );
}
function Elapsed({ since }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span>{since ? elapsed(since, now) : ""}</span>;
}

const permissionModes = [
  [
    "auto",
    "Auto-review",
    "Claude Code and Codex use their native reviewers. Cursor uses a separate Codex subscription reviewer; connect Codex to enable it. Browser actions still ask you.",
  ],
  ["manual", "Manual review", "You approve each action the agent asks about."],
  [
    "override",
    "Override",
    "Everything is allowed without asking, including commands outside the sandbox. Questions from the agent still come to you.",
  ],
];

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
  skills = [],
  onOpenSkills,
  reload,
  refresh,
  report,
  onOpenConnections,
  onOpenWork,
}) {
  const draftKey = chat?.id ?? "new:" + (project?.id ?? "");
  const [provider, setProvider] = useState(
      chat ? chat.provider : selection.provider,
    ),
    [model, setModel] = useState(chat ? chat.model : selection.model),
    [effort, setEffort] = useState(
      chat ? (chat.effort ?? "") : selection.effort,
    ),
    [permissions, setPermissions] = useState(
      chat ? chat.permissions : selection.permissions,
    ),
    [draft, setDraft] = useState(() => readDraft(draftKey)),
    [busy, setBusy] = useState(false),
    [permissionsBusy, setPermissionsBusy] = useState(false),
    [skillIds, setSkillIds] = useState(chat?.skillIds ?? []),
    [skillsBusy, setSkillsBusy] = useState(false);
  const messages = useChatScroll(chat),
    input = useRef(null),
    sending = useRef(false);
  const connected = providers.find((p) => p.id === provider),
    selectedModel = connected?.models?.find((m) => m.id === model);
  useEffect(() => {
    saveDraft(draftKey, draft);
  }, [draftKey, draft]);
  useEffect(() => {
    onSelection({ provider, model, effort, permissions });
  }, [provider, model, effort, permissions]);
  // A saved chat brings its own agent. An unconfirmed send is settled with the
  // host before its text is restored, so it is never submitted twice.
  useEffect(() => {
    if (!chat) return;
    setProvider(chat.provider);
    setModel(chat.model);
    setEffort(chat.effort ?? "");
    setPermissions(chat.permissions);
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
        if (pending.permissions) setPermissions(pending.permissions);
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
    if (chat && !permissionsBusy) setPermissions(chat.permissions);
  }, [chat?.id, chat?.permissions, permissionsBusy]);
  const skillKey = chat?.skillIds?.join("\n") ?? "";
  useEffect(() => {
    if (sending.current) return;
    setSkillIds(chat?.skillIds ?? []);
  }, [chat?.id, skillKey]);
  useEffect(() => {
    const known = new Set(skills.map((skill) => skill.id));
    setSkillIds((ids) =>
      ids.every((id) => known.has(id))
        ? ids
        : ids.filter((id) => known.has(id)),
    );
  }, [skills]);
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
  async function changePermissions(next) {
    setPermissions(next);
    if (!chat) return;
    setPermissionsBusy(true);
    try {
      await api(`/api/chats/${chat.id}`, { permissions: next }, "PATCH");
      await reload(chat.id);
    } catch (e) {
      await reload(chat.id).catch(() => {});
      report(e);
    } finally {
      setPermissionsBusy(false);
    }
  }
  async function changeSkills(next) {
    setSkillIds(next);
    if (!chat) return;
    setSkillsBusy(true);
    try {
      const saved = await api(
        `/api/chats/${chat.id}/skills`,
        { skillIds: next },
        "PUT",
      );
      setSkillIds(saved.skillIds);
    } catch (e) {
      report(e);
      await reload(chat.id).catch(() => {});
    } finally {
      setSkillsBusy(false);
    }
  }
  async function send(override) {
    const text = typeof override === "string" ? override : draft;
    if (
      !text.trim() ||
      !project ||
      busy ||
      permissionsBusy ||
      skillsBusy ||
      chat?.activeRun ||
      !model ||
      (selectedModel?.efforts?.length && !effort)
    )
      return;
    setBusy(true);
    sending.current = true;
    try {
      const c =
        chat ??
        (await ensureChat({
          provider,
          model,
          effort,
          permissions,
          skillIds,
        }));
      if (chat) await api(`/api/chats/${chat.id}/skills`, { skillIds }, "PUT");
      if (!chat) saveDraft(draftKey, "");
      const prior = readPending(c.id);
      const body =
        prior &&
        prior.text === text &&
        prior.provider === provider &&
        prior.model === model &&
        prior.permissions === permissions
          ? prior
          : {
              chatId: c.id,
              actionId: crypto.randomUUID(),
              text,
              provider,
              model,
              effort: effort || null,
              permissions,
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
      className={"chat-pane " + provider + (focused ? " focused" : "")}
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
      <div
        ref={messages}
        className={"messages " + (chat?.messages?.length ? "" : "empty")}
        onClick={followLink}
      >
        {!chat?.messages?.length ? (
          <div className="welcome">
            <h1>{greeting()}</h1>
            <p>{project ? "Who's on this one?" : "Add a project to begin."}</p>
            {/* Each card opens its agent's models; choosing one sets the
                composer up and puts the cursor in it. */}
            <div className="provider-cards">
              {providers.map((p) => {
                const chosen = provider === p.id && !!selectedModel,
                  ready = p.connected && !p.blockReason,
                  count = p.models?.filter((m) => !m.disabled).length ?? 0;
                return (
                  <ModelPicker
                    key={p.id}
                    className="provider-card-slot"
                    root={[p.id]}
                    providers={providers}
                    provider={provider}
                    model={model}
                    effort={effort}
                    onChange={(choice) => {
                      setProvider(choice.provider);
                      setModel(choice.model);
                      setEffort(choice.effort);
                      requestAnimationFrame(() => input.current?.focus());
                    }}
                    onOpenConnections={onOpenConnections}
                    renderTrigger={(props) => (
                      <button
                        {...props}
                        className={
                          "provider-card " + p.id + (chosen ? " chosen" : "")
                        }
                        aria-label={`Choose a ${p.name} model`}
                      >
                        <strong>{p.name}</strong>
                        <span className={ready ? "" : "warning"}>
                          {!ready
                            ? providerStatusLabel(p)
                            : chosen
                              ? [
                                  selectedModel.name,
                                  effort &&
                                    effort[0].toUpperCase() + effort.slice(1),
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : count === 1
                                ? p.models.find((m) => !m.disabled).name
                                : `${count} models`}
                        </span>
                      </button>
                    )}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          <Conversation chat={chat} onOpenWork={onOpenWork} />
        )}
        {chat?.activeRun &&
          chat.steps?.[chat.activeRun.id]?.length > 0 &&
          !chat.messages.some(
            (m) => m.role === "assistant" && m.run_id === chat.activeRun.id,
          ) && (
            <div className={"pending-steps " + chat.activeRun.provider}>
              <StepSummary
                steps={chat.steps?.[chat.activeRun.id]}
                active
                onOpenWork={onOpenWork}
              />
            </div>
          )}
        {chat?.activeRun && !chat.approvals?.length && (
          <div
            className={
              "working-indicator " +
              chat.activeRun.provider +
              (chat.activeRun.status === "waiting" ? " waiting" : "")
            }
          >
            <span className="pulse-dot" />
            {workingLine(
              chat.activeRun.provider,
              chat.activeRun.status === "waiting",
            )}
            <Elapsed since={chat.activeRun.created_at} />
          </div>
        )}
        {!chat?.activeRun && chat?.runs?.[0]?.status === "interrupted" && (
          <div className="notice">
            The host restarted during this turn. Review partial work, then send
            a message to continue. No action was replayed.
          </div>
        )}
        {!chat?.activeRun && chat?.runs?.[0]?.status === "failed" && (
          <div className="notice failed">
            <strong>Work stopped.</strong>{" "}
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
                ? `Ask ${providerName(provider)} anything…`
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
            <ModelPicker
              providers={providers}
              provider={provider}
              model={model}
              effort={effort}
              onChange={(choice) => {
                setProvider(choice.provider);
                setModel(choice.model);
                setEffort(choice.effort);
              }}
              onOpenConnections={onOpenConnections}
            />
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
                  permissionsBusy ||
                  !draft.trim() ||
                  !project ||
                  skillsBusy ||
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
          <label
            className={"permissions-control " + permissions}
            title={permissionModes.find(([id]) => id === permissions)?.[2]}
          >
            <select
              aria-label="Permissions"
              value={permissions}
              disabled={busy || permissionsBusy}
              onChange={(e) => changePermissions(e.target.value)}
            >
              {permissionModes.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <SkillPicker
            skills={skills}
            skillIds={skillIds}
            disabled={busy || skillsBusy}
            onChange={changeSkills}
            onCreate={onOpenSkills}
          />
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
          {chat && (
            <span
              className="history-scope"
              title="History access is fixed for this conversation. Set the default for new conversations in Connections & usage."
            >
              History:{" "}
              {
                {
                  none: "This conversation",
                  project: "This project",
                  all: "All projects",
                }[chat.scope]
              }
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
