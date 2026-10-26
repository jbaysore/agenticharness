import { EventEmitter } from "node:events";
import {
  OpenRouterCredentials,
  explicitOpenRouterModel,
  openRouterModelProblem,
} from "../security/openrouter.mjs";

const API = "https://openrouter.ai/api/v1/";
const CATALOG_TTL = 5 * 60 * 1000;
const POLICY_KEY = "openrouter-policy";
const defaultPolicy = () => ({
  revision: 0,
  enabled: false,
  dataConsent: false,
  allowedModels: [],
});

// The only OpenRouter HTTP boundary. Callers supply messages/tools, never a
// raw request body, endpoint, routing plugin, fallback array, or credential.
export class OpenRouter extends EventEmitter {
  constructor(
    store,
    dataDir,
    {
      fetch: fetchImpl = globalThis.fetch,
      credentials = new OpenRouterCredentials(dataDir),
      now = Date.now,
    } = {},
  ) {
    super();
    this.store = store;
    this.fetch = fetchImpl;
    this.credentials = credentials;
    this.now = now;
    this.catalog = new Map();
    this.catalogAt = null;
    this.usage = { authoritative: false, windows: [] };
    this.writing = Promise.resolve();
    this.requests = new Set();
    this.closed = false;
  }
  policy() {
    return this.store.setting(POLICY_KEY) ?? defaultPolicy();
  }
  async settings() {
    return {
      ...this.policy(),
      billing: "free-only",
      keyConfigured: await this.credentials.has(),
      catalogAt:
        this.catalogAt == null ? null : new Date(this.catalogAt).toISOString(),
      catalog: [...this.catalog.values()]
        .filter((m) => explicitOpenRouterModel(m.id))
        .map((m) => ({
          id: m.id,
          name: typeof m.name === "string" ? m.name : m.id,
          canonicalSlug:
            typeof m.canonical_slug === "string" ? m.canonical_slug : m.id,
          problem: openRouterModelProblem(m),
          contextLength: m.context_length,
        })),
    };
  }
  configure(input) {
    const job = this.writing.then(() => this.saveConfiguration(input));
    this.writing = job.catch(() => {});
    return job;
  }
  async saveConfiguration(input) {
    if (
      !input ||
      Array.isArray(input) ||
      typeof input !== "object" ||
      Object.keys(input).some(
        (key) =>
          ![
            "revision",
            "enabled",
            "dataConsent",
            "allowedModels",
            "apiKey",
            "removeKey",
          ].includes(key),
      )
    )
      throw new Error("Invalid OpenRouter settings.");
    const previous = this.policy();
    if (input.revision !== previous.revision)
      throw new Error(
        "OpenRouter settings changed. Reload them before saving.",
      );
    if (
      typeof input.dataConsent !== "boolean" ||
      (input.enabled && !input.dataConsent)
    )
      throw new Error(
        "Before enabling OpenRouter, consent to sending chat prompts, permitted project files and attachments to OpenRouter and the selected model's hosting providers.",
      );
    if (
      typeof input.enabled !== "boolean" ||
      !Array.isArray(input.allowedModels) ||
      input.allowedModels.length > 100 ||
      new Set(input.allowedModels).size !== input.allowedModels.length ||
      input.allowedModels.some((id) => !explicitOpenRouterModel(id))
    )
      throw new Error(
        "Approve exact model IDs; wildcards, aliases and routers are unavailable.",
      );
    if (
      (input.removeKey !== undefined && typeof input.removeKey !== "boolean") ||
      (input.removeKey && input.apiKey)
    )
      throw new Error("Choose either replacing or removing the key.");
    const allowedModels = input.allowedModels.map((id) => {
      const model = this.catalog.get(id),
        old = previous.allowedModels.find((m) => m.id === id);
      // Removing unavailable approvals must work even if the catalog is down.
      if (!model && old) return old;
      const problem = openRouterModelProblem(model);
      if (
        old &&
        (problem ||
          this.catalogAt == null ||
          this.now() - this.catalogAt > CATALOG_TTL)
      )
        return old;
      if (problem) throw new Error(`${id}: ${problem}`);
      if (this.catalogAt == null || this.now() - this.catalogAt > CATALOG_TTL)
        throw new Error("Refresh the model catalog before approving models.");
      return { id, canonicalSlug: model.canonical_slug ?? id };
    });
    if (input.apiKey !== undefined) await this.credentials.write(input.apiKey);
    if (input.removeKey) await this.credentials.remove();
    this.store.setting(POLICY_KEY, {
      revision: previous.revision + 1,
      enabled: input.enabled,
      dataConsent: input.dataConsent,
      allowedModels,
    });
    // Abort even an already streaming request on a policy or credential edit.
    for (const abort of this.requests)
      abort.abort(
        new Error("OpenRouter settings changed. Send your message again."),
      );
    this.emit("change");
    return this.settings();
  }
  async catalogRefresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const response = await this.fetch(API + "models", {
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (!Array.isArray(body.data) || body.data.length > 20000)
          throw new Error();
        this.catalog = new Map(
          body.data
            .filter((m) => m && typeof m.id === "string")
            .map((m) => [m.id, m]),
        );
        this.catalogAt = this.now();
      } catch {
        // Expired or failed metadata is never used to authorize inference.
        this.catalogAt = null;
        throw new Error(
          "OpenRouter model pricing and availability could not be verified. Refresh the catalog to retry.",
        );
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  check(modelId) {
    const policy = this.policy();
    if (this.closed || policy.enabled !== true)
      throw new Error("OpenRouter is disabled in Connections & usage.");
    if (policy.dataConsent !== true)
      throw new Error(
        "OpenRouter data sharing has not been authorized in Connections & usage.",
      );
    const approved = policy.allowedModels.find((m) => m.id === modelId);
    if (!approved)
      throw new Error(
        "This OpenRouter model is not approved. Update the allowlist in Connections & usage.",
      );
    if (this.catalogAt == null || this.now() - this.catalogAt > CATALOG_TTL)
      throw new Error(
        "OpenRouter model pricing and availability need a fresh catalog check.",
      );
    const model = this.catalog.get(modelId),
      problem = openRouterModelProblem(model);
    if (problem) throw new Error(problem);
    if ((model.canonical_slug ?? model.id) !== approved.canonicalSlug)
      throw new Error(
        "This model's catalog identity changed. Review and approve it again.",
      );
    return model;
  }
  async refreshUsage() {
    try {
      const key = await this.credentials.read();
      const response = await this.fetch(API + "key", {
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error();
      const { data } = await response.json(),
        counter = data?.free_model_daily_requests;
      this.usage = {
        authoritative: true,
        windows: [],
        checkedAt: new Date(this.now()).toISOString(),
        requestsRemaining: Number.isFinite(counter?.remaining)
          ? Math.max(0, counter.remaining)
          : null,
        requestsLimit: Number.isFinite(counter?.limit) ? counter.limit : null,
      };
    } catch {
      this.usage = { authoritative: false, windows: [] };
    }
  }
  async inspect({ refresh = false } = {}) {
    const policy = this.policy(),
      connected = await this.credentials.has();
    let blockReason =
      policy.stoppedReason ??
      (!policy.enabled
        ? "Enable OpenRouter and approve models in Connections & usage."
        : !policy.dataConsent
          ? "Authorize OpenRouter data sharing in Connections & usage."
          : !connected
            ? "Add an OpenRouter API key in Connections & usage."
            : !policy.allowedModels.length
              ? "Approve at least one exact model ID in Connections & usage."
              : null);
    if (!blockReason && refresh) {
      try {
        await this.catalogRefresh();
      } catch (error) {
        blockReason = error.message;
      }
      await this.refreshUsage();
    }
    const models = policy.allowedModels.map(({ id }) => {
      const model = this.catalog.get(id);
      let reason;
      try {
        this.check(id);
      } catch (error) {
        reason = error.message;
      }
      return {
        id,
        name: typeof model?.name === "string" ? model.name : id,
        description: reason ?? "Approved free model",
        efforts: [],
        disabled: !!reason,
        billing: "Free only",
        contextLength: model?.context_length,
      };
    });
    if (!blockReason && !models.some((m) => !m.disabled))
      blockReason = models[0]?.description ?? "No approved model is available.";
    return {
      id: "openrouter",
      name: "OpenRouter",
      route: "OpenRouter API · free models only",
      plan: "Exact model allowlist",
      connected,
      blockReason,
      models,
      usage: this.usage,
      capabilities: {
        nativeResume: false,
        nativeSubagents: false,
        effort: false,
        usage: true,
        historyTools: true,
      },
      note: "Harness saves this agent's transcript. Goal mode, worker delegation, paid models and cross-model fallbacks are unavailable.",
    };
  }
  assertResponseModel(requested, actual) {
    const model = this.check(requested);
    const identities = new Set(
      [model.id, model.canonical_slug ?? model.id].flatMap((id) => [
        id,
        id.replace(/:free$/, ""),
      ]),
    );
    if (!identities.has(actual))
      throw new Error(
        "OpenRouter returned an unexpected model identity. The turn stopped before running its tools.",
      );
  }
  async completion({ model, messages, tools, maxTokens, signal, onDelta }) {
    // Refresh before expiry, then check again after asynchronous key access.
    if (this.catalogAt == null || this.now() - this.catalogAt > CATALOG_TTL)
      await this.catalogRefresh();
    this.check(model);
    const revision = this.policy().revision,
      key = await this.credentials.read();
    this.check(model);
    if (revision !== this.policy().revision)
      throw new Error("OpenRouter settings changed before dispatch.");
    signal?.throwIfAborted();
    const abort = new AbortController();
    this.requests.add(abort);
    const combined = AbortSignal.any([
      ...(signal ? [signal] : []),
      abort.signal,
      AbortSignal.timeout(120000),
    ]);
    try {
      const response = await this.fetch(API + "chat/completions", {
        method: "POST",
        redirect: "error",
        signal: combined,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "X-OpenRouter-Title": "Agentic Harness",
        },
        body: JSON.stringify({
          model,
          messages,
          tools,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: maxTokens,
          parallel_tool_calls: false,
          provider: {
            require_parameters: true,
            max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
          },
        }),
      });
      if (!response.ok) {
        // Never expose provider error bodies: they may reflect request secrets.
        const errors = {
          401: "OpenRouter rejected the API key. Replace it in Connections & usage.",
          402: "OpenRouter rejected this request at its credit boundary. Paid usage remains disabled.",
          429: "OpenRouter's free-model usage limit has been reached. Wait before retrying.",
          404: "This approved OpenRouter model is currently unavailable.",
        };
        throw new Error(
          errors[response.status] ??
            `OpenRouter request failed (HTTP ${response.status}).`,
        );
      }
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      const result = { role: "assistant", content: "" },
        calls = new Map();
      let buffer = "",
        size = 0,
        identity = null,
        finish = null,
        usage = null,
        doneMarker = false;
      const reasoning = new Map();
      const event = (line) => {
        if (!line.startsWith("data:")) return;
        const raw = line.slice(5).trim();
        if (!raw) return;
        if (raw === "[DONE]") {
          doneMarker = true;
          return;
        }
        let item;
        try {
          item = JSON.parse(raw);
        } catch {
          throw new Error("OpenRouter returned an invalid event stream.");
        }
        if (item.error)
          throw new Error(
            "OpenRouter interrupted the response. Send a new message to continue.",
          );
        if (item.model) {
          this.assertResponseModel(model, item.model);
          identity = item.model;
        }
        if (item.usage) usage = item.usage;
        for (const choice of item.choices ?? []) {
          if (choice.index != null && choice.index !== 0)
            throw new Error(
              "OpenRouter returned multiple choices unexpectedly.",
            );
          const delta = choice.delta ?? {};
          if (typeof delta.reasoning === "string")
            result.reasoning = (result.reasoning ?? "") + delta.reasoning;
          // Preserve provider-issued reasoning signatures for subsequent tool
          // exchanges. They are protocol state, never instructions or UI text.
          for (const detail of delta.reasoning_details ?? []) {
            const index = detail.index ?? detail.id ?? reasoning.size;
            const previous = reasoning.get(index);
            if (previous && previous.type === detail.type) {
              reasoning.set(index, {
                ...previous,
                ...detail,
                ...(typeof detail.text === "string"
                  ? { text: (previous.text ?? "") + detail.text }
                  : {}),
                ...(typeof detail.summary === "string"
                  ? { summary: (previous.summary ?? "") + detail.summary }
                  : {}),
                ...(typeof detail.data === "string"
                  ? { data: (previous.data ?? "") + detail.data }
                  : {}),
                ...(typeof detail.signature === "string"
                  ? { signature: (previous.signature ?? "") + detail.signature }
                  : { signature: previous.signature ?? detail.signature }),
              });
            } else reasoning.set(index, detail);
          }
          if ((delta.content || delta.tool_calls?.length) && !identity)
            throw new Error(
              "OpenRouter did not identify the model before returning content.",
            );
          if (typeof delta.content === "string") {
            result.content += delta.content;
            onDelta?.(delta.content);
          }
          for (const part of delta.tool_calls ?? []) {
            if (
              !Number.isInteger(part.index) ||
              part.index < 0 ||
              part.index > 31
            )
              throw new Error("Invalid OpenRouter tool index.");
            const call = calls.get(part.index) ?? {
              id: "",
              type: "function",
              function: { name: "", arguments: "" },
            };
            if (part.id) call.id += part.id;
            if (part.function?.name) call.function.name += part.function.name;
            if (part.function?.arguments)
              call.function.arguments += part.function.arguments;
            calls.set(part.index, call);
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      };
      try {
        while (true) {
          combined.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024)
            throw new Error("OpenRouter response exceeded the size limit.");
          buffer += decoder.decode(value, { stream: true });
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            event(buffer.slice(0, newline).replace(/\r$/, ""));
            buffer = buffer.slice(newline + 1);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) event(buffer.replace(/\r$/, ""));
      } finally {
        await reader.cancel().catch(() => {});
      }
      this.check(model);
      combined.throwIfAborted();
      if (revision !== this.policy().revision)
        throw new Error("OpenRouter settings changed during the response.");
      if (!identity || !doneMarker || !["stop", "tool_calls"].includes(finish))
        throw new Error(
          "OpenRouter's response was incomplete. No tool from this response was executed.",
        );
      if (
        usage?.cost != null &&
        (!Number.isFinite(Number(usage.cost)) || Number(usage.cost) !== 0)
      ) {
        this.store.setting(POLICY_KEY, {
          ...this.policy(),
          enabled: false,
          revision: revision + 1,
          stoppedReason:
            "OpenRouter reported an unexpected cost. The integration was disabled; review your OpenRouter activity.",
        });
        this.emit("change");
        throw new Error(
          "OpenRouter reported an unexpected cost. The integration was disabled; review your OpenRouter activity.",
        );
      }
      if (calls.size) {
        result.tool_calls = [...calls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, call]) => call);
        if (
          finish !== "tool_calls" ||
          new Set(result.tool_calls.map((c) => c.id)).size !== calls.size ||
          result.tool_calls.some((c) => !c.id || !c.function.name)
        )
          throw new Error("OpenRouter returned incomplete tool calls.");
      } else if (finish === "tool_calls")
        throw new Error("OpenRouter returned no tool calls.");
      if (!calls.size && !result.content.trim())
        throw new Error(
          "OpenRouter returned no visible answer. Send a message to retry.",
        );
      if (reasoning.size) result.reasoning_details = [...reasoning.values()];
      return { message: result, usage, model: identity };
    } catch (error) {
      if (this.policy().stoppedReason)
        throw new Error(this.policy().stoppedReason);
      if (combined.aborted)
        throw new Error(
          signal?.aborted
            ? "The turn was stopped."
            : "OpenRouter request stopped after a timeout or settings change.",
        );
      // Our messages are controlled; an upstream network error may contain URLs.
      if (error instanceof TypeError)
        throw new Error(
          "OpenRouter could not be reached. Send a message to retry.",
        );
      throw error;
    } finally {
      this.requests.delete(abort);
    }
  }
  close() {
    this.closed = true;
    for (const abort of this.requests) abort.abort();
  }
}
