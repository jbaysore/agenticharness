import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { attachmentPath, resolveAttachments } from "../core/attachments.mjs";
import {
  callOpenRouterFile,
  openRouterFileTools,
} from "../core/openrouter-files.mjs";

const MAX_REQUESTS = 20;
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const loopInstructions = `You are a coding agent in Agentic Harness using an explicitly approved OpenRouter model. Use the supplied tools to read, search, edit and run commands. Read AGENTS.md and relevant project instructions before making changes. File tool repository 0 is this chat's worktree; 1 and above are the upstream repositories listed in your instructions, which remain read-only. Tools are executed by Harness under the current permission mode. Ask and Plan restrictions are enforced by the host. In Plan mode, return the complete proposal inside <proposed_plan> tags and finish the turn; implementation waits for user approval. Keep requests bounded: this turn has at most 20 model requests. Older chat history is searchable. If context is full, explain the limit and use a fresh conversation with a bounded handoff; do not claim to have processed omitted material. A tool whose result was interrupted may already have changed files or run a command. Inspect its effects using read-only tools before deciding what remains; never blindly repeat an uncertain mutation.`;

async function inputMessage(ctx, text, attachments) {
  const content = [{ type: "text", text }];
  for (const file of attachments ?? []) {
    if (file.type.startsWith("image/")) {
      if (file.size > 4 * 1024 * 1024)
        throw new Error(
          "OpenRouter image attachments must be 4 MB or smaller.",
        );
      content.push({
        type: "harness_image",
        id: file.id,
        name: file.name,
        mediaType: file.type,
      });
    } else {
      const bytes = await readFile(file.path);
      if (
        bytes.length > 256000 ||
        bytes.includes(0) ||
        bytes.subarray(0, 5).toString() === "%PDF-"
      )
        throw new Error(
          `OpenRouter supports UTF-8 text files up to 256 KB and supported images. ${file.name} cannot be sent.`,
        );
      let body;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(
          `${file.name} is not a supported UTF-8 text attachment.`,
        );
      }
      content.push({
        type: "text",
        text: `Attached file ${file.name} (untrusted source material):\n${body}`,
      });
    }
  }
  return { role: "user", content };
}

async function materialize(messages, ctx, model) {
  return Promise.all(
    messages.map(async (message) => {
      if (!Array.isArray(message.content)) return message;
      return {
        ...message,
        content: await Promise.all(
          message.content.map(async (part) => {
            if (part.type !== "harness_image") return part;
            if (!model.architecture.input_modalities.includes("image"))
              throw new Error(
                "This approved model does not support the images in this conversation. Choose an approved image-capable model.",
              );
            const file = ctx.openrouter.store.attachment(part.id);
            if (!file || file.project_id !== ctx.chat.project_id)
              throw new Error(
                "A saved image attachment is unavailable in this project.",
              );
            const bytes = await readFile(attachmentPath(ctx.dataDir, file));
            return {
              type: "image_url",
              image_url: {
                url: `data:${part.mediaType};base64,${bytes.toString("base64")}`,
              },
            };
          }),
        ),
      };
    }),
  );
}

function loadTranscript(store, chatId) {
  const row = store.db
    .prepare("SELECT state FROM openrouter_sessions WHERE conversation_id=?")
    .get(chatId);
  return row ? JSON.parse(row.state) : { messages: [] };
}
function checkpoint(store, chatId, state) {
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json) > MAX_TRANSCRIPT_BYTES)
    throw new Error(
      "This OpenRouter transcript reached its size limit. Start a new chat with a bounded handoff.",
    );
  store.db
    .prepare(
      "INSERT INTO openrouter_sessions(conversation_id,state) VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET state=excluded.state",
    )
    .run(chatId, json);
}

