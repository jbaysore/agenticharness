import { RpcProcess } from "../core/rpc.mjs";
import { cursorCommand } from "../core/executables.mjs";
import { subscriptionEnvironment } from "../security/environment.mjs";
import { checkAccountConfirmation } from "../security/billing.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const exec = promisify(execFile);

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
    await rpc.call("authenticate", { methodId: "cursor_login" });
    return rpc;
  } catch (error) {
    rpc.close();
    throw error;
  }
}
export function cursorModels(session) {
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
        efforts: [],
        defaultEffort: null,
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
export async function configureCursorModel(rpc, sessionId, modelId) {
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
export async function inspectCursor(cwd, confirmation) {
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
      models: cursorModels(session),
      capabilities: {
        nativeResume: true,
        nativeSubagents: true,
        effort: false,
        usage: false,
        historyTools: true,
      },
      note: "Auto is omitted. Models that offer Fast are pinned to standard speed, and a turn stops if Fast turns back on. Effort stays at the provider default.",
    };
  } finally {
    rpc.close();
  }
}
export async function runCursor(ctx) {
  const auth = await cursorAuth(),
    reason = checkAccountConfirmation(
      ctx.billingConfirmation,
      auth.fingerprint,
    );
  if (!auth.connected || reason)
    throw new Error(reason ?? "Cursor is signed out");
  const rpc = await openCursor(ctx.project.path);
  let sessionId,
    live = false,
    nativeId = "cursor-response",
    killTimer;
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
        const answer = await ctx.approve({
          kind: "permission",
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
        const answers = questions.map((q) => {
          const raw = answer.answers?.[q.id],
            values = Array.isArray(raw) ? raw : [raw];
          return {
            questionId: q.id,
            selectedOptionIds: q.options
              .filter((o) => values.includes(o.id) || values.includes(o.label))
              .map((o) => o.id),
          };
        });
        if (!rpc.closed)
          rpc.respond(m.id, {
            outcome:
              answer.allow && answers.every((a) => a.selectedOptionIds.length)
                ? { outcome: "answered", answers }
                : { outcome: "cancelled" },
          });
      } else if (m.method === "cursor/create_plan") {
        const answer = await ctx.approve({
          kind: "permission",
          title: m.params.name ?? "Review Cursor plan",
          details: m.params,
        });
        if (!rpc.closed)
          rpc.respond(m.id, {
            outcome: answer.allow
              ? { outcome: "accepted" }
              : { outcome: "rejected", reason: "The user declined this plan." },
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
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text"
      )
        ctx.emit("text", { nativeId, delta: update.content.text });
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
    await configureCursorModel(rpc, sessionId, ctx.model);
    if (ctx.signal.aborted)
      throw new Error("Cancelled before the turn started");
    live = true;
    const prompt = [ctx.instructions, ctx.handoff, ctx.text]
      .filter(Boolean)
      .join("\n\n");
    const result = await rpc.call(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text: prompt }] },
      24 * 60 * 60 * 1000,
    );
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
    clearTimeout(killTimer);
    ctx.signal.removeEventListener("abort", cancel);
    rpc.close();
  }
}
