import React, { useEffect, useState } from "react";
import { api } from "./api.mjs";

export function OpenRouterSettings({ onChanged }) {
  const [settings, setSettings] = useState(null),
    [allowed, setAllowed] = useState([]),
    [enabled, setEnabled] = useState(false),
    [consent, setConsent] = useState(false),
    [key, setKey] = useState(""),
    [removeKey, setRemoveKey] = useState(false),
    [filter, setFilter] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const load = (value) => {
    setSettings(value);
    setAllowed(value.allowedModels.map((m) => m.id));
    setEnabled(value.enabled);
    setConsent(value.dataConsent === true);
  };
  useEffect(() => {
    let alive = true;
    api("/api/providers/openrouter").then(
      (value) => {
        if (alive) load(value);
      },
      (e) => {
        if (alive) setError(e.message);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  const run = async (work) => {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await work();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!settings)
    return (
      <section className="openrouter-setup">
        <p role="status">{error || "Loading OpenRouter settings…"}</p>
      </section>
    );
  const catalog = settings.catalog.filter(
    (m) => !m.problem || allowed.includes(m.id),
  );
  for (const id of allowed)
    if (!catalog.some((m) => m.id === id))
      catalog.push({
        id,
        name: id,
        problem:
          "Unavailable in the current catalog. Remove this approval or refresh models.",
      });
  const visible = catalog.filter((m) =>
    (m.id + " " + m.name).toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <section className="openrouter-setup" aria-label="OpenRouter setup">
      <h3>OpenRouter connection & model approvals</h3>
      <p>
        Only explicitly approved free models can run. Paid models, paid extras
        and automatic model fallbacks are disabled.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            const value = await api(
              "/api/providers/openrouter",
              {
                revision: settings.revision,
                enabled,
                dataConsent: consent,
                allowedModels: allowed,
                ...(key ? { apiKey: key } : {}),
                ...(removeKey ? { removeKey: true } : {}),
              },
              "PUT",
            );
            load(value);
            setKey("");
            setRemoveKey(false);
            setSaved(true);
            await onChanged?.();
          });
        }}
      >
        <fieldset disabled={busy}>
          <label>
            OpenRouter API key
            <input
              type="password"
              value={key}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={
                settings.keyConfigured
                  ? "Key stored securely · enter a replacement"
                  : "Paste your OpenRouter API key"
              }
              onChange={(e) => {
                setKey(e.target.value);
                setRemoveKey(false);
                setSaved(false);
              }}
            />
          </label>
          <p className="muted small">
            The key stays in Windows-protected storage on this PC. It is
            excluded from chat exports and database backups.
          </p>
          {settings.keyConfigured && (
            <label className="openrouter-check">
              <input
                type="checkbox"
                checked={removeKey}
                onChange={(e) => {
                  setRemoveKey(e.target.checked);
                  setKey("");
                }}
              />
              Remove stored key when saving
            </label>
          )}
          <label className="openrouter-check">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => {
                setConsent(e.target.checked);
                if (!e.target.checked) setEnabled(false);
              }}
            />
            I authorize sending OpenRouter chats' prompts, permitted
            project-file content and attachments to OpenRouter and the selected
            model's hosting providers. File edits and commands still follow
            Harness permissions.
          </label>
          <label className="openrouter-check">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!consent}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable OpenRouter
          </label>
          <div className="openrouter-catalog-heading">
            <strong>Approved models ({allowed.length})</strong>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                run(async () => {
                  const value = await api(
                    "/api/providers/openrouter/catalog",
                    {},
                  );
                  // Catalog refresh does not discard an unsaved selection or key.
                  setSettings(value);
                  await onChanged?.();
                })
              }
            >
              Refresh model catalog
            </button>
          </div>
          <label>
            Find a free model
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search model name or exact ID"
            />
          </label>
          <div className="openrouter-model-list">
            {visible.map((model) => (
              <label className="openrouter-model" key={model.id}>
                <input
                  type="checkbox"
                  checked={allowed.includes(model.id)}
                  disabled={!!model.problem && !allowed.includes(model.id)}
                  onChange={(e) =>
                    setAllowed((prior) =>
                      e.target.checked
                        ? [...prior, model.id]
                        : prior.filter((id) => id !== model.id),
                    )
                  }
                />
                <span>
                  <strong>{model.name}</strong>
                  <code>{model.id}</code>
                  {model.canonicalSlug && (
                    <small>Catalog identity: {model.canonicalSlug}</small>
                  )}
                  {model.problem && (
                    <small className="error-text">{model.problem}</small>
                  )}
                </span>
              </label>
            ))}
            {!visible.length && (
              <p className="muted">
                {settings.catalogAt
                  ? "No matching free models with tool support."
                  : "Refresh the catalog, then approve exact models. Nothing is approved automatically."}
              </p>
            )}
          </div>
          <p className="muted small">
            Saving reviews the selected catalog identities. Changing approvals,
            consent or credentials stops active OpenRouter turns. An empty
            allowlist blocks all inference.
          </p>
          <button className="primary" type="submit">
            {busy ? "Working…" : "Save approvals & connection"}
          </button>
        </fieldset>
      </form>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {saved && <p role="status">OpenRouter settings saved.</p>}
    </section>
  );
}
