// THE SHARED CONTEXT MENU — one primitive, used by two surfaces.
//
// The sidebar's session-row actions (right-click / long-press a teammate to
// Stop, Resume, Migrate…) and the transcript's "Quote a selection" both open
// THIS menu. It is written once: the two surfaces differ only in what TRIGGERS
// it (a row press vs. a text selection) and what ITEMS it carries, both passed
// in as props. Nothing here knows about sessions or quoting.
//
// WHAT IT OWES THE READER, and where each piece is:
//   - POSITIONED ON SCREEN. Opens at the trigger point, but flips and clamps so
//     it is never off the edge at 360px (clampMenuPosition, pure + tested).
//   - KEYBOARD. Menu-button ARIA pattern: roving focus, Up/Down/Home/End move,
//     Enter/Space activate, Escape closes, Tab closes. Focus lands on the first
//     item on open and returns to the trigger on a keyboard dismiss.
//   - ESCAPE IS A STACK. Shares the app's ESCAPE_LAYERS (useDialogFocus) so a
//     menu opened over a sheet takes Escape without closing the sheet under it.
//   - DISMISSES on outside pointer, on any scroll, on resize, and on a route
//     change (popstate) — a menu anchored to a point must not linger once that
//     point moves or the page navigates.
//   - THE NATIVE MENU IS NOT GLOBALLY SUPPRESSED. The trigger sites decide when
//     to preventDefault the browser's own contextmenu; this component only draws
//     the replacement once they ask for it.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/utils';
import { isTopEscapeLayer, pushEscapeLayer } from '../hooks/useDialogFocus';

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Destructive tone (Stop, Migrate). Colour is reinforcement — the word says it. */
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuAnchor {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

interface Viewport {
  width: number;
  height: number;
}

/** Keep an anchored menu fully on screen.
 *
 *  Opens with its top-left at the anchor, but flips LEFT when it would overflow
 *  the right edge and UP when it would overflow the bottom (so a press near a
 *  corner opens back toward the middle rather than off-screen), then clamps to
 *  `margin` from every edge as the final guarantee. A menu larger than the
 *  viewport is pinned to the top-left margin rather than pushed off the top.
 *  Pure so the placement is asserted without a DOM (ContextMenu.test.tsx). */
export function clampMenuPosition(
  anchor: MenuAnchor,
  size: Size,
  viewport: Viewport,
  margin = 8,
): { left: number; top: number } {
  let left = anchor.x;
  let top = anchor.y;
  if (left + size.width + margin > viewport.width) left = anchor.x - size.width;
  if (top + size.height + margin > viewport.height) top = anchor.y - size.height;
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  left = Math.min(Math.max(margin, left), maxLeft);
  top = Math.min(Math.max(margin, top), maxTop);
  return { left, top };
}

/** Move the roving focus index to the next enabled item in `direction`, wrapping
 *  at the ends. Returns the same index when every item is disabled. Pure so the
 *  arrow-key contract is testable without a DOM. */
export function nextEnabledIndex(items: ContextMenuItem[], from: number, direction: 1 | -1): number {
  if (items.length === 0) return from;
  for (let step = 1; step <= items.length; step++) {
    const idx = (from + direction * step + items.length * step) % items.length;
    if (!items[idx]?.disabled) return idx;
  }
  return from;
}

/** First enabled item, or 0 when all are disabled. */
export function firstEnabledIndex(items: ContextMenuItem[]): number {
  const idx = items.findIndex(item => !item.disabled);
  return idx < 0 ? 0 : idx;
}

export interface ContextMenuProps {
  open: boolean;
  anchor: MenuAnchor;
  items: ContextMenuItem[];
  onClose: () => void;
  ariaLabel: string;
  /** The element that opened the menu; keyboard dismissal returns focus to it. */
  triggerRef?: { current: HTMLElement | null };
  /** Coarse pointer: rows take the 44px touch floor. */
  touch?: boolean;
}

export function ContextMenu({ open, anchor, items, onClose, ariaLabel, triggerRef, touch }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(0);
  const layer = useRef<object>({});
  /** True only when the close should hand focus back to the trigger — a keyboard
   *  dismiss (Escape/Tab). An item that moves focus itself (Quote → composer) or
   *  an outside tap must NOT yank it back. */
  const restoreOnClose = useRef(false);
  const restoreTarget = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    onClose();
  }, [onClose]);

  // Global dismissal + Escape stacking, live only while open.
  useEffect(() => {
    if (!open) return;
    const token = layer.current;
    const release = pushEscapeLayer(token);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!isTopEscapeLayer(token)) return;
      event.stopPropagation();
      restoreOnClose.current = true;
      close();
    };
    const onScroll = () => close();
    const onResize = () => close();
    const onNav = () => close();
    document.addEventListener('keydown', onKey);
    // Capture, so a scroll in ANY inner scroller (the session list, the
    // transcript) dismisses — the menu is anchored to a point that just moved.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('popstate', onNav);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('popstate', onNav);
      release();
    };
  }, [open, close]);

  // Capture the opener and pick the first enabled item on each open.
  useLayoutEffect(() => {
    if (!open) return;
    restoreTarget.current = triggerRef?.current ?? (document.activeElement as HTMLElement | null);
    restoreOnClose.current = false;
    setActive(firstEnabledIndex(items));
    setPos(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, anchor.x, anchor.y]);

  // Measure, then clamp on screen — before paint, so it never flashes off-edge.
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el || typeof window === 'undefined') return;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    setPos(clampMenuPosition(anchor, size, { width: window.innerWidth, height: window.innerHeight }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, anchor.x, anchor.y, items.length]);

  // Move DOM focus to the active item once it is on screen (positioned).
  useEffect(() => {
    if (!open || !pos) return;
    const nodes = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    nodes?.[active]?.focus();
  }, [open, pos, active]);

  // Return focus to the trigger on a keyboard dismiss only.
  useEffect(() => {
    if (open) return;
    if (!restoreOnClose.current) return;
    restoreOnClose.current = false;
    const target = restoreTarget.current;
    restoreTarget.current = null;
    if (target && typeof target.focus === 'function' && document.contains(target)) target.focus();
  }, [open]);

  if (!open) return null;

  const activate = (item: ContextMenuItem) => {
    if (item.disabled) return;
    // The action decides where focus goes next (a sheet, the composer), so a
    // pointer/keyboard activation does not restore to the trigger.
    restoreOnClose.current = false;
    close();
    item.onSelect();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive(i => nextEnabledIndex(items, i, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive(i => nextEnabledIndex(items, i, -1));
        break;
      case 'Home':
        event.preventDefault();
        setActive(firstEnabledIndex(items));
        break;
      case 'End':
        event.preventDefault();
        setActive(nextEnabledIndex(items, firstEnabledIndex(items), -1));
        break;
      case 'Tab':
        // A menu does not trap Tab; it closes and lets focus move on.
        event.preventDefault();
        restoreOnClose.current = true;
        close();
        break;
      case 'Enter':
      case ' ':
      case 'Spacebar': {
        event.preventDefault();
        const item = items[active];
        if (item) activate(item);
        break;
      }
    }
  };

  return (
    <>
      {/* Outside-dismiss surface. A real button so a tap or a keyboard activation
          both close, and a reader meets something named. It does NOT restore
          focus to the trigger (an outside tap is not a keyboard dismiss). */}
      <button
        type="button"
        aria-label="Close menu"
        tabIndex={-1}
        onPointerDown={() => close()}
        onContextMenu={event => {
          event.preventDefault();
          close();
        }}
        className="fixed inset-0 z-50 cursor-default"
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={ariaLabel}
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        style={{ left: pos?.left ?? anchor.x, top: pos?.top ?? anchor.y, visibility: pos ? 'visible' : 'hidden' }}
        className="kt-panel fixed z-50 min-w-[196px] max-w-[min(280px,calc(100vw-16px))] overflow-hidden p-1 font-ui shadow-popover"
      >
        {items.map((item, index) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            tabIndex={index === active ? 0 : -1}
            disabled={item.disabled}
            onClick={() => activate(item)}
            onPointerEnter={() => !item.disabled && setActive(index)}
            className={cn(
              'flex w-full items-center gap-sm rounded-control px-cell-x text-left text-ui',
              touch ? 'min-h-[44px]' : 'min-h-[34px] py-1',
              'text-fg-soft hover:bg-surface-2 focus:bg-surface-2 focus:outline-none',
              item.danger && 'text-err hover:text-err focus:text-err',
              item.disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
            )}
          >
            {item.icon && <span className="shrink-0">{item.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
