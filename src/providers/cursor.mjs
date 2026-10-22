import { RpcProcess } from "../core/rpc.mjs";
import { cursorCommand } from "../core/executables.mjs";
import { subscriptionEnvironment } from "../security/environment.mjs";
import { checkAccountConfirmation } from "../security/billing.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { cursorPrompt } from "./attachments.mjs";
import { historyTools } from "../core/history.mjs";
import { isBrowserTool } from "../core/browser.mjs";
import { modeSuggestionTool } from "../core/modes.mjs";
const exec = promisify(execFile);

// Harness's history and browser tools need no prompt of Cursor's, as with
// Claude: Harness itself asks the user before any browser action that can
// change a page. Landing changes and other tools still ask.
const historyNames = new Set(historyTools.map((t) => t.name));
// Cursor's ACP mode ids. Ask and Plan are its own read-only modes; Agent edits.
export function cursorModeId(mode) {
  return mode === "ask" || mode === "plan" ? mode : "agent";
}
// In Ask mode, Harness's own read-only tools may proceed. Any other permission
// is a change, and Ask mode declines it without asking.
export function cursorAskRejection(mode, toolCall, tools, options = []) {
  if (mode !== "ask" || isHarnessTool(toolCall, tools)) return null;
  const reject = options.find((option) => option.kind === "reject_once");
  return reject
    ? { outcome: "selected", optionId: reject.optionId }
    : { outcome: "cancelled" };
}
export function isHarnessTool(toolCall, tools = []) {
  const name = /^harness-history-(\w+): (\w+)$/.exec(toolCall?.title ?? "");
  return (
    toolCall?.kind === "other" &&
    !!name &&
    name[1] === name[2] &&
    (historyNames.has(name[1]) ||
      name[1] === modeSuggestionTool.name ||
      isBrowserTool(name[1])) &&
    tools.some((t) => t.name === name[1])
  );
}

