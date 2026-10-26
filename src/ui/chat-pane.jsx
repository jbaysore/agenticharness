import React, { useState, useEffect, useRef, useImperativeHandle } from "react";
import { flushSync } from "react-dom";
import { api } from "./api.mjs";
import { Icon, Markdown, Approval } from "./components.jsx";
import { readPending, savePending } from "./outbox.mjs";
import {
  readDraft,
  saveDraft,
  readDraftAttachments,
  saveDraftAttachments,
} from "./drafts.mjs";
import { Attachments } from "./attachments.jsx";
import { useChatScroll } from "./chat-scroll.jsx";
import { ModelPicker } from "./model-picker.jsx";
import { DirectoryPicker } from "./directory-picker.jsx";
import { SkillSlash } from "./skills-modal.jsx";
import {
  DELIVERY_COMMANDS,
  MODE_COMMANDS,
  applyCommand,
  dropCommand,
  prepareMessage,
} from "../core/skills.mjs";
import {
  chatMarker,
  chatMarkerLabel,
  providerStatusLabel,
  workspacePeersLabel,
} from "./status.mjs";
import {
  elapsed,
  greeting,
  providerName,
  turnTiming,
  workingLine,
} from "./voice.mjs";
import { StepSummary } from "./steps.jsx";
import { interleave } from "../core/steps.mjs";
import { blockingGoals } from "../core/goals.mjs";