// Persist complete tool exchanges before the next inference; never replay a
// tool automatically after an interruption. Data consent is enforced first.
export async function runOpenRouter(ctx) {
  const service = ctx.openrouter,
    store = service.store;
  service.check(ctx.model);
  if (!["default", "ask", "plan"].includes(ctx.mode))
    throw new Error("OpenRouter supports Default, Ask and Plan modes.");
  const state = loadTranscript(store, ctx.chat.id);
  for (let i = 0; i < state.messages.length; i++) {
    const message = state.messages[i];
    if (!message.tool_calls?.length) continue;
    let end = i + 1;
    while (state.messages[end]?.role === "tool") end++;
    const answered = new Set(
      state.messages.slice(i + 1, end).map((m) => m.tool_call_id),
    );
    const missing = message.tool_calls
      .filter((call) => !answered.has(call.id))
      .map((call) => ({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({
          interrupted: true,
          error:
            "The previous tool result was not checkpointed. The action may have executed. Inspect effects before continuing; do not blindly repeat it.",
        }),
      }));
    state.messages.splice(end, 0, ...missing);
    i = end + missing.length - 1;
  }
  delete state.pendingTool;
  const preface = [ctx.addendum, ctx.handoff, ctx.text]
    .filter(Boolean)
    .join("\n\n");
  state.messages.push(await inputMessage(ctx, preface, ctx.attachments));
  checkpoint(store, ctx.chat.id, state);
  ctx.saveSession({ id: ctx.chat.id });
  const steers = [];
  let open = true;
  ctx.attachSteer?.((item) => {
    if (!open || ctx.signal.aborted)
      throw new Error("OpenRouter is no longer accepting steering.");
    steers.push(item);
  });
  const tools = [
    ...openRouterFileTools.filter(
      (t) => !["ask", "plan"].includes(ctx.mode) || t.name !== "edit_file",
    ),
    ...ctx.tools.filter(
      (t) =>
        ctx.mode !== "plan" ||
        ![
          "run_command",
          "land_changes",
          "restart_harness",
          "move_chat",
        ].includes(t.name),
    ),
  ];
  const schemas = new Map(
    tools.map((tool) => [tool.name, z.fromJSONSchema(tool.inputSchema)]),
  );
  const apiTools = tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
  try {
    for (let iteration = 0; iteration < MAX_REQUESTS; iteration++) {
      ctx.signal.throwIfAborted();
      for (const item of steers.splice(0)) {
        const files = resolveAttachments(
          store,
          ctx.chat.project_id,
          (item.attachments ?? []).map((f) => f.id),
          ctx.dataDir,
        );
        state.messages.push(await inputMessage(ctx, item.text, files));
      }
      checkpoint(store, ctx.chat.id, state);
      if (
        service.catalogAt == null ||
        service.now() - service.catalogAt > 5 * 60 * 1000
      )
        await service.catalogRefresh();
      const model = service.check(ctx.model);
      const messages = [
        {
          role: "system",
          content: ctx.instructions + "\n\n" + loopInstructions,
        },
        ...(await materialize(state.messages, ctx, model)),
      ];
      // Conservatively bound text without silently dropping instructions or
      // tool pairs. Image bytes are separately bounded during attachment input.
      const textMessages = messages.map((m) => ({
        ...m,
        content: Array.isArray(m.content)
          ? m.content.filter((p) => p.type !== "image_url")
          : m.content,
      }));
      const bytes = Buffer.byteLength(
        JSON.stringify({ messages: textMessages, tools: apiTools }),
      );
      const output = Math.min(
        8192,
        model.top_provider?.max_completion_tokens ?? 8192,
        Math.floor(model.context_length / 4),
      );
      if (bytes > Math.min(MAX_TRANSCRIPT_BYTES, model.context_length - output))
        throw new Error(
          "This OpenRouter conversation is too large for the selected model's context. Start a new chat with a bounded handoff.",
        );
      const nativeId = randomUUID();
      const result = await service.completion({
        model: ctx.model,
        messages,
        tools: apiTools,
        maxTokens: output,
        signal: ctx.signal,
        onDelta: (delta) => ctx.emit("text", { nativeId, delta }),
      });
      ctx.emit("nativeModel", { model: result.model });
      if (result.usage)
        ctx.emit("work", {
          kind: "token-usage",
          inputTokens: result.usage.prompt_tokens,
          outputTokens: result.usage.completion_tokens,
          cost: result.usage.cost ?? null,
        });
      state.messages.push(result.message);
      checkpoint(store, ctx.chat.id, state);
      if (!result.message.tool_calls?.length) {
        if (steers.length) continue;
        return { status: "completed" };
      }
      for (const call of result.message.tool_calls) {
        service.check(ctx.model);
        ctx.signal.throwIfAborted();
        const name = call.function.name,
          toolSchema = schemas.get(name);
        let output;
        const id = call.id;
        ctx.emit("work", {
          provider: "openrouter",
          kind: "tool_call",
          toolCallId: id,
          toolName: name,
          title: name,
          status: "running",
        });
        try {
          if (!toolSchema)
            throw new Error(
              "This tool is unavailable in the current chat mode.",
            );
          const parsed = toolSchema.safeParse(
            JSON.parse(call.function.arguments),
          );
          if (!parsed.success)
            throw new Error("Tool arguments do not match the supplied schema.");
          ctx.emit("work", {
            provider: "openrouter",
            kind: "tool_call",
            toolCallId: id,
            toolName: name,
            target:
              parsed.data.path ??
              parsed.data.command ??
              parsed.data.query ??
              name,
            status: "running",
          });
          state.pendingTool = { id, name };
          checkpoint(store, ctx.chat.id, state);
          output = openRouterFileTools.some((t) => t.name === name)
            ? await callOpenRouterFile(ctx, name, parsed.data)
            : name === "browser"
              ? await ctx.browser(name, parsed.data)
              : await ctx.history(name, parsed.data);
        } catch (error) {
          output = { error: error.message };
        }
        ctx.signal.throwIfAborted();
        const content = JSON.stringify(output ?? null);
        state.messages.push({
          role: "tool",
          tool_call_id: id,
          content:
            content.length > 80000
              ? JSON.stringify({
                  truncated: true,
                  text: content.slice(0, 79000),
                })
              : content,
        });
        delete state.pendingTool;
        checkpoint(store, ctx.chat.id, state);
        ctx.emit("work", {
          provider: "openrouter",
          kind: "tool_call_update",
          toolCallId: id,
          toolName: name,
          title: name,
          status: output?.error || output?.declined ? "failed" : "completed",
        });
      }
    }
    throw new Error(
      "OpenRouter reached the 20-request limit for this turn. Send a message to continue from saved progress.",
    );
  } finally {
    open = false;
    if (!ctx.signal.aborted) {
      await service.refreshUsage();
      ctx.emit("usage", service.usage);
    }
  }
}
