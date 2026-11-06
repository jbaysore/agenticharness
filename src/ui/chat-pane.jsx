import React, { useState, useEffect, useRef, useImperativeHandle } from "react";
import { flushSync } from "react-dom";
import { api } from "./api.mjs";
import { Icon, Markdown, Approval } from "./components.jsx";
import { readPending, savePending, prepareControlAction } from "./outbox.mjs";
import {
  readDraft,
  saveDraft,
  readDraftAttachments,
  saveDraftAttachments,
} from "./drafts.mjs";
import { Attachments } from "./attachments.jsx";
import { useChatScroll } from "./chat-scroll.jsx";
import { ModelPicker } from "./model-picker.jsx";
import { ClaudeSignIn } from "./claude-sign-in.jsx";
import { DirectoryPicker } from "./directory-picker.jsx";
import { ContextBar } from "./context-bar.jsx";
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
  continuationProviders,
  continuationUnavailableTitle,
  providerStatusLabel,
  resetLabel,
  usageResetAt,
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
import { IssueButton } from "./reliability.jsx";
import { interleave } from "../core/steps.mjs";
import { blockingGoals, ownerPauses, resumeOffers } from "../core/goals.mjs";
import { planRevisionRequest, visibleReply } from "../core/plans.mjs";
import { OwnerPauseCard } from "./owner-pause.jsx";
import { GoalProgress } from "./goal-progress.jsx";
import { WatchCards, useWatchPolling } from "./watch-cards.jsx";
import { placeWatches } from "./watch-order.mjs";

// A turn's byline names the agent once, and the model only when it changed.
// Below it the turn reads in order: short progress updates, each followed by
// the work it led to, then the closing reply.
function Conversation({ chat, onOpenWork, watchCards }) {
  const turns = [],
    placed = placeWatches(chat.messages, chat.watches);
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
  const rendered = turns.map(({ user, replies }) => {
    if (user)
      return (
        <React.Fragment key={user.id}>
          {watchCards(placed.get(user.id))}
          <UserTurn message={user} />
        </React.Fragment>
      );
    const first = replies[0];
    const active = !!first.run_id && chat.activeRun?.id === first.run_id,
      shown = interleave(
        replies,
        first.run_id ? chat.steps?.[first.run_id] : [],
      ).map((part) => ({
        ...part,
        reply: part.message
          ? visibleReply(
              part.message.content,
              chat.proposedPlans?.[part.message.run_id],
            )
          : "",
      }));
    // A turn whose only text was the plan leaves no empty byline. The card
    // already shows that plan.
    if (!shown.some((part) => part.reply || part.steps.length)) return null;
    const model = first.model !== lastModel ? first.model : null;
    lastModel = first.model;
    const lastWork = shown.findLastIndex((part) => part.steps.length),
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
        {shown.map(({ message, steps, reply }, i) => (
          <React.Fragment key={message?.id ?? "start"}>
            {reply && (
              <div
                className={"reply" + (i <= lastWork ? " update" : "")}
                id={message === first ? undefined : message.id}
              >
                <Markdown text={reply} />
                <IssueButton chatId={chat.id} messageId={message.id} menu />
              </div>
            )}
            {steps.length > 0 && (
              <StepSummary
                steps={steps}
                chatId={chat.id}
                active={active && i === lastWork}
                onOpenWork={onOpenWork}
              />
            )}
          </React.Fragment>
        ))}
      </article>
    );
  });
  return (
    <>
      {rendered}
      {watchCards(placed.get(null))}
    </>
  );
}
function UserTurn({ message }) {
  const [open, setOpen] = useState(false),
    text = message.content ?? "",
    long = text.length > 520 || text.split("\n").length > 6;
  if (["watcher", "chat-move"].includes(message.source)) return <div className="watch-trigger" role="note" id={message.id}>{text}</div>;
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
function ResetWait({ at }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [at]);
  if (!at) return <>Checking until a reading shows usage is available.</>;
  return <>{resetLabel(at, now)}.</>;
}

