import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./components.jsx";

const effortLabel = (effort) => effort[0].toUpperCase() + effort.slice(1);

// The composer's trigger opens at the provider list. A welcome card passes its
// own trigger and a root, so it opens straight onto that provider's models.
export function ModelPicker({
  providers,
  provider,
  model,
  effort,
  onChange,
  onOpenConnections,
  root = [],
  className = "model-control",
  renderTrigger,
}) {
  const [path, setPath] = useState(null),
    [placement, setPlacement] = useState({}),
    trigger = useRef(null),
    popup = useRef(null),
    menuId = useId();
  const selectedProvider = providers.find((p) => p.id === provider),
    selectedModel = selectedProvider?.models?.find((m) => m.id === model),
    browsingProvider = providers.find((p) => p.id === path?.[0]),
    browsingModel = browsingProvider?.models?.find((m) => m.id === path?.[1]),
    open = path !== null;
  const summary = selectedModel
    ? selectedProvider.name +
      " · " +
      selectedModel.name +
      (effort
        ? " · " + effortLabel(effort)
        : selectedModel.efforts?.length
          ? " · Choose effort"
          : "")
    : "Choose a model";
  const close = (restoreFocus = true) => {
    setPath(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  const choose = (p, m, value = "") => {
    onChange({ provider: p.id, model: m.id, effort: value });
    close();
  };
  const back = () => setPath((current) => current.slice(0, -1)),
    canGoBack = open && path.length > root.length;
  const rows = browsingModel
    ? (browsingModel.efforts ?? []).map((value) => ({
        id: value,
        name: effortLabel(value),
        disabled: browsingModel.disabled,
        selected:
          provider === browsingProvider.id &&
          model === browsingModel.id &&
          effort === value,
        select: () => choose(browsingProvider, browsingModel, value),
      }))
    : browsingProvider
      ? (browsingProvider.models ?? []).map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          disabled: m.disabled,
          nested: !!m.efforts?.length,
          selected: provider === browsingProvider.id && model === m.id,
          select: () =>
            m.efforts?.length
              ? setPath([browsingProvider.id, m.id])
              : choose(browsingProvider, m),
        }))
      : providers.map((p) => ({
          id: p.id,
          name: p.name,
          provider: p.id,
          nested: true,
          selected: provider === p.id && !!model,
          select: () => setPath([p.id]),
        }));

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const box = trigger.current.getBoundingClientRect(),
        viewport = window.visualViewport,
        left = viewport?.offsetLeft ?? 0,
        top = viewport?.offsetTop ?? 0,
        width = viewport?.width ?? innerWidth,
        height = viewport?.height ?? innerHeight;
      const below = top + height - box.bottom - 8,
        above = box.top - top - 8,
        upwards = above >= Math.min(360, below);
      setPlacement({
        left: Math.max(
          left + 8,
          Math.min(box.left, left + width - Math.min(320, width - 16) - 8),
        ),
        width: Math.min(320, width - 16),
        maxHeight: Math.max(80, Math.min(360, upwards ? above : below)),
        ...(upwards
          ? { bottom: innerHeight - box.top + 8 }
          : { top: box.bottom + 8 }),
      });
    };
    const outside = (event) => {
      if (
        !popup.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        close(false);
    };
    position();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const menu = popup.current;
    const selected = menu.querySelector('[aria-checked="true"]:not(:disabled)'),
      first = menu.querySelector('[role^="menuitem"]:not(:disabled)');
    (selected ?? first)?.focus();
    if (!menu.contains(document.activeElement)) menu.focus();
  }, [path?.join("\n")]);

  const keyDown = (event) => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowLeft" && canGoBack) {
      event.preventDefault();
      back();
      return;
    }
    if (event.key === "ArrowRight") {
      if (document.activeElement?.getAttribute("aria-haspopup") === "menu") {
        event.preventDefault();
        document.activeElement.click();
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
        popup.current.querySelectorAll('[role^="menuitem"]:not(:disabled)'),
      ),
      index = items.indexOf(document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };
  const triggerProps = {
    ref: trigger,
    type: "button",
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: () => (open ? close() : setPath(root)),
    onKeyDown: (event) => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        setPath(root);
      }
    },
  };
  return (
    <div className={className}>
      {renderTrigger ? (
        renderTrigger(triggerProps)
      ) : (
        <button
          {...triggerProps}
          className="model-trigger"
          aria-label="Agent and model"
          aria-describedby={menuId + "-selection"}
          title={summary}
        >
          <span className={"provider-dot " + provider} />
          <span className="model-summary" id={menuId + "-selection"}>
            {summary}
          </span>
          <span className="model-chevron" aria-hidden="true">
            ⌄
          </span>
        </button>
      )}
      {open &&
        createPortal(
          <div
            ref={popup}
            className="model-popup"
            style={placement}
            tabIndex={-1}
            onKeyDown={keyDown}
            onBlur={(event) => {
              if (
                event.relatedTarget &&
                !event.currentTarget.contains(event.relatedTarget) &&
                event.relatedTarget !== trigger.current
              )
                close(false);
            }}
          >
            <div className="model-menu-header">
              {canGoBack && (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={
                    browsingModel ? "Back to models" : "Back to providers"
                  }
                  onClick={back}
                >
                  ←
                </button>
              )}
              <span>
                {browsingModel
                  ? browsingModel.name + " · Effort"
                  : browsingProvider
                    ? browsingProvider.name + " · Models"
                    : "Choose provider"}
              </span>
            </div>
            <div
              id={menuId}
              role="menu"
              aria-label={
                browsingModel
                  ? "Choose effort"
                  : browsingProvider
                    ? "Choose model"
                    : "Choose provider"
              }
            >
              {rows.map((row) => (
                <button
                  type="button"
                  role={row.nested ? "menuitem" : "menuitemradio"}
                  aria-checked={row.nested ? undefined : row.selected}
                  aria-haspopup={row.nested ? "menu" : undefined}
                  aria-disabled={row.disabled || undefined}
                  disabled={row.disabled}
                  tabIndex={-1}
                  title={row.description}
                  key={row.id}
                  onClick={row.select}
                >
                  {row.provider && (
                    <span className={"provider-dot " + row.provider} />
                  )}
                  <span className="model-option-name">{row.name}</span>
                  {row.disabled && (
                    <small aria-hidden="true">Unavailable</small>
                  )}
                  {row.selected && <Icon name="check" size={14} />}
                  {row.nested && (
                    <span className="model-next" aria-hidden="true">
                      ›
                    </span>
                  )}
                </button>
              ))}
            </div>
            {rows.length === 0 && (
              <div className="model-menu-empty">
                <p>
                  No models available for{" "}
                  {browsingProvider?.name ?? "this provider"}.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    close();
                    onOpenConnections();
                  }}
                >
                  Connections &amp; usage
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