// A turn's byline names the agent once, and the model only when it changed.
// Below it the turn reads in order: short progress updates, each followed by
// the work it led to, then the closing reply.
function Conversation({ chat, onOpenWork }) {
  const turns = [];
  for (const m of chat.messages) {
    const last = turns.at(-1);
    if (m.role !== "assistant") turns.push({ user: m });
    else if (
      last?.replies &&
      (last.replies[0].run_id ?? null) === (m.run_id ?? null)
    )
      last.replies.push(m);
    else turns.push({ replies: [m] });
  }
  let lastModel = null;
  const runs = new Map((chat.runs ?? []).map((run) => [run.id, run]));
  return turns.map(({ user, replies }) => {
    if (user) return <UserTurn key={user.id} message={user} />;
    const first = replies[0],
      model = first.model !== lastModel ? first.model : null;
    lastModel = first.model;
    const active = !!first.run_id && chat.activeRun?.id === first.run_id,
      parts = interleave(
        replies,
        first.run_id ? chat.steps?.[first.run_id] : [],
      ),
      lastWork = parts.findLastIndex((part) => part.steps.length),
      timing = active ? null : turnTiming(runs.get(first.run_id));
    return (
      <article
        className={"message assistant " + (first.provider ?? "")}
        key={first.id}
        id={first.id}
      >
        <div className="message-byline">
          <span className={"provider-dot " + first.provider} />
          <strong>{providerName(first.provider)}</strong>
          {model && <span>{model}</span>}
          {timing && (
            <time className="turn-timing" title={timing.title}>
              {timing.label}
            </time>
          )}
          <a
            href={`/?chat=${chat.id}#${first.id}`}
            title="Link to this message"
          >
            <Icon name="link" size={13} />
          </a>
        </div>
        {parts.map(({ message, steps }, i) => (
          <React.Fragment key={message?.id ?? "start"}>
            {message?.content?.trim() && (
              <div
                className={"reply" + (i <= lastWork ? " update" : "")}
                id={message === first ? undefined : message.id}
              >
                <Markdown text={message.content} />
              </div>
            )}
            {steps.length > 0 && (
              <StepSummary
                steps={steps}
                active={active && i === lastWork}
                onOpenWork={onOpenWork}
              />
            )}
          </React.Fragment>
        ))}
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
      <Attachments files={message.attachments} />
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
    "The reviewer allows or declines commands, edits, and browser actions. It asks you only for a managerial choice, and explains why. If review cannot run, the action comes to you.",
  ],
  ["manual", "Manual review", "You approve each action the agent asks about."],
  [
    "override",
    "Override",
    "Everything is allowed without asking, including commands outside the sandbox. Questions from the agent still come to you.",
  ],
];
// Each mode is the agent's own. Ask is read-only on every agent: Cursor's
// native Ask mode, Codex's read-only sandbox, and Claude Code limited to
// read and search tools. Plan and goal stay separate from it.
const chatModes = [
  ["default", "Default", "The agent works on your message as usual."],
  [
    "ask",
    "Ask",
    "Read-only. The agent answers questions and explains how things work. It cannot change files, land commits, or change a page.",
  ],
  [
    "plan",
    "Plan",
    "The agent researches and proposes a plan without changing anything. Confirm and build to have it built.",
  ],
  [
    "goal",
    "Goal",
    "Your message becomes a goal. The agent keeps working, turn after turn, until it is met. Not available for Cursor.",
  ],
];

export function ChatPane({
  ref,
  chat,
  project,
  projects,
  onChangeProject,
  providers,
  focused,
  solo,
  mobile = false,
  compact = false,
  headerDrag,
  dropTarget,
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
  onDismissUsage,
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
    [attachments, setAttachments] = useState(() =>
      readDraftAttachments(draftKey),
    ),
    [uploading, setUploading] = useState(false),
    [dragging, setDragging] = useState(false),
    [busy, setBusy] = useState(false),
    [permissionsBusy, setPermissionsBusy] = useState(false),
    [mode, setMode] = useState(chat?.mode ?? "default"),
    [modeBusy, setModeBusy] = useState(false),
    [keptPlans, setKeptPlans] = useState(() => new Set()),
    [caret, setCaret] = useState(0);
  const messages = useChatScroll(chat),
    input = useRef(null),
    slash = useRef(null),
    fileInput = useRef(null),
    headerDragAllowed = useRef(false),
    uploadingRef = useRef(false),
    sending = useRef(false);
  const connected = providers.find((p) => p.id === provider),
    selectedModel = connected?.models?.find((m) => m.id === model);
  useEffect(() => {
    saveDraft(draftKey, draft);
  }, [draftKey, draft]);
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    const resize = () => {
      field.style.height = "";
      if (compact) {
        field.style.height = "0px";
        field.style.height =
          Math.min(96, Math.max(36, field.scrollHeight)) + "px";
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(field.parentElement);
    return () => observer.disconnect();
  }, [draft, compact]);
  useEffect(() => {
    saveDraftAttachments(draftKey, attachments);
  }, [draftKey, attachments]);
  useEffect(() => {
    onSelection({ provider, model, effort, permissions });
  }, [provider, model, effort, permissions]);
  // A saved chat brings its own agent. An unconfirmed send is settled with the
  // host before its text is restored, so it is never submitted twice. Once the
  // host confirms it never took the message, the text is an ordinary draft and
  // the chat no longer reopens by itself on every start.
  useEffect(() => {
    if (!chat) return;
    setProvider(chat.provider);
    setModel(chat.model);
    setEffort(chat.effort ?? "");
    setPermissions(chat.permissions);
    setMode(chat.mode ?? "default");
    const pending = readPending(chat.id);
    if (!pending || sending.current) return;
    let ignore = false;
    api("/api/actions/" + encodeURIComponent(pending.actionId))
      .then(({ run, input }) => {
        if (ignore || sending.current) return;
        savePending(chat.id, null);
        if (run || input) {
          setDraft("");
          setAttachments([]);
          return reload(chat.id);
        }
        setDraft(pending.text);
        setAttachments(pending.attachmentFiles ?? []);
        setProvider(pending.provider);
        setModel(pending.model);
        setEffort(pending.effort ?? "");
        if (pending.permissions) setPermissions(pending.permissions);
        if (pending.mode) setMode(pending.mode);
        report(
          new Error(
            "Your unsent message was restored. Harness never received it.",
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
  useEffect(() => {
    if (chat && !modeBusy) setMode(chat.mode ?? "default");
  }, [chat?.id, chat?.mode, modeBusy]);
  useEffect(() => {
    if (provider === "cursor" && mode === "goal") setMode("default");
  }, [provider, mode]);
  useEffect(() => {
    setKeptPlans(new Set());
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
  // A Cursor model's effort levels appear once Harness has used it, so a chat
  // already on it starts from the default instead of blocking the next send.
  useEffect(() => {
    if (provider === "cursor" && !effort && selectedModel?.defaultEffort)
      setEffort(selectedModel.defaultEffort);
  }, [provider, effort, selectedModel?.defaultEffort]);
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
  async function changeMode(next) {
    setMode(next);
    if (!chat) return;
    setModeBusy(true);
    try {
      await api(`/api/chats/${chat.id}`, { mode: next }, "PATCH");
      await reload(chat.id);
    } catch (e) {
      await reload(chat.id).catch(() => {});
      report(e);
    } finally {
      setModeBusy(false);
    }
  }
  function pickSkill(command) {
    const field = input.current;
    const next = applyCommand(
      field?.value ?? draft,
      field?.selectionStart ?? caret,
      command,
    );
    flushSync(() => {
      setDraft(next.text);
      setCaret(next.cursor);
    });
    field?.focus();
    field?.setSelectionRange(next.cursor, next.cursor);
  }
  // /ask, /plan, /goal and /default switch the chat's mode, as the mode menu does.
  // During a turn they stay in the draft, so they apply to the queued message.
  const modeCommands = MODE_COMMANDS.filter(
    (entry) => !(provider === "cursor" && entry.mode === "goal"),
  ).map((entry) => ({
    ...entry,
    description: chatModes.find(([id]) => id === entry.mode)[2],
  }));
  function pickMode(next) {
    if (chat?.activeRun) {
      const command = MODE_COMMANDS.find(
        (entry) => entry.mode === next,
      )?.command;
      if (command) pickSkill(command);
      return;
    }
    const field = input.current;
    const left = dropCommand(
      field?.value ?? draft,
      field?.selectionStart ?? caret,
    );
    flushSync(() => {
      setDraft(left.text);
      setCaret(left.cursor);
    });
    field?.focus();
    field?.setSelectionRange(left.cursor, left.cursor);
    if (next !== mode) changeMode(next);
  }
  async function changeDirectory({ project: next, path }) {
    if (sending.current || uploadingRef.current) return;
    sending.current = true;
    setBusy(true);
    try {
      next ??= await api("/api/projects", { path });
      if (next.id === project?.id) return;
      // Uploads belong to a project. Copy draft attachments before switching,
      // so the new conversation can send them and failures keep the old draft.
      const files = [];
      for (const file of attachments) {
        const response = await fetch(file.url);
        if (!response.ok) throw new Error(`Could not copy ${file.name}`);
        files.push(
          await api(
            `/api/projects/${next.id}/attachments`,
            await response.blob(),
            "POST",
            { "X-Harness-Filename": encodeURIComponent(file.name) },
          ),
        );
      }
      await onChangeProject(next, {
        provider,
        model,
        effort,
        permissions,
        mode,
      });
      if (!chat) {
        saveDraft(draftKey, "");
        saveDraftAttachments(draftKey, []);
      }
      setAttachments(files);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function attachFiles(files, pasted = false) {
    if (!project || sending.current || uploadingRef.current || !files.length)
      return;
    if (attachments.length + files.length > 10) {
      report(new Error("Attach up to 10 files per message."));
      return;
    }
    uploadingRef.current = true;
    setUploading(true);
    try {
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) {
          report(
            new Error(
              `${file.name} is too large. Files must be 20 MB or smaller.`,
            ),
          );
          continue;
        }
        const name =
          pasted && file.type.startsWith("image/")
            ? `Screenshot-${Date.now()}-${file.name || "image.png"}`
            : file.name || "attachment";
        try {
          const saved = await api(
            `/api/projects/${project.id}/attachments`,
            file,
            "POST",
            {
              "X-Harness-Filename": encodeURIComponent(name),
            },
          );
          setAttachments((current) => [...current, saved]);
        } catch (e) {
          report(e);
        }
      }
    } finally {
      uploadingRef.current = false;
      setUploading(false);
      input.current?.focus();
    }
  }
  async function send(override, turnMode = mode) {
    const text = typeof override === "string" ? override : draft;
    const prepared = prepareMessage(text);
    const hasBody = !!prepared.text.trim() || attachments.length > 0;
    // /ask alone switches mode. /queue or /steer alone does nothing.
    if (!hasBody) {
      if (prepared.delivery || !prepared.mode) return;
      if (busy || modeBusy || chat?.activeRun) return;
      if (provider === "cursor" && prepared.mode === "goal") {
        report(
          new Error("Cursor has no goal mode. Choose Codex or Claude Code."),
        );
        return;
      }
      if (prepared.mode !== mode) await changeMode(prepared.mode);
      setDraft("");
      return;
    }
    if (
      !project ||
      busy ||
      sending.current ||
      uploadingRef.current ||
      permissionsBusy ||
      modeBusy ||
      !model ||
      (selectedModel?.efforts?.length && !effort)
    )
      return;
    setBusy(true);
    sending.current = true;
    let c, body;
    try {
      c =
        chat ??
        (await ensureChat({
          provider,
          model,
          effort,
          permissions,
          mode: turnMode,
        }));
      if (!chat) {
        saveDraft(draftKey, "");
        saveDraftAttachments(draftKey, []);
      }
      const prior = readPending(c.id);
      body =
        prior &&
        prior.text === text &&
        JSON.stringify(prior.attachments ?? []) ===
          JSON.stringify(attachments.map((f) => f.id)) &&
        prior.provider === provider &&
        prior.model === model &&
        prior.permissions === permissions &&
        prior.mode === turnMode
          ? prior
          : {
              chatId: c.id,
              actionId: crypto.randomUUID(),
              text,
              attachments: attachments.map((f) => f.id),
              attachmentFiles: attachments,
              provider,
              model,
              effort: effort || null,
              permissions,
              mode: turnMode,
            };
      savePending(c.id, body);
      await api(`/api/chats/${c.id}/messages`, body);
      savePending(c.id, null);
      setDraft("");
      setAttachments([]);
      await reload(c.id);
      await refresh();
    } catch (e) {
      report(e);
      // A refused message stays in the composer but is no longer unconfirmed.
      if (body && e.status >= 400 && e.status < 500 && !e.unreachable)
        await api("/api/actions/" + encodeURIComponent(body.actionId))
          .then(({ run, input }) => {
            if (!run && !input) savePending(c.id, null);
          })
          .catch(() => {});
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
  const finishedPlan = chat?.runs?.[0];
  const planReady =
    chat &&
    !chat.activeRun &&
    mode === "plan" &&
    finishedPlan?.status === "completed" &&
    !keptPlans.has(finishedPlan.id) &&
    !chat.approvals?.some((a) => a.request?.kind === "plan")
      ? finishedPlan
      : null;
  return (
    <section
      className={"chat-pane " + provider + (focused ? " focused" : "")}
      aria-label={title}
      onPointerDown={onFocus}
      onFocus={onFocus}
    >
      {!solo && (
        <header
          className={"pane-header" + (dropTarget ? " drop-target" : "")}
          draggable={!!headerDrag}
          {...headerDrag}
          onPointerDown={(event) => {
            headerDragAllowed.current = !event.target.closest("button");
          }}
          onDragStart={(event) => {
            if (!headerDragAllowed.current) event.preventDefault();
            else headerDrag?.onDragStart(event);
          }}
        >
          <span className={"provider-dot " + (chat?.provider ?? provider)} />
          <strong title={title}>{title}</strong>
          {["approval", "running", "usage"].includes(marker) && (
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
        {!chat?.activeRun && chat?.usage_stopped_at && (
          <div className="notice failed">
            <strong>This turn stopped because usage ran out.</strong>{" "}
            {chat.usage_stopped_reason} Come back after it resets, or continue
            with another agent.
            <button
              type="button"
              className="notice-dismiss"
              onClick={() => onDismissUsage?.()}
            >
              Dismiss
            </button>
          </div>
        )}
        {!chat?.activeRun &&
          !chat?.usage_stopped_at &&
          chat?.runs?.[0]?.id !== chat?.usage_dismissed_run_id &&
          chat?.runs?.[0]?.status === "failed" && (
          <div className="notice failed">
            <strong>Work stopped.</strong>{" "}
            {chat.runs[0].error ?? "The provider could not finish this turn."}{" "}
            Send a message to continue after resolving the issue.
          </div>
        )}
        {!chat?.activeRun && blockingGoals(chat).length > 0 && (
          <div className="notice">
            This Goal has not been confirmed stopped, so Harness updates are
            waiting. Send a message to continue, or use Stop work to stop it.
          </div>
        )}
        {/* A finished plan that was not confirmed in the turn uses the same
            card. Confirming leaves plan mode and builds. Keep planning hides
            it for that run, including after Cursor declines its plan. */}
        {planReady && (
          <Approval
            approval={{
              provider: planReady.provider ?? provider,
              request: {
                kind: "plan",
                title: "Happy with the plan?",
                plan: chat.proposedPlans?.[planReady.id],
              },
            }}
            onAnswer={async (answer) => {
              if (!answer.allow) {
                setKeptPlans((ids) => new Set(ids).add(planReady.id));
                return;
              }
              await changeMode("default");
              await send("Implement the plan.", "default");
            }}
          />
        )}
        {chat?.approvals?.map((a) => (
          <Approval
            key={a.id}
            approval={a}
            onAnswer={async (answer) => {
              const saved = await api("/api/approvals/" + a.id, answer);
              if (a.request?.kind === "plan" && !answer.allow)
                setKeptPlans((ids) => new Set(ids).add(a.run_id));
              return saved;
            }}
          />
        ))}
      </div>
      <div className="composer-area">
        <SkillSlash
          ref={slash}
          skills={skills}
          modes={modeCommands}
          commands={DELIVERY_COMMANDS}
          text={draft}
          caret={caret}
          onPick={pickSkill}
          onMode={pickMode}
          onCreate={onOpenSkills}
        />
        {chat?.queue?.length > 0 && (
          <ul className="queued-messages" aria-label="Queued messages">
            {chat.queue.map((item) => (
              <li key={item.id}>
                <span>{item.text || "Attachment"}</span>
                <button
                  type="button"
                  className="text-button"
                  aria-label="Remove queued message"
                  onClick={act(() =>
                    api(`/api/chats/${chat.id}/queue/${item.id}`, {}, "DELETE"),
                  )}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {connected?.blockReason && (
          <button className="billing-notice" onClick={onOpenConnections}>
            <span className="status-dot warning" />
            {connected.blockReason}
            <span>View setup ↗</span>
          </button>
        )}
        <form
          className={"composer" + (dragging ? " dragging" : "")}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            if (project && !busy && !uploading) setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setDragging(false);
            attachFiles(Array.from(e.dataTransfer.files));
          }}
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            type="file"
            ref={fileInput}
            className="attachment-input"
            aria-label="Upload files"
            multiple
            disabled={!project || busy || uploading}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              attachFiles(files);
            }}
          />
          <Attachments
            files={attachments}
            disabled={busy || uploading}
            onRemove={(id) =>
              setAttachments((files) => files.filter((f) => f.id !== id))
            }
          />
          {uploading && (
            <div className="attachment-status" role="status">
              Uploading files…
            </div>
          )}
          {dragging && (
            <div className="attachment-status">Drop files to attach</div>
          )}
          <textarea
            ref={input}
            rows={compact ? 1 : 2}
            aria-label="Message your coding agent"
            placeholder={
              !project
                ? "Add a project to start a conversation…"
                : chat?.activeRun
                  ? "Queues until this turn finishes. /steer redirects it…"
                  : `Ask ${providerName(provider)} anything…`
            }
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setCaret(e.target.selectionStart ?? 0);
            }}
            onSelect={(e) => setCaret(e.target.selectionStart ?? 0)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (!files.length) return;
              e.preventDefault();
              const text = e.clipboardData.getData("text/plain");
              if (text) {
                const field = e.currentTarget;
                setDraft(
                  field.value.slice(0, field.selectionStart) +
                    text +
                    field.value.slice(field.selectionEnd),
                );
              }
              attachFiles(files, true);
            }}
            onKeyDown={(e) => {
              if (slash.current?.onKeyDown(e)) return;
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                (!mobile || e.ctrlKey || e.metaKey)
              ) {
                e.preventDefault();
                send();
              }
            }}
            disabled={!project}
          />
          <div className="composer-controls">
            <button
              type="button"
              className="icon-button attach-button"
              aria-label="Attach files"
              title="Attach files or paste a screenshot · Up to 10 files, 20 MB each"
              disabled={
                !project || busy || uploading || attachments.length >= 10
              }
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="attach" size={18} />
            </button>
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
            {(chat?.activeRun || blockingGoals(chat).length > 0) && (
              <button
                type="button"
                className="send-button stopping"
                aria-label="Stop work"
                onClick={act(() => api(`/api/chats/${chat.id}/cancel`, {}))}
              >
                <Icon name="stop" size={16} />
              </button>
            )}
            <button
              className="send-button"
              aria-label="Send message"
              title={
                chat?.activeRun
                  ? "Queues until this turn finishes. Include /steer to redirect it."
                  : "Send message"
              }
              disabled={
                busy ||
                uploading ||
                permissionsBusy ||
                modeBusy ||
                (!draft.trim() && !attachments.length) ||
                !project ||
                !model ||
                (selectedModel?.efforts?.length && !effort) ||
                !!connected?.blockReason
              }
            >
              <Icon name="arrow" size={18} />
            </button>
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
          <label
            className={"mode-control " + mode}
            title={chatModes.find(([id]) => id === mode)?.[2]}
          >
            <select
              aria-label="Mode"
              value={mode}
              disabled={busy || modeBusy || !!chat?.activeRun}
              onChange={(e) => changeMode(e.target.value)}
            >
              {chatModes.map(([id, label]) => (
                <option
                  key={id}
                  value={id}
                  disabled={id === "goal" && provider === "cursor"}
                >
                  {label}
                </option>
              ))}
            </select>
          </label>
          {(compact || mobile) && (chat || peers.length > 0) && (
            <details
              className="composer-details"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector("summary").focus();
                  event.stopPropagation();
                }
              }}
            >
              <summary
                aria-label="Conversation details"
                title="History and workspace details"
              >
                <Icon name="menu" size={15} />
              </summary>
              <div className="composer-details-popover">
                {chat && (
                  <p>
                    History:{" "}
                    {
                      {
                        none: "This conversation",
                        project: "This project",
                        all: "All projects",
                      }[chat.scope]
                    }
                  </p>
                )}
                {peers.length > 0 && (
                  <p>
                    {workspacePeersLabel(peers)}:{" "}
                    {peers.map((c) => c.title).join(", ")}
                  </p>
                )}
              </div>
            </details>
          )}
          {!compact && !mobile && peers.length > 0 && (
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
          {!compact && !mobile && chat && (
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
          {!chat?.messages?.length &&
            !chat?.runs?.length &&
            !Object.keys(chat?.sessions ?? {}).length &&
            !chat?.worktree && (
              <DirectoryPicker
                project={project}
                projects={projects}
                disabled={busy || uploading || permissionsBusy || modeBusy}
                onChange={changeDirectory}
              />
            )}
        </div>
      </div>
    </section>
  );
}