const permissionModes = [
  [
    "auto",
    "Auto-review",
    "The reviewer allows or declines commands, edits, and browser actions. It asks you only for a managerial choice, and explains why. If review cannot complete, the action is declined automatically.",
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
    "Your message becomes a goal. The agent keeps working, turn after turn, until it is met. Available for Codex and Claude Code.",
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
  stageSend,
  refresh,
  report,
  onOpenConnections,
  onOpenWork,
  onOpenFile,
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
    [checkingConnections, setCheckingConnections] = useState(false),
    [resumeBusy, setResumeBusy] = useState(false),
    [stopping, setStopping] = useState(""),
    [keptPlans, setKeptPlans] = useState(() => new Set()),
    [caret, setCaret] = useState(0);
  const messages = useChatScroll(chat),
    input = useRef(null),
    slash = useRef(null),
    fileInput = useRef(null),
    headerDragAllowed = useRef(false),
    uploadingRef = useRef(false),
    sending = useRef(false),
    stopTarget = useRef(chat?.id);
  stopTarget.current = chat?.id;
  const connected = providers.find((p) => p.id === provider),
    selectedModel = connected?.models?.find((m) => m.id === model);
  useWatchPolling(chat, reload, report);
  useEffect(() => { setStopping(""); }, [chat?.id]);
  useEffect(() => {
    if (stopping !== "waiting" || !chat?.id) return;
    let ignored = false, timer;
    const poll = async () => {
      try {
        const next = await reload(chat.id);
        if (ignored) return;
        if (!next.activeRun && next.pause?.state !== "requested") {
          setStopping("");
          return;
        }
      } catch (error) { if (!ignored) report(error); }
      if (!ignored) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { ignored = true; clearTimeout(timer); };
  }, [stopping, chat?.id, reload, report]);
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
        if (run || input) {
          savePending(chat.id, null);
          if (!pending.continueAfterUsage && !pending.resumeGoal) {
            setDraft("");
            setAttachments([]);
          }
          return reload(chat.id);
        }
        if (pending.continueAfterUsage || pending.resumeGoal) {
          report(new Error("The continuation was not received. Choose the same action to retry safely."));
          return;
        }
        savePending(chat.id, null);
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
    if (["cursor", "openrouter"].includes(provider) && mode === "goal") setMode("default");
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
    (entry) => !(["cursor", "openrouter"].includes(provider) && entry.mode === "goal"),
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
  async function changeDirectory({ project: next, path, directoryless = false }) {
    if (sending.current || uploadingRef.current) return;
    if (directoryless && (!project || project.scratch)) return;
    sending.current = true;
    setBusy(true);
    try {
      next ??= await api(
        "/api/projects",
        directoryless ? { directoryless: true } : { path },
      );
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
    if (sending.current || uploadingRef.current || !files.length)
      return;
    if (attachments.length + files.length > 10) {
      report(new Error("Attach up to 10 files per message."));
      return;
    }
    uploadingRef.current = true;
    setUploading(true);
    try {
      const projectId =
        project?.id ??
        (await ensureChat({
          provider,
          model,
          effort,
          permissions,
          mode,
        })).project_id;
      if (!chat && !project) {
        saveDraft(draftKey, "");
        saveDraftAttachments(draftKey, []);
      }
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
            `/api/projects/${projectId}/attachments`,
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
    } catch (e) {
      report(e);
    } finally {
      uploadingRef.current = false;
      setUploading(false);
      input.current?.focus();
    }
  }
  async function send(override, turnMode = mode, { planFeedback = false } = {}) {
    const text = typeof override === "string" ? override : draft;
    const prepared = planFeedback ? { text } : prepareMessage(text);
    const files = planFeedback ? [] : attachments;
    const hasBody = !!prepared.text.trim() || files.length > 0;
    // /ask alone switches mode. /queue or /steer alone does nothing.
    if (!hasBody) {
      if (prepared.delivery || !prepared.mode) return;
      if (busy || modeBusy || chat?.activeRun) return;
      if (["cursor", "openrouter"].includes(provider) && prepared.mode === "goal") {
        report(
          new Error("Choose Codex or Claude Code for Goal mode."),
        );
        return;
      }
      if (prepared.mode !== mode) await changeMode(prepared.mode);
      setDraft("");
      return false;
    }
    if (
      busy ||
      sending.current ||
      uploadingRef.current ||
      permissionsBusy ||
      modeBusy ||
      !model ||
      (selectedModel?.efforts?.length && !effort)
    )
      return false;
    setBusy(true);
    sending.current = true;
    let c, body, accepted = false;
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
          JSON.stringify(files.map((f) => f.id)) &&
        Boolean(prior.parsed) === planFeedback &&
        prior.provider === provider &&
        prior.model === model &&
        prior.permissions === permissions &&
        prior.mode === turnMode
          ? prior
          : {
              chatId: c.id,
              actionId: crypto.randomUUID(),
              text,
              attachments: files.map((f) => f.id),
              attachmentFiles: files,
              provider,
              model,
              effort: effort || null,
              permissions,
              mode: turnMode,
              ...(planFeedback && { parsed: true }),
            };
      savePending(c.id, body);
      const visible = prepared.text.trim();
      const showQueued =
        !!c.activeRun && prepared.delivery !== "steer";
      flushSync(() => {
        stageSend?.(c.id, body.actionId, {
          text: visible,
          attachments: files,
          queued: showQueued,
          runId:
            prepared.delivery === "steer" ? c.activeRun?.id ?? null : null,
        });
        if (!planFeedback) {
          setDraft("");
          setAttachments([]);
        }
      });
      const response = await api(`/api/chats/${c.id}/messages`, body);
      accepted = true;
      stageSend?.(c.id, body.actionId, {
        text: visible,
        attachments: files,
        queued: !!response.queued,
        runId: response.queued
          ? null
          : response.steered
            ? c.activeRun?.id ?? null
            : response.id ?? null,
      });
      savePending(c.id, null);
      await reload(c.id);
      await refresh();
      return true;
    } catch (e) {
      if (!accepted && body?.actionId) stageSend?.(c.id, body.actionId, null);
      if (!planFeedback) {
        if (!accepted) {
          setDraft(text);
          setAttachments(files);
        }
        report(e);
      }
      // A refused message stays in the composer but is no longer unconfirmed.
      if (body && e.status >= 400 && e.status < 500 && !e.unreachable)
        await api("/api/actions/" + encodeURIComponent(body.actionId))
          .then(({ run, input }) => {
            if (!run && !input) savePending(c.id, null);
          })
          .catch(() => {});
      if (planFeedback) throw e;
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  // Confirming, denying, or Other resumes the Goal with that answer.
  async function answerOwner(answer) {
    if (!chat || busy || sending.current || chat.activeRun) return;
    setBusy(true);
    sending.current = true;
    try {
      await api(`/api/chats/${chat.id}/owner-pause`, {
        actionId: crypto.randomUUID(),
        ...answer,
      });
      await reload(chat.id);
      await refresh();
    } catch (error) {
      report(error);
      throw error;
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  // Resuming reactivates the paused Goal with its saved objective, on the
  // agent that owns it. The composer's draft is left alone.
  async function resumeGoal(goal) {
    if (!chat || busy || sending.current || chat.activeRun) return;
    const sameAgent = goal.provider === provider;
    const agentModel = sameAgent
      ? model
      : (chat.runs?.find((r) => r.provider === goal.provider)?.model ??
        providers
          .find((p) => p.id === goal.provider)
          ?.models.find((m) => !m.disabled)?.id);
    if (!agentModel) {
      report(new Error(`Connect ${providerName(goal.provider)} to resume.`));
      return;
    }
    setBusy(true);
    sending.current = true;
    try {
      const body = prepareControlAction({ chatId: chat.id, provider: goal.provider,
        model: agentModel, effort: sameAgent ? effort || null : null, permissions, mode: "goal", resumeGoal: true });
      await api(`/api/chats/${chat.id}/messages`, body);
      savePending(chat.id, null);
      await reload(chat.id);
      await refresh();
    } catch (e) {
      if (e.status >= 400 && e.status < 500 && !e.unreachable) savePending(chat.id, null);
      report(e);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  // Picking a model sends the continuation. The draft stays put, and the
  // host writes the prompt for the new provider.
  async function continueAfterUsage(choice) {
    if (!chat || busy || sending.current || chat.activeRun || !choice?.model)
      return;
    setBusy(true);
    sending.current = true;
    try {
      const body = prepareControlAction({ chatId: chat.id, provider: choice.provider, model: choice.model,
        effort: choice.effort || null, permissions, mode: chat.mode ?? mode, continueAfterUsage: true });
      await api(`/api/chats/${chat.id}/messages`, body);
      savePending(chat.id, null);
      setProvider(choice.provider);
      setModel(choice.model);
      setEffort(choice.effort ?? "");
      await reload(chat.id);
      refresh().catch(report);
    } catch (e) {
      if (e.status >= 400 && e.status < 500 && !e.unreachable) savePending(chat.id, null);
      report(e);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function setUsageResume(armed) {
    if (!chat || resumeBusy || sending.current) return;
    setResumeBusy(true);
    try {
      await api(`/api/chats/${chat.id}`, { usageResume: armed }, "PATCH");
      await reload(chat.id);
      refresh().catch(report);
    } catch (error) {
      report(error);
    } finally {
      setResumeBusy(false);
    }
  }
  useImperativeHandle(ref, () => ({
    send,
    focus: () => input.current?.focus(),
  }));
  async function checkContinuationConnections() {
    if (checkingConnections) return;
    setCheckingConnections(true);
    try {
      const targets = (chat.mode === "goal" ? ["codex", "claude"] : ["codex", "claude", "cursor", "openrouter"])
        .filter((id) => id !== (chat.usage_stopped_provider ?? chat.provider));
      await Promise.all(targets.map((provider) => api("/api/providers/refresh", { provider })));
      await refresh();
    } catch (error) { report(error); }
    finally { setCheckingConnections(false); }
  }
  const act = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      report(e);
    }
  };
  async function stopWork() {
    if (stopping || !chat) return;
    const id = chat.id;
    setStopping("sending");
    try {
      await api(`/api/chats/${id}/cancel`, {});
      if (stopTarget.current === id) setStopping("waiting");
    } catch (error) {
      if (stopTarget.current === id) setStopping("");
      throw error;
    }
  }
  // Chat links open in a pane. File links open that document in the Files panel.
  const followLink = (e) => {
    const link = e.target.closest?.("a[href]");
    if (!link) return;
    const raw = link.getAttribute("href") ?? "";
    let url;
    try {
      url = new URL(link.href, window.location.origin);
    } catch {
      return;
    }
    if (raw.startsWith("/?chat=")) {
      const id = url.searchParams.get("chat");
      if (!id || id.includes(",")) return;
      e.preventDefault();
      onOpenChat(id, e.ctrlKey || e.metaKey, url.hash.slice(1));
      return;
    }
    if (!raw.startsWith("/?file=")) return;
    e.preventDefault();
    const line = Number(url.searchParams.get("line"));
    onOpenFile?.({
      file: url.searchParams.get("file") ?? "",
      line: Number.isInteger(line) && line > 0 ? line : null,
    });
  };
  const title = chat?.title ?? "New conversation",
    marker = chatMarker(chat);
  // Only the Goal the latest turn left unfinished. A live CI watch continues
  // a waiting Goal, and an older provider's pause is not a second prompt.
  const pausedGoals = resumeOffers(chat);
  const continuationOptions = {
    stoppedProvider: chat?.usage_stopped_provider ?? chat?.provider,
    mode: chat?.mode ?? mode,
  };
  const continuationChoices = continuationProviders(
    providers,
    continuationOptions,
  );
  const continuationTitle = continuationUnavailableTitle(
    providers,
    continuationOptions,
  );
  const stoppedProvider = providers.find(
    (item) => item.id === (chat?.usage_stopped_provider ?? chat?.provider),
  );
  const stoppedRun = chat?.runs?.find((run) => run.id === chat?.usage_stopped_run_id);
  const stoppedModelName =
    stoppedProvider?.models?.find((item) => item.id === stoppedRun?.model)?.name ??
    stoppedRun?.model;
  // The plan the latest finished run left open. Runs saved before run modes
  // were recorded still need the composer in Plan mode, as they did before.
  const openPlan = chat?.openPlan;
  const planReady =
    chat &&
    !chat.activeRun &&
    openPlan &&
    (openPlan.mode != null || mode === "plan") &&
    !keptPlans.has(openPlan.runId) &&
    !chat.approvals?.some((a) => a.request?.kind === "plan")
      ? {
          ...openPlan,
          provider: chat.runs?.find((r) => r.id === openPlan.runId)?.provider,
        }
      : null;
  // A review shows only on the plan it read. Older reviews did not record it.
  const reviewFor = (runId, plan) => {
    const review = chat?.planReviews?.[runId];
    return review && (review.plan == null || review.plan === plan)
      ? review
      : null;
  };
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
          {["approval", "owner", "running", "watching", "usage"].includes(marker) && (
            <span
              className={"chat-marker marker-" + marker}
              role="img"
              aria-label={chatMarkerLabel(marker, chat)}
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
            <p>Who's on this one?</p>
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
          <Conversation
            chat={chat}
            onOpenWork={onOpenWork}
            watchCards={(watches) => (
              <WatchCards
                chat={chat}
                watches={watches}
                reload={reload}
                refresh={refresh}
                report={report}
              />
            )}
          />
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
            {stopping || chat.activeRun.pause?.state === "requested" ? "Pausing… waiting for provider confirmation"
              : chat.activeRun.pause?.state === "confirmed" ? "Finishing pause…"
              : chat.activeRun.startup?.state === "starting" ? ({ initialize: "Initializing Codex…", "thread/resume": "Restoring Codex session…", "thread/start": "Starting Codex session…" }[chat.activeRun.startup.phase] ?? "Starting provider…")
              : workingLine(
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
            {chat.usage_stopped_reason}{" "}
            {chat.usage_resume_at ? (
              <>
                It will resume on {providerName(stoppedProvider?.id ?? chat.usage_stopped_provider)}
                {stoppedModelName ? ` · ${stoppedModelName}` : ""} when usage resets.{" "}
                <ResetWait at={usageResetAt(stoppedProvider)} />
              </>
            ) : (
              <>Come back after it resets, or continue with another agent.</>
            )}
            {chat.usage_resume_error ? <> {chat.usage_resume_error}</> : null}
            <div className="notice-actions">
              {chat.usage_resume_at ? (
                <button
                  type="button"
                  className="notice-action"
                  disabled={resumeBusy || busy}
                  onClick={() => setUsageResume(false)}
                >
                  {resumeBusy ? "Cancelling…" : "Cancel resume"}
                </button>
              ) : (
                <button
                  type="button"
                  className="notice-action"
                  disabled={resumeBusy || busy || modeBusy || permissionsBusy}
                  onClick={() => setUsageResume(true)}
                >
                  {resumeBusy ? "Saving…" : "Resume when usage resets"}
                </button>
              )}
              <button type="button" className="notice-action" disabled={checkingConnections} onClick={checkContinuationConnections}>
                {checkingConnections ? "Checking connections…" : "Check connections"}
              </button>
              {continuationChoices.length > 0 ? (
                <ModelPicker
                  className="notice-continue"
                  providers={continuationChoices}
                  provider={provider}
                  model={model}
                  effort={effort}
                  onChange={continueAfterUsage}
                  onOpenConnections={onOpenConnections}
                  renderTrigger={(props) => (
                    <button
                      {...props}
                      className="notice-action"
                      disabled={busy || modeBusy || permissionsBusy}
                    >
                      {busy ? "Starting continuation…" : "Continue with a new provider"}
                    </button>
                  )}
                />
              ) : (
                <button
                  type="button"
                  className="notice-action"
                  disabled
                  title={continuationTitle}
                >
                  Continue with a new provider
                </button>
              )}
              <button
                type="button"
                className="notice-dismiss"
                onClick={() => onDismissUsage?.()}
              >
                Dismiss
              </button>
            </div>
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
            {stopping || chat.pause?.state === "requested" ? "Reconnecting to verify the Goal pause…"
              : chat.pause?.state === "unconfirmed" ? chat.pause.text
              : "This Goal has not been confirmed stopped. Use Stop work to reconnect and verify the pause."}
          </div>
        )}
        {!chat?.activeRun &&
          ownerPauses(chat).map((goal) => (
            <OwnerPauseCard
              key={goal.provider}
              goal={goal}
              disabled={busy || modeBusy || permissionsBusy}
              onAnswer={(answer) => answerOwner(answer)}
            />
          ))}
        {!chat?.activeRun &&
          pausedGoals.map((goal) => (
            <div className="notice goal-paused" key={goal.provider}>
              <strong>
                {goal.status === "usageLimited"
                  ? "Goal stopped at a usage limit."
                  : goal.status === "waiting" ? "Goal waiting for CI." : "Goal paused."}
              </strong>{" "}
              {goal.objective && (
                <span className="goal-objective" title={goal.objective}>
                  {goal.objective}
                </span>
              )}{" "}
              Resume picks up where {providerName(goal.provider)} left off.
              <button
                type="button"
                className="notice-dismiss"
                disabled={busy || modeBusy || permissionsBusy}
                onClick={() => resumeGoal(goal)}
              >
                Resume goal
              </button>
            </div>
          ))}
        {/* Finished proposals use the same review and feedback flow as plans
            awaiting approval during a turn. */}
        {planReady && (
          <Approval
            key={planReady.runId}
            approval={{
              provider: planReady.provider ?? chat.provider ?? provider,
              request: {
                kind: "plan",
                title: "Happy with the plan?",
                plan: planReady.plan,
              },
            }}
            review={reviewFor(planReady.runId, planReady.plan)}
            onReview={() =>
              api(`/api/plans/${planReady.runId}/review`, { chatId: chat.id })
            }
            onAnswer={async (answer) => {
              if (!answer.allow) {
                const sent = await send(
                  planRevisionRequest(answer.reason),
                  "plan",
                  { planFeedback: true },
                );
                if (!sent)
                  throw new Error(
                    "Wait for the current action to finish and select an available model before sending feedback.",
                  );
                setKeptPlans((ids) => new Set(ids).add(planReady.runId));
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
            review={
              a.request?.kind === "plan" ? reviewFor(a.run_id, a.request.plan) : null
            }
            onReview={
              a.request?.kind === "plan"
                ? () =>
                    api(`/api/plans/${a.run_id}/review`, {
                      chatId: chat.id,
                      approvalId: a.id,
                    })
                : undefined
            }
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
                {!item.pending && (
                  <button
                    type="button"
                    className="text-button"
                    aria-label="Remove queued message"
                    onClick={act(() =>
                      api(
                        `/api/chats/${chat.id}/queue/${item.id}`,
                        {},
                        "DELETE",
                      ),
                    )}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {connected?.signIn ? (
          <div className="billing-notice">
            <span className="status-dot warning" />
            <span>{connected.blockReason}</span>
            <ClaudeSignIn
              request={connected.signIn}
              report={report}
              onProviders={() => refresh()}
            />
          </div>
        ) : (
          connected?.blockReason && (
            <button className="billing-notice" onClick={onOpenConnections}>
              <span className="status-dot warning" />
              {connected.blockReason}
              <span className="notice-more">View setup ↗</span>
            </button>
          )
        )}
        <form
          className={"composer" + (dragging ? " dragging" : "")}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            if (!busy && !uploading) setDragging(true);
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
            disabled={busy || uploading}
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
              chat?.activeRun
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
          />
          <div className="composer-controls">
            <button
              type="button"
              className="icon-button attach-button"
              aria-label="Attach files"
              title="Attach files or paste a screenshot · Up to 10 files, 20 MB each"
              disabled={
                busy || uploading || attachments.length >= 10
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
            {(chat?.activeRun || blockingGoals(chat).length > 0 || ownerPauses(chat).length > 0 || chat?.watches?.some((w) => w.armed)) && (
              <button
                type="button"
                className="send-button stopping"
                aria-label="Stop work"
                disabled={!!stopping || chat?.pause?.state === "requested" || chat?.activeRun?.pause?.state === "requested"}
                title={
                  mode === "goal"
                    ? "Pause the goal. You can resume it later."
                    : "Stop work"
                }
                onClick={act(stopWork)}
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
                !model ||
                !selectedModel ||
                selectedModel.disabled ||
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
                  disabled={id === "goal" && ["cursor", "openrouter"].includes(provider)}
                >
                  {label}
                </option>
              ))}
            </select>
          </label>
          <GoalProgress chat={chat} compact={compact || mobile} />
          {(compact || mobile) && peers.length > 0 && (
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
                aria-label="Workspace details"
                title="Other chats working in this workspace"
              >
                <Icon name="menu" size={15} />
              </summary>
              <div className="composer-details-popover">
                <p>
                  {workspacePeersLabel(peers)}:{" "}
                  {peers.map((c) => c.title).join(", ")}
                </p>
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
          {chat && <ContextBar chat={chat} provider={provider} model={model} compact={compact || mobile} />}
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
