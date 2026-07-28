// ACCESSIBLE, THROTTLED resize control for the desktop side pane.
//
// Pointer motion previews at most once per RESIZE_THROTTLE_MS, limiting chat
// reflow while dragging. Persistence is outside this component and receives
// exactly one onCommit call when the drag ends. Keyboard commands commit one
// deliberate step at a time.

import { useEffect, useRef, useState } from 'react';
import {
  SIDE_PANE_DEFAULT_WIDTH,
  SIDE_PANE_MAX_WIDTH,
  SIDE_PANE_MIN_CHAT_WIDTH,
  SIDE_PANE_MIN_WIDTH,
  SIDE_PANE_WORKSPACE_GAP,
} from '../lib/side-pane-preferences';

export const RESIZE_THROTTLE_MS = 50;
export const RESIZE_KEY_STEP = 16;
export const RESIZE_KEY_LARGE_STEP = 64;

export interface SidePaneWidthBounds {
  min: number;
  max: number;
}

/** Preserve a readable chat column before honoring the pane's absolute max.
 * Desktop layout guarantees enough room for the 320px minimum (the mobile
 * breakpoint uses a bottom sheet instead). */
export function sidePaneWidthBounds(workspaceWidth: number): SidePaneWidthBounds {
  const available = Math.floor(workspaceWidth - SIDE_PANE_MIN_CHAT_WIDTH - SIDE_PANE_WORKSPACE_GAP);
  return {
    min: SIDE_PANE_MIN_WIDTH,
    max: Math.max(SIDE_PANE_MIN_WIDTH, Math.min(SIDE_PANE_MAX_WIDTH, available)),
  };
}

