import React, { useEffect, useRef, useState } from "react";
import {
  MIN_PANE_WIDTH,
  columnBudget,
  columnsFor,
  visibleCount,
} from "./panes.mjs";

const storageKey = "harness.sidebar-layout.v1";
const defaults = {
  leftWidth: 246,
  rightWidth: 380,
  leftOpen: true,
  rightOpen: true,
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function readLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    return {
      leftWidth: Number.isFinite(saved?.leftWidth)
        ? clamp(saved.leftWidth, 220, 420)
        : defaults.leftWidth,
      rightWidth: Number.isFinite(saved?.rightWidth)
        ? clamp(saved.rightWidth, 320, 640)
        : defaults.rightWidth,
      leftOpen: typeof saved?.leftOpen === "boolean" ? saved.leftOpen : true,
      rightOpen: typeof saved?.rightOpen === "boolean" ? saved.rightOpen : true,
    };
  } catch {
    return defaults;
  }
}

export function useSidebarLayout(paneCount = 1) {
  const [layout, setLayout] = useState(readLayout);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(layout));
    } catch {
      // Resizing and toggling still work if browser storage is unavailable.
    }
  }, [layout]);

  const mobile = viewport <= 700;
  const leftLimit = mobile
    ? Math.min(420, viewport - 32)
    : Math.min(420, viewport - MIN_PANE_WIDTH);
  const leftWidth = clamp(layout.leftWidth, 220, leftLimit);
  const leftSpace = layout.leftOpen ? leftWidth : 0;
  // The sidebar keeps its width; the window decides how many columns fit beside it.
  const budget = mobile ? 1 : columnBudget(viewport, leftSpace);
  const chatSpace = MIN_PANE_WIDTH * columnsFor(visibleCount(paneCount, budget));
  const docked = viewport > 1150 && viewport - leftSpace - 320 >= chatSpace;
  const rightMax = docked
    ? Math.min(640, viewport - leftSpace - chatSpace)
    : Math.min(640, viewport - 48);
  const rightWidth = clamp(layout.rightWidth, 320, rightMax);
  const rightSpace = docked && layout.rightOpen ? rightWidth : 0;
  const leftMax = docked
    ? Math.min(420, viewport - rightSpace - chatSpace)
    : leftLimit;

  return {
    layout,
    setLayout,
    mobile,
    docked,
    columnBudget: budget,
    leftWidth,
    rightWidth,
    leftMax,
    rightMax,
  };
}

export function ResizeHandle({ side, width, min, max, onResize, controls }) {
  const drag = useRef(null);
  const [dragging, setDragging] = useState(false);
  const direction = side === "left" ? 1 : -1;
  const label = side === "left" ? "Resize sidebar" : "Resize work panel";
  const resize = (value) => onResize(clamp(Math.round(value), min, max));
  const finish = () => {
    drag.current = null;
    setDragging(false);
  };
  return (
    <div
      className={`resize-handle ${side} ${dragging ? "dragging" : ""}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      title={`${label}: drag or use the arrow keys. Double-click to reset.`}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current)
          resize(
            drag.current.width + (event.clientX - drag.current.x) * direction,
          );
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        finish();
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() =>
        resize(side === "left" ? defaults.leftWidth : defaults.rightWidth)
      }
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10;
        if (event.key === "ArrowLeft") resize(width - step * direction);
        else if (event.key === "ArrowRight") resize(width + step * direction);
        else if (event.key === "Home") resize(min);
        else if (event.key === "End") resize(max);
        else return;
        event.preventDefault();
      }}
    />
  );
}
