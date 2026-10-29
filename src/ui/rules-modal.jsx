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
import { ACTIONS, ACTION_NAMES } from "../core/delegation.mjs";
import { PRICES_AS_OF, priceOf } from "../core/prices.mjs";
import {
  cursorReviewer,
  reviewerModel,
  reviewSettings,
} from "../core/review-policy.mjs";

// A worker can take work only if its provider can run and its price is known.
const standing = (worker, providers) => {
  const status = workerAvailability(worker, providers);
  return status.available && !priceOf(providers, worker)
    ? {
        available: false,
        reason:
          "No list price is known for this model, so its cost cannot be compared and it is never used.",
      }
    : status;
};

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
  if (!enabled) return "Off. Each chat does its own work.";
  const [primary, fallback] = workers.map((worker) => ({
    name: workerName(worker, providers),
    ...standing(worker, providers),
  }));
  const why = (w) => `${w.name}: ${w.reason.replace(/\.?$/, ".")}`;
  if (primary.available) return `Hand-offs go to ${primary.name}.`;
  if (fallback?.available)
    return `Hand-offs go to ${fallback.name}. ${why(primary)}`;
  return `No worker is available; chats will do their own work. ${[
    primary,
    fallback,
  ]
    .filter(Boolean)
    .map(why)
    .join(" ")}`;
}

function WorkerPicker({
  label,
  empty,
  worker,
  exclude,
  providers,
  onChange,
  providerIds = WORKER_PROVIDERS,
  availability = standing,
  showIds = false,
}) {
  const offered = providers.filter((p) => providerIds.includes(p.id)),
    model = offered
      .find((p) => p.id === worker?.provider)
      ?.models?.find((m) => m.id === worker.model),
    provider = providers.find((p) => p.id === worker?.provider),
    status = worker && availability(worker, providers);
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
          {worker && (!model || model.disabled) && (
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
                      {showIds ? ` (${m.resolvedModel ?? m.id})` : ""}
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
            {worker.effort && !model.efforts.includes(worker.effort) && (
              <option value={worker.effort}>
                {worker.effort} · no longer offered
              </option>
            )}
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

function ReviewerSettings({ value, providers, onChange }) {
  const ids = ["codex", ...(value.claudeFallback ? ["claude"] : [])],
    reasons = [];
  let route = "";
  for (const id of ids) {
    try {
      const reviewer = cursorReviewer(providers, value[id], id);
      route = `Cursor reviews use ${reviewer.name}${reviewer.effort ? ` · ${reviewer.effort} effort` : ""}.`;
      if (reasons.length) route += " " + reasons.join(" ");
      break;
    } catch (error) {
      reasons.push(error.message);
    }
  }
  if (!route)
    route =
      "No reviewer is available; actions will be declined automatically. " +
      reasons.join(" ");
  return (
    <section className="connection">
      <header>
        <h3>Automatic reviewer</h3>
      </header>
      <p>
        Choose the Codex model that reviews Auto-review actions: Cursor
        requests, browser actions from every agent, and commands Claude Code or
        Codex passes on. It decides coding and command questions, and asks you
        only for a managerial choice it explains. If Codex cannot review, the
        Claude model below takes over using its included subscription usage.
        Both receive the task, recent user instructions and refusals, project
        rules, the agent's recent actions, and exact action details.
      </p>
      {["codex", "claude"].map((id) => {
        const automatic = reviewerModel(providers, id, null),
          label =
            id === "codex" ? "Codex reviewer model" : "Claude fallback model";
        return (
          <WorkerPicker
            key={id}
            label={label}
            empty={
              automatic
                ? `Provider default: ${automatic.name ?? automatic.id} (${automatic.resolvedModel ?? automatic.id})`
                : "Provider default (no models available)"
            }
            worker={value[id] && { provider: id, ...value[id] }}
            providers={providers}
            providerIds={[id]}
            availability={workerAvailability}
            showIds
            onChange={(next) =>
              onChange({
                ...value,
                [id]: next && { model: next.model, effort: next.effort },
              })
            }
          />
        );
      })}
      <label className="rule-toggle">
        <input
          type="checkbox"
          aria-label="Use Claude fallback"
          checked={value.claudeFallback}
          onChange={(e) =>
            onChange({ ...value, claudeFallback: e.target.checked })
          }
        />
        Use Claude fallback
      </label>
      <p className="rule-route" role="status">
        {route}
      </p>
      <p className="muted small">
        Pinned choices stay fixed until you change them. Saving applies to the
        next review, including during an active turn. A reviewer&rsquo;s deny is
        final, as is a request for a managerial choice. If neither reviewer can
        complete, the action is declined automatically. API billing and paid
        extra usage remain disabled.
      </p>
    </section>
  );
}

export function RulesModal({ rules, providers, delegation, onSaved, onClose }) {
  const [instructions, setInstructions] = useState(rules.instructions),
    [review, setReview] = useState(() => reviewSettings(rules.review)),
    [enabled, setEnabled] = useState(rules.delegate.enabled),
    [primary, setPrimary] = useState(rules.delegate.workers[0] ?? null),
    [fallback, setFallback] = useState(rules.delegate.workers[1] ?? null),
    [actions, setActions] = useState(rules.delegate.actions),
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
          review,
          delegate: {
            enabled: enabled && !!primary,
            actions,
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
      setNotice({
        text: "Saved. Reviewer choices apply to the next review; other rules apply to new turns.",
      });
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
        <ReviewerSettings
          value={review}
          providers={providers}
          onChange={setReview}
        />
        <section className="connection">
          <header>
            <h3>Hand off work to a cheaper model</h3>
            <label className="rule-toggle">
              <input
                type="checkbox"
                aria-label="Hand off work to a cheaper model"
                checked={enabled && !!primary}
                disabled={!primary}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              {enabled && primary ? "On" : "Off"}
            </label>
          </header>
          <p>
            A chat can give the kinds of work ticked below to the worker model
            instead of doing them on its own model. Harness decides each time:
            it compares the cost of starting the worker, the worker&rsquo;s
            tokens and the chat reading the result with the cost of the chat
            doing the work, and uses the worker only when that is cheaper. No
            model spends tokens on the estimate.
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
          <fieldset className="rule-actions">
            <legend>What may be handed off</legend>
            {ACTION_NAMES.map((name) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={actions[name] !== false}
                  onChange={(e) =>
                    setActions({ ...actions, [name]: e.target.checked })
                  }
                />
                {ACTIONS[name].label}
              </label>
            ))}
          </fieldset>
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
            Costs are compared at list prices as of {PRICES_AS_OF}, and a model
            without a known price is never used. Small jobs are never handed
            off. An edit comes back as a diff for the chat to review, and a
            command runs only after you approve it. Applies to Claude Code and
            Codex chats; Cursor chats are not covered. A worker spends its own
            provider&rsquo;s included usage, so a Codex chat with a Claude
            worker uses Claude usage. When no worker can run, the chat does its
            own work.
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