function clampToBounds(width: number, bounds: SidePaneWidthBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

/** The pane is on the right: moving the separator left makes it wider. */
export function sidePaneWidthFromPointer(
  startWidth: number,
  startClientX: number,
  clientX: number,
  bounds: SidePaneWidthBounds,
): number {
  return clampToBounds(startWidth + startClientX - clientX, bounds);
}

export function sidePaneWidthFromKey(
  key: string,
  currentWidth: number,
  bounds: SidePaneWidthBounds,
  largeStep = false,
): number | null {
  const step = largeStep ? RESIZE_KEY_LARGE_STEP : RESIZE_KEY_STEP;
  switch (key) {
    case 'ArrowLeft':
      return clampToBounds(currentWidth + step, bounds);
    case 'ArrowRight':
      return clampToBounds(currentWidth - step, bounds);
    case 'Home':
      return bounds.min;
    case 'End':
      return bounds.max;
    default:
      return null;
  }
}

interface DragState {
  pointerId: number;
  startClientX: number;
  startWidth: number;
  bounds: SidePaneWidthBounds;
  pendingWidth: number;
  moved: boolean;
  lastPreviewAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

function elementGeometry(handle: HTMLButtonElement): { width: number; bounds: SidePaneWidthBounds } {
  const pane = handle.parentElement;
  const workspace = pane?.parentElement;
  const width = pane?.getBoundingClientRect().width ?? SIDE_PANE_DEFAULT_WIDTH;
  const workspaceWidth =
    workspace?.getBoundingClientRect().width ??
    SIDE_PANE_MAX_WIDTH + SIDE_PANE_MIN_CHAT_WIDTH + SIDE_PANE_WORKSPACE_GAP;
  return { width, bounds: sidePaneWidthBounds(workspaceWidth) };
}

export function SidePaneResizeHandle({
  width,
  onPreview,
  onCommit,
  bounds: suppliedBounds,
}: {
  width: number;
  onPreview: (width: number) => void;
  onCommit: (width: number) => void;
  /** Optional deterministic test/embed bound. The normal workspace observes
   * its actual width and keeps ARIA synchronized as that width changes. */
  bounds?: SidePaneWidthBounds;
}) {
  const dragRef = useRef<DragState | null>(null);
  const handleRef = useRef<HTMLButtonElement | null>(null);
  const [observedBounds, setObservedBounds] = useState<SidePaneWidthBounds>(() =>
    sidePaneWidthBounds(SIDE_PANE_MAX_WIDTH + SIDE_PANE_MIN_CHAT_WIDTH + SIDE_PANE_WORKSPACE_GAP),
  );
  const accessibleBounds = suppliedBounds ?? observedBounds;

  useEffect(() => {
    if (suppliedBounds) return;
    const handle = handleRef.current;
    const workspace = handle?.parentElement?.parentElement;
    if (!handle || !workspace) return;
    const update = () => setObservedBounds(elementGeometry(handle).bounds);
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [suppliedBounds]);

  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag?.timer) clearTimeout(drag.timer);
      dragRef.current = null;
    },
    [],
  );

  const preview = (drag: DragState, nextWidth: number) => {
    drag.pendingWidth = nextWidth;
    const now = Date.now();
    const remaining = RESIZE_THROTTLE_MS - (now - drag.lastPreviewAt);
    if (remaining <= 0) {
      if (drag.timer) clearTimeout(drag.timer);
      drag.timer = null;
      drag.lastPreviewAt = now;
      onPreview(nextWidth);
      return;
    }
    if (drag.timer) return;
    drag.timer = setTimeout(() => {
      if (dragRef.current !== drag) return;
      drag.timer = null;
      drag.lastPreviewAt = Date.now();
      onPreview(drag.pendingWidth);
    }, remaining);
  };

  const finish = (element: HTMLButtonElement, pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    if (drag.timer) clearTimeout(drag.timer);
    drag.timer = null;
    dragRef.current = null;
    if (!drag.moved) {
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      return;
    }
    onPreview(drag.pendingWidth);
    onCommit(drag.pendingWidth);
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  };

  return (
    <button
      ref={handleRef}
      type="button"
      role="separator"
      aria-label="Resize session side pane"
      aria-orientation="vertical"
      aria-valuemin={accessibleBounds.min}
      aria-valuemax={accessibleBounds.max}
      aria-valuenow={clampToBounds(width, accessibleBounds)}
      aria-valuetext={`${clampToBounds(width, accessibleBounds)} pixels; constrained to keep the conversation readable`}
      title="Resize side pane (Left/Right arrows; Shift for larger steps; double-click to reset)"
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const geometry = elementGeometry(event.currentTarget);
        const startWidth = clampToBounds(geometry.width, geometry.bounds);
        dragRef.current = {
          pointerId: event.pointerId,
          startClientX: event.clientX,
          startWidth,
          bounds: geometry.bounds,
          pendingWidth: startWidth,
          moved: false,
          // The first meaningful motion previews immediately; subsequent
          // pointer events coalesce behind the 50ms gate.
          lastPreviewAt: 0,
          timer: null,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        const next = sidePaneWidthFromPointer(drag.startWidth, drag.startClientX, event.clientX, drag.bounds);
        if (next === drag.pendingWidth) return;
        drag.moved = true;
        preview(drag, next);
      }}
      onPointerUp={event => finish(event.currentTarget, event.pointerId)}
      onPointerCancel={event => finish(event.currentTarget, event.pointerId)}
      onLostPointerCapture={event => finish(event.currentTarget, event.pointerId)}
      onKeyDown={event => {
        const geometry = elementGeometry(event.currentTarget);
        const next = sidePaneWidthFromKey(event.key, geometry.width, geometry.bounds, event.shiftKey);
        if (next === null) return;
        event.preventDefault();
        onPreview(next);
        onCommit(next);
      }}
      onDoubleClick={event => {
        const reset = clampToBounds(SIDE_PANE_DEFAULT_WIDTH, elementGeometry(event.currentTarget).bounds);
        onPreview(reset);
        onCommit(reset);
      }}
      className="group absolute inset-y-0 left-0 z-30 flex w-4 -translate-x-1/2 touch-none cursor-col-resize items-center justify-center border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span
        aria-hidden="true"
        className="h-full w-px bg-border-strong transition-colors group-hover:bg-accent group-focus-visible:bg-accent"
      />
    </button>
  );
}
