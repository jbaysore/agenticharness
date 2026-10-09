import React, { useState } from "react";
import { api } from "./api.mjs";
import { Modal } from "./components.jsx";
import { providerStatusLabel } from "./status.mjs";
import {
  WORKER_PROVIDERS,
  workerAvailability,
  workerKey,
  workerName,
} from "../core/rules.mjs";

const parse = (value) => {
  const cut = value.indexOf("|");
  return cut < 0
    ? null
    : { provider: value.slice(0, cut), model: value.slice(cut + 1) };
};
const tokens = (n) => n.toLocaleString("en-US");

// Where a search would go right now, given which providers can run.
export function delegationRoute(enabled, workers, providers) {
  if (!workers.length) return "Choose a worker model to turn this on.";
  if (!enabled) return "Off. Each chat does its own searching.";
  const [primary, fallback] = workers.map((worker) => ({
    name: workerName(worker, providers),
    ...workerAvailability(worker, providers),
  }));
  const why = (w) => `${w.name}: ${w.reason.replace(/\.?$/, ".")}`;
  if (primary.available) return `Searches go to ${primary.name}.`;
  if (fallback?.available)
    return `Searches go to ${fallback.name}. ${why(primary)}`;
  return `No worker is available; chats will search for themselves. ${[
    primary,
    fallback,
  ]
    .filter(Boolean)
    .map(why)
    .join(" ")}`;
}

function WorkerPicker({ label, empty, worker, exclude, providers, onChange }) {
  const offered = providers.filter((p) => WORKER_PROVIDERS.includes(p.id)),
    model = offered
      .find((p) => p.id === worker?.provider)
      ?.models?.find((m) => m.id === worker.model),
    provider = providers.find((p) => p.id === worker?.provider),
    status = worker && workerAvailability(worker, providers);
  return (
    <div className="rule-worker">
      <label>
        {label}
        <select
          aria-label={label}
          value={worker ? workerKey(worker) : ""}
          onChange={(e) => {
            const next = parse(e.target.value);
            onChange(next && { ...next, effort: null });
          }}
        >
          <option value="">{empty}</option>
          {worker && !model && (
            <option value={workerKey(worker)}>
              {worker.model} · no longer offered
            </option>
          )}
          {offered.map((p) => (
            <optgroup label={p.name} key={p.id}>
              {p.models
                ?.filter((m) => !m.disabled)
                .map((m) => {
                  const value = p.id + "|" + m.id;
                  return (
                    <option
                      key={m.id}
                      value={value}
                      disabled={value === exclude}
                    >
                      {p.name} · {m.name}
                    </option>
                  );
                })}
            </optgroup>
          ))}
        </select>
      </label>
      {model?.efforts?.length > 0 && (
        <label>
          Effort
          <select
            aria-label={label + " effort"}
            value={worker.effort ?? ""}
            onChange={(e) =>
              onChange({ ...worker, effort: e.target.value || null })
            }
          >
            <option value="">Provider default</option>
            {model.efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort[0].toUpperCase() + effort.slice(1)}
              </option>
            ))}
          </select>
        </label>
      )}
      {status && (
        <p className={"rule-status" + (status.available ? "" : " blocked")}>
          <span className="badge">
            {status.available ? "Available" : providerStatusLabel(provider)}
          </span>
          {status.reason}
        </p>
      )}
    </div>
  );
}

export function RulesModal({ rules, providers, delegation, onSaved, onClose }) {
  const [instructions, setInstructions] = useState(rules.instructions),
    [enabled, setEnabled] = useState(rules.delegate.enabled),
    [primary, setPrimary] = useState(rules.delegate.workers[0] ?? null),
    [fallback, setFallback] = useState(rules.delegate.workers[1] ?? null),
    [saving, setSaving] = useState(false),
    [notice, setNotice] = useState(null);
  const workers = [primary, primary && fallback].filter(Boolean);
  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await api(
        "/api/rules",
        {
          instructions,
          delegate: {
            enabled: enabled && !!primary,
            workers: workers.map(({ provider, model, effort }) => ({
              provider,
              model,
              effort,
            })),
          },
        },
        "PUT",
      );
      await onSaved();
      setNotice({ text: "Saved. New turns use these rules." });
    } catch (error) {
      setNotice({ text: error.message, failed: true });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="Agent rules" wide onClose={onClose}>
      <p>
        Standing rules every agent receives at the start of each turn, in every
        project.
      </p>
      <form
        className="rules-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <section className="connection">
          <header>
            <h3>Instructions for every agent</h3>
          </header>
          <p>Given to Codex, Claude Code and Cursor chats as written.</p>
          <textarea
            aria-label="Instructions for every agent"
            placeholder="For example: keep answers short, and ask before adding a dependency."
            maxLength={8000}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </section>
        <section className="connection">
          <header>
            <h3>Hand off searches to a cheaper model</h3>
            <label className="rule-toggle">
              <input
                type="checkbox"
                aria-label="Hand off searches to a cheaper model"
                checked={enabled && !!primary}
                disabled={!primary}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              {enabled && primary ? "On" : "Off"}
            </label>
          </header>
          <p>
            A chat can give a read-only task, such as finding where something
            lives, to the worker model below instead of doing it on its own
            model. It is told what a hand-off has cost and uses one only when it
            expects that to be cheaper than searching itself.
          </p>
          <WorkerPicker
            label="Worker model"
            empty="Choose a model"
            worker={primary}
            providers={providers}
            onChange={(next) => {
              setPrimary(next);
              if (
                !next ||
                (fallback && workerKey(fallback) === workerKey(next))
              )
                setFallback(null);
            }}
          />
          {primary && (
            <WorkerPicker
              label="Fallback worker"
              empty="No fallback"
              worker={fallback}
              exclude={workerKey(primary)}
              providers={providers}
              onChange={setFallback}
            />
          )}
          {primary && !fallback && (
            <p className="muted small">
              Add a fallback on the other provider so one usage limit cannot
              stop both.
            </p>
          )}
          <p className="rule-route" role="status">
            {delegationRoute(enabled, workers, providers)}
          </p>
          {workers.map((worker) => {
            const cost = delegation[workerKey(worker)];
            return (
              cost && (
                <p className="muted small" key={workerKey(worker)}>
                  {workerName(worker, providers)}: last {cost.count}{" "}
                  {cost.count === 1 ? "hand-off" : "hand-offs"}, median{" "}
                  {tokens(cost.median)} tokens, lowest {tokens(cost.min)}.
                </p>
              )
            );
          })}
          <p className="muted small">
            Applies to Claude Code and Codex chats; Cursor chats are not
            covered. A chat already on the worker model does the work itself. A
            worker spends its own provider&rsquo;s included usage, so a Codex
            chat with a Claude worker uses Claude usage for its searches. When
            no worker can run, the chat searches for itself.
          </p>
        </section>
        {notice && (
          <p
            className={notice.failed ? "error-text" : "muted small"}
            role={notice.failed ? "alert" : "status"}
          >
            {notice.text}
          </p>
        )}
        <button className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save rules"}
        </button>
      </form>
    </Modal>
  );
}