export async function cursorAuth() {
  const c = cursorCommand();
  if (!c.command) throw new Error("Cursor CLI is not installed");
  const { stdout } = await exec(
    c.command,
    [...c.args, "status", "--format", "json"],
    { env: subscriptionEnvironment(), windowsHide: true, timeout: 20000 },
  );
  const auth = JSON.parse(stdout);
  return {
    connected: auth.isAuthenticated === true,
    fingerprint: createHash("sha256")
      .update(JSON.stringify([auth.userInfo?.userId, auth.userInfo?.email]))
      .digest("hex"),
  };
}
export function cursorClientCapabilities() {
  return {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    session: { configOptions: { boolean: {} } },
    // Without this Cursor-specific capability, ACP collapses each model to one
    // default variant. Composer and Grok then arrive only as Fast presets.
    _meta: { parameterizedModelPicker: true },
  };
}
export async function openCursor(cwd) {
  const c = cursorCommand();
  if (!c.command) throw new Error("Cursor CLI is not installed");
  const rpc = new RpcProcess(c.command, [...c.args, "acp"], {
    cwd,
    env: subscriptionEnvironment(),
  });
  try {
    const init = await rpc.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: cursorClientCapabilities(),
      clientInfo: { name: "agentic-harness", version: "0.1.0" },
    });
    if (!init.authMethods?.some((m) => m.id === "cursor_login"))
      throw new Error(
        "Cursor does not advertise its native subscription login",
      );
    rpc.promptCapabilities = init.agentCapabilities?.promptCapabilities ?? {};
    await rpc.call("authenticate", { methodId: "cursor_login" });
    return rpc;
  } catch (error) {
    rpc.close();
    throw error;
  }
}
// Cursor lists a model's effort levels only once a session has selected it,
// and a session starts on the last model used, so Harness keeps what it sees.
// The first level seen stays the default: Cursor's current value is whatever
// was chosen last, here or in another client.
export function learnCursorEfforts(known, configOptions) {
  const model = configOptions?.find((o) => o.id === "model")?.currentValue,
    option = configOptions?.find((o) => o.id === "reasoning_effort");
  if (!model) return known;
  const efforts = option?.options?.map((o) => o.value) ?? [],
    previous = known[model];
  if (previous && previous.efforts.join() === efforts.join()) return known;
  return {
    ...known,
    [model]: {
      efforts,
      defaultEffort: efforts.includes(previous?.defaultEffort)
        ? previous.defaultEffort
        : efforts.includes(option?.currentValue)
          ? option.currentValue
          : null,
    },
  };
}
export function cursorModels(session, known = {}) {
  const advertised = session.models?.availableModels ?? [];
  const fromConfig =
    session.configOptions?.find((option) => option.id === "model")?.options ??
    [];
  const source = advertised.length
    ? advertised.map((model) => ({ id: model.modelId, name: model.name }))
    : fromConfig.map((option) => ({ id: option.value, name: option.name }));
  return source
    .filter((model) => !model.id.startsWith("default"))
    .map((model) => {
      const fastOnly = /fast=true/.test(model.id);
      return {
        id: model.id,
        name: model.name,
        description: model.id,
        efforts: known[model.id]?.efforts ?? [],
        defaultEffort: known[model.id]?.defaultEffort ?? null,
        isDefault: false,
        billing: fastOnly
          ? "Unavailable: ACP only exposes this fast preset"
          : "Included budget · standard speed · on-demand must be disabled",
        disabled: fastOnly,
        nativeSubagents: true,
      };
    });
}
export function cursorSpeedFollowUp(configOptions) {
  const fast = configOptions?.find((option) => option.id === "fast");
  if (!fast || fast.currentValue === "false") return null;
  if (!fast.options?.some((option) => option.value === "false"))
    return { error: "Cursor only offers a fast preset for this model" };
  return { configId: "fast", value: "false" };
}
export function cursorConfigDrift(configOptions, requestedId) {
  const chosen = configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  )?.currentValue;
  if (chosen && chosen !== requestedId) return "model";
  if (
    configOptions?.find((option) => option.id === "fast")?.currentValue ===
    "true"
  )
    return "fast";
  return null;
}
// A new or loaded session usually already has the requested model at standard
// speed, which saves two round trips to Cursor before the turn.
export async function configureCursorModel(rpc, sessionId, modelId, current) {
  if (
    current?.find((option) => option.id === "model")?.currentValue ===
      modelId &&
    !cursorSpeedFollowUp(current)
  )
    return { configOptions: current };
  let configured = await rpc.call("session/set_config_option", {
    sessionId,
    configId: "model",
    value: modelId,
  });
  if (
    configured.configOptions?.find((option) => option.id === "model")
      ?.currentValue !== modelId
  )
    throw new Error("Cursor did not confirm the requested model");
  const followUp = cursorSpeedFollowUp(configured.configOptions);
  if (followUp?.error) throw new Error(followUp.error);
  if (followUp) {
    configured = await rpc.call("session/set_config_option", {
      sessionId,
      configId: followUp.configId,
      value: followUp.value,
    });
    if (
      configured.configOptions?.find((option) => option.id === "model")
        ?.currentValue !== modelId ||
      configured.configOptions?.find((option) => option.id === "fast")
        ?.currentValue !== "false"
    )
      throw new Error("Cursor did not confirm standard speed");
  }
  return configured;
}
export async function configureCursorEffort(
  rpc,
  sessionId,
  configOptions,
  effort,
) {
  const option = configOptions?.find((o) => o.id === "reasoning_effort");
  if (!effort || !option || option.currentValue === effort) return;
  if (!option.options?.some((o) => o.value === effort))
    throw new Error("Cursor does not offer that effort for this model");
  const configured = await rpc.call("session/set_config_option", {
    sessionId,
    configId: "reasoning_effort",
    value: effort,
  });
  if (
    configured.configOptions?.find((o) => o.id === "reasoning_effort")
      ?.currentValue !== effort ||
    cursorConfigDrift(
      configured.configOptions,
      configOptions.find((o) => o.id === "model")?.currentValue,
    )
  )
    throw new Error("Cursor did not confirm the requested effort");
}
export function cursorWorkKind(update, nativeTasks) {
  if (
    update.rawInput?._toolName === "task" ||
    update.title?.startsWith("Task:")
  )
    nativeTasks.add(update.toolCallId);
  return nativeTasks.has(update.toolCallId)
    ? "native-subagent"
    : update.sessionUpdate;
}
// ACP streams every text chunk of a turn alike. A tool call ends one message,
// as it does in Cursor, so the prose either side of it is not run together.
export function cursorMessageIds() {
  let count = 0,
    open = false;
  return (update) => {
    if (update.sessionUpdate === "tool_call") open = false;
    if (
      update.sessionUpdate !== "agent_message_chunk" ||
      update.content?.type !== "text"
    )
      return null;
    if (!open) count++;
    open = true;
    return `cursor-response-${count}`;
  };
}
export async function inspectCursor(cwd, confirmation, learn = () => ({})) {
  const auth = await cursorAuth();
  if (!auth.connected)
    return {
      id: "cursor",
      name: "Cursor",
      route: "Cursor subscription",
      connected: false,
      models: [],
      blockReason: "Sign in with Cursor CLI browser login.",
    };
  const rpc = await openCursor(cwd);
  try {
    const session = await rpc.call("session/new", { cwd, mcpServers: [] });
    return {
      id: "cursor",
      name: "Cursor",
      route: "Cursor subscription",
      connected: true,
      plan: "Account plan unavailable through ACP",
      fingerprint: auth.fingerprint,
      blockReason: checkAccountConfirmation(confirmation, auth.fingerprint),
      usage: {
        source: "No authoritative quota meter exposed through ACP",
        authoritative: false,
        windows: [],
      },
      models: cursorModels(session, learn(session.configOptions)),
      capabilities: {
        nativeResume: true,
        nativeSubagents: true,
        effort: true,
        usage: false,
        historyTools: true,
      },
      note: "Auto is omitted. Models that offer Fast are pinned to standard speed, and a turn stops if Fast turns back on. A model's effort levels appear once Harness has used it in a Cursor session.",
    };
  } finally {
    rpc.close();
  }
}
// Cursor's ACP bridge forwards selected IDs but drops freeformText. Its skipped
// reason does reach the native tool, so carry custom answers there verbatim.
export function cursorQuestionOutcome(questions, answer) {
  if (!answer.allow) return { outcome: "cancelled" };
  let custom = false;
  const answers = questions.map((q) => {
    const raw = answer.answers?.[q.id],
      values = (Array.isArray(raw) ? raw : [raw]).filter(
        (value) => typeof value === "string" && value.trim(),
      ),
      options = q.options ?? [],
      selectedOptionIds = [],
      text = values.map((value) => {
        const option = options.find((o) => o.id === value || o.label === value);
        if (option) {
          selectedOptionIds.push(option.id);
          return option.label;
        }
        custom = true;
        return value;
      });
    return { questionId: q.id, selectedOptionIds, text };
  });
  if (!answers.length || answers.some((a) => !a.text.length))
    return { outcome: "cancelled" };
  if (custom)
    return {
      outcome: "skipped",
      reason:
        "The user supplied these answers, including an Other response. Use them to continue:\n" +
        questions
          .map((q, i) => `${q.prompt ?? q.id}: ${answers[i].text.join(", ")}`)
          .join("\n"),
    };
  return {
    outcome: "answered",
    answers: answers.map(({ text, ...selection }) => selection),
  };
}

