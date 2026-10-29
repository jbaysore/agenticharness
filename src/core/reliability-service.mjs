import { workspaceFingerprint } from "./repository.mjs";
import {
  commandEvidence,
  ISSUE_CATEGORIES,
  reliabilityProjection,
} from "./reliability.mjs";

export class Reliability {
  constructor(controller) {
    this.controller = controller;
    this.store = controller.store;
    this.current = new Map();
    this.pending = new Map();
    this.versions = new Map();
    this.fingerprint = workspaceFingerprint;
  }
  root(chat) {
    return chat.worktree?.path ?? this.store.project(chat.project_id)?.path;
  }
  async refresh(id) {
    const chat = this.store.conversation(id);
    if (!chat) throw new Error("Conversation not found");
    const root = this.root(chat);
    if (!root) return null;
    const version = this.versions.get(root) ?? 0;
    const existing = this.pending.get(root);
    if (existing) {
      await existing.promise;
      return existing.version === (this.versions.get(root) ?? 0)
        ? this.current.get(root)
        : this.refresh(id);
    }
    const pending = this.fingerprint(root)
      .then((value) => {
        if (version === (this.versions.get(root) ?? 0))
          this.current.set(root, value);
        return value;
      })
      .finally(() => this.pending.delete(root));
    this.pending.set(root, { promise: pending, version });
    return pending;
  }
  observe(event) {
    const chat =
      event.conversationId && this.store.conversation(event.conversationId);
    if (!chat) return;
    const invalidate = () => {
      const root = this.root(chat);
      this.current.delete(root);
      this.versions.set(root, (this.versions.get(root) ?? 0) + 1);
    };
    if (
      event.type === "work" &&
      (event.payload.kind === "host-command" ||
        event.payload.item?.type === "fileChange" ||
        ["Write", "Edit", "MultiEdit"].includes(event.payload.item?.name) ||
        ["edit", "delete", "move"].includes(event.payload.item?.kind))
    )
      invalidate();
    if (
      event.type === "run" &&
      ["starting", "running"].includes(event.payload.status)
    )
      invalidate();
    if (
      event.type === "run" &&
      ["completed", "failed", "cancelled", "interrupted"].includes(
        event.payload.status,
      )
    ) {
      invalidate();
      const data = this.store.reliabilityData(chat.id);
      if (commandEvidence(data.events).some((c) => c.workspaceAfter?.hash))
        void this.refresh(chat.id)
          .then(() =>
            this.controller.event(chat.id, null, "reliability-update", {}),
          )
          .catch(() => {});
    }
  }
  async read(id, { provider, model, refresh = false } = {}) {
    let data = this.store.reliabilityData(id);
    if (
      refresh &&
      commandEvidence(data.events).some((c) => c.workspaceAfter?.hash)
    )
      await this.refresh(id);
    data = this.store.reliabilityData(id);
    return {
      ...reliabilityProjection({
        ...data,
        workspace: this.current.get(this.root(data.chat)) ?? null,
        provider,
        model,
      }),
      lastEventId: data.lastEventId,
    };
  }
  async action(id, input) {
    if (
      !input ||
      typeof input.actionId !== "string" ||
      input.actionId.length < 8 ||
      input.actionId.length > 100
    )
      throw new Error("Provide an action ID");
    const { chat, events, actions } = this.store.reliabilityData(id);
    const previous = actions.find((a) => a.actionId === input.actionId);
    if (previous) {
      const fields =
        previous.kind === "report"
          ? ["kind", "category", "messageId", "eventId"]
          : ["kind", "targetId"];
      if (
        fields.some((key) => previous[key] !== input[key]) ||
        (previous.kind === "report" &&
          previous.note !==
            String(input.note ?? "")
              .trim()
              .slice(0, 2000))
      )
        throw new Error("Action ID was already used for a different action");
      return { recorded: true };
    }
    const action = { actionId: input.actionId, kind: input.kind };
    if (input.kind === "report") {
      if (!ISSUE_CATEGORIES.includes(input.category))
        throw new Error("Choose an issue category");
      action.category = input.category;
      action.note = String(input.note ?? "")
        .trim()
        .slice(0, 2000);
      if (input.messageId) {
        if (
          !this.store.db
            .prepare("SELECT id FROM messages WHERE id=? AND conversation_id=?")
            .get(input.messageId, id)
        )
          throw new Error("Message is outside this conversation");
        action.messageId = input.messageId;
      } else {
        const source = this.store.db
          .prepare(
            "SELECT id FROM events WHERE id=? AND conversation_id=? AND type='work'",
          )
          .get(input.eventId, id);
        if (!source)
          throw new Error("Work evidence is outside this conversation");
        action.eventId = source.id;
      }
    } else if (input.kind === "track") {
      const source = commandEvidence(events).find(
        (c) => c.id === input.targetId,
      );
      if (!source) throw new Error("Completed command evidence is unavailable");
      action.targetId = source.id;
      action.evidence = source;
    } else if (input.kind === "resolve") {
      if (
        !actions.some(
          (a) => a.kind === "report" && a.actionId === input.targetId,
        )
      )
        throw new Error("Issue is outside this conversation");
      action.targetId = input.targetId;
    } else if (["dismiss", "acknowledge"].includes(input.kind)) {
      const projection = reliabilityProjection({
        chat,
        events,
        actions,
        workspace: this.current.get(this.root(chat)),
      });
      // Notices for another saved model session can be inspected explicitly.
      const all = [...projection.notices, ...projection.noticeHistory];
      const transition = events.find(
        (e) =>
          e.type === "reliability-transition" &&
          e.payload.key === input.targetId,
      );
      const recordedCheck = projection.checks.some(
        (c) => "check:" + c.id === input.targetId,
      );
      if (
        !all.some((n) => n.id === input.targetId) &&
        !transition &&
        !recordedCheck
      )
        throw new Error("Notice is outside this conversation");
      if (input.kind === "acknowledge" && !transition)
        throw new Error("Only continuity notices can be marked reviewed");
      action.targetId = input.targetId;
    } else throw new Error("Unknown reliability action");
    if (this.store.saveReliabilityAction(id, action))
      this.controller.event(id, null, "reliability-update", {
        actionId: action.actionId,
      });
    return { recorded: true };
  }
  evidence(id, eventId) {
    const event = this.store.db
      .prepare("SELECT * FROM events WHERE conversation_id=? AND id=?")
      .get(id, eventId);
    if (!event) throw new Error("Evidence is outside this conversation");
    const payload = JSON.parse(event.payload);
    const output =
      payload.kind === "host-command"
        ? this.store.db
            .prepare(
              "SELECT payload FROM events WHERE conversation_id=? AND run_id=? AND type='work' AND json_extract(payload,'$.kind')='command-output' AND json_extract(payload,'$.itemId')=? ORDER BY id LIMIT 100",
            )
            .all(id, event.run_id, payload.id)
            .map((e) => JSON.parse(e.payload).delta)
            .join("")
        : "";
    const text =
      JSON.stringify(payload, null, 2) +
      (output ? "\n\nRecorded output:\n" + output : "");
    return {
      id: event.id,
      createdAt: event.created_at,
      text: text.slice(0, 20000),
      truncated: text.length > 20000,
    };
  }
}