export async function runCursor(ctx) {
  // Starting Cursor while its status is checked saves a second; nothing is
  // sent to a session until the account is confirmed.
  const [status, opened] = await Promise.allSettled([
    cursorAuth(),
    openCursor(ctx.project.path),
  ]);
  const reason =
    status.status === "fulfilled" &&
    (checkAccountConfirmation(
      ctx.billingConfirmation,
      status.value.fingerprint,
    ) ??
      (status.value.connected ? null : "Cursor is signed out"));
  if (status.status === "rejected" || reason) {
    if (opened.status === "fulfilled") opened.value.close();
    throw status.status === "rejected" ? status.reason : new Error(reason);
  }
  if (opened.status === "rejected") throw opened.reason;
  const rpc = opened.value,
    messageId = cursorMessageIds();
  let sessionId,
    live = false,
    accepting = false,
    killTimer;
  const pending = [];
  const nativeTasks = new Set();
  const cancel = () => {
    if (sessionId && !rpc.closed) {
      rpc.notify("session/cancel", { sessionId });
      killTimer ??= setTimeout(() => rpc.close(), 8000);
    } else rpc.close();
  };
  ctx.signal.addEventListener("abort", cancel, { once: true });
  rpc.on("request", async (m) => {
    try {
      if (m.method === "session/request_permission") {
        const rejection = cursorAskRejection(
          ctx.mode,
          m.params.toolCall,
          ctx.tools,
          m.params.options,
        );
        if (rejection) {
          if (!rpc.closed) rpc.respond(m.id, { outcome: rejection });
          return;
        }
        const allowOnce = m.params.options.find((o) => o.kind === "allow_once");
        if (allowOnce && isHarnessTool(m.params.toolCall, ctx.tools)) {
          if (!rpc.closed)
            rpc.respond(m.id, {
              outcome: { outcome: "selected", optionId: allowOnce.optionId },
            });
          return;
        }
        const answer = await ctx.approve({
          kind: "permission",
          method: m.method,
          title: m.params.toolCall?.title ?? "Cursor tool request",
          details: m.params.toolCall,
          options: m.params.options,
        });
        const option = m.params.options.find(
          (o) => o.kind === (answer.allow ? "allow_once" : "reject_once"),
        );
        if (!rpc.closed)
          rpc.respond(m.id, {
            outcome: option
              ? { outcome: "selected", optionId: option.optionId }
              : { outcome: "cancelled" },
          });
      } else if (m.method === "cursor/ask_question") {
        const questions = m.params.questions ?? [];
        const answer = await ctx.approve({
          kind: "question",
          title: m.params.title ?? "Cursor needs your input",
          questions: questions.map((q) => ({
            id: q.id,
            question: q.prompt,
            options: q.options,
            selectionOnly: true,
            multiple: q.allowMultiple === true,
          })),
          details: m.params,
        });
        if (!rpc.closed)
          rpc.respond(m.id, {
            outcome: cursorQuestionOutcome(questions, answer),
          });
      } else if (m.method === "cursor/create_plan") {
        // Ask mode answers questions. It does not become plan mode.
        if (ctx.mode === "ask") {
          if (!rpc.closed)
            rpc.respond(m.id, {
              outcome: {
                outcome: "rejected",
                reason:
                  "Ask mode is read-only. It answers questions and does not create a plan.",
              },
            });
          return;
        }
        // In plan mode the plan is the user's to accept, as it is in Cursor.
        const answer = await ctx.approve({
          kind: ctx.mode === "plan" ? "plan" : "permission",
          method: m.method,
          title: m.params.name ?? "Review Cursor plan",
          plan: m.params.plan ?? m.params.overview,
          details: m.params,
        });
        if (!rpc.closed)
          rpc.respond(m.id, {
            outcome: answer.allow
              ? { outcome: "accepted" }
              : {
                  outcome: "rejected",
                  reason: answer.reason ?? "The user declined this plan.",
                },
          });
      } else rpc.reject(m.id);
    } catch (error) {
      if (!rpc.closed) rpc.reject(m.id, error.message);
    }
  });
  rpc.on("notification", ({ method, params: p }) => {
    if (!live) return;
    const update = p?.update;
    if (method === "session/update" && update) {
      const nativeId = messageId(update);
      if (nativeId) ctx.emit("text", { nativeId, delta: update.content.text });
      if (
        ["tool_call", "tool_call_update", "plan", "usage_update"].includes(
          update.sessionUpdate,
        )
      )
        ctx.emit("work", {
          kind: cursorWorkKind(update, nativeTasks),
          provider: "cursor",
          item: update,
        });
      if (update.sessionUpdate === "config_option_update") {
        const drift = cursorConfigDrift(update.configOptions, ctx.model);
        if (drift) {
          ctx.emit("work", {
            kind: "model-change",
            model:
              update.configOptions?.find((c) => c.id === "model")
                ?.currentValue ?? ctx.model,
            reason:
              drift === "fast"
                ? "Provider turned Fast on; stopped for review."
                : "Provider changed the selected model; stopped for review.",
          });
          cancel();
        }
      }
    }
    if (method === "cursor/task")
      ctx.emit("work", {
        kind: "native-subagent",
        provider: "cursor",
        item: p,
      });
    if (method === "cursor/update_todos")
      ctx.emit("work", { kind: "plan", provider: "cursor", item: p });
  });
  try {
    const setup = { cwd: ctx.project.path, mcpServers: ctx.mcpServers ?? [] };
    const session = ctx.session?.id
      ? await rpc.call("session/load", { ...setup, sessionId: ctx.session.id })
      : await rpc.call("session/new", setup);
    sessionId = ctx.session?.id ?? session.sessionId;
    ctx.saveSession({ id: sessionId });
    const model = cursorModels(session).find((m) => m.id === ctx.model);
    if (!model || model.disabled)
      throw new Error(
        "Choose an available standard Cursor preset from the live ACP catalog",
      );
    const configured = await configureCursorModel(
      rpc,
      sessionId,
      ctx.model,
      session.configOptions,
    );
    const known = ctx.learnEfforts?.(configured.configOptions) ?? {};
    await configureCursorEffort(
      rpc,
      sessionId,
      configured.configOptions,
      ctx.effort ?? known[ctx.model]?.defaultEffort,
    );
    // A saved session keeps its last mode until this call. Ask and Plan are
    // Cursor's own read-only modes; Agent is the one that edits.
    await rpc.call("session/set_mode", {
      sessionId,
      modeId: cursorModeId(ctx.mode),
    });
    if (ctx.signal.aborted)
      throw new Error("Cancelled before the turn started");
    live = true;
    accepting = true;
    const timeout = 24 * 60 * 60 * 1000;
    ctx.attachSteer?.((item) => {
      if (!accepting) throw new Error("Cursor's turn has ended");
      pending.push(item);
      // session/prompt blocks until the turn ends, so cancel it and send
      // the steer as the next prompt on this same session.
      if (sessionId && !rpc.closed) rpc.notify("session/cancel", { sessionId });
    });
    const first = rpc.call(
      "session/prompt",
      { sessionId, prompt: await cursorPrompt(ctx, rpc.promptCapabilities) },
      timeout,
    );
    if (pending.length && !ctx.signal.aborted)
      rpc.notify("session/cancel", { sessionId });
    let result = await first;
    while (pending.length && !ctx.signal.aborted) {
      const item = pending.shift();
      if (item.mode)
        await rpc.call("session/set_mode", {
          sessionId,
          modeId: cursorModeId(item.mode),
        });
      result = await rpc.call(
        "session/prompt",
        {
          sessionId,
          prompt: await cursorPrompt(
            { ...ctx, text: item.text, handoff: "", instructions: "" },
            rpc.promptCapabilities,
          ),
        },
        timeout,
      );
    }
    return {
      status:
        ctx.signal.aborted || result.stopReason === "cancelled"
          ? "cancelled"
          : result.stopReason === "end_turn"
            ? "completed"
            : "failed",
      error: result.stopReason === "end_turn" ? null : result.stopReason,
    };
  } finally {
    accepting = false;
    clearTimeout(killTimer);
    ctx.signal.removeEventListener("abort", cancel);
    rpc.close();
  }
}
