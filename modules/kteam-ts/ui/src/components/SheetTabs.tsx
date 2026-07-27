// The details sheet's tab strip — real WAI-ARIA tabs.
//
// This IS a tab pattern (unlike ViewTabs, which is an honest toggle group): each
// button owns `role="tab"` + `aria-controls` pointing at a `role="tabpanel"`,
// there is a roving tabindex, and arrow keys move focus AND selection. It earns
// the pattern because there really are panels being swapped and only the
// selected one is in the DOM.
//
// IDs are derived from the sheet's own instance id (`SessionHeader` mints it with
// useId()), so two retained session panes can never collide on tab/panel ids.

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../lib/utils';

export interface SheetTabSpec<T extends string> {
  key: T;
  label: string;
  icon?: ReactNode;
}

/** Pure keyboard policy, exported so it unit-tests without a DOM. ArrowLeft/Right
 *  step with wrap; Home/End jump to the ends; anything else yields null (the
 *  caller leaves the event to the browser). */
export function nextDetailsTab<T extends string>(key: string, current: T, order: readonly T[]): T | null {
  const index = order.indexOf(current);
  if (index === -1) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return order[(index + 1) % order.length]!;
    case 'ArrowLeft':
    case 'ArrowUp':
      return order[(index - 1 + order.length) % order.length]!;
    case 'Home':
      return order[0]!;
    case 'End':
      return order[order.length - 1]!;
    default:
      return null;
  }
}

export function sheetTabId(sheetId: string, key: string): string {
  return `${sheetId}-tab-${key}`;
}

export function sheetPanelId(sheetId: string, key: string): string {
  return `${sheetId}-tabpanel-${key}`;
}

export function SheetTabs<T extends string>({
  sheetId,
  tabs,
  current,
  order,
  onChange,
  label = 'Session details sections',
}: {
  sheetId: string;
  tabs: SheetTabSpec<T>[];
  current: T;
  order: readonly T[];
  onChange: (key: T) => void;
  label?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());

  // After a selection change (arrow OR click) the newly selected tab takes focus
  // and scrolls back into the strip — the strip scrolls horizontally at phone
  // widths (four labels do not always fit), so a keyboard user must never lose
  // the selected tab off-screen. Default (non-smooth) scroll needs no
  // reduced-motion special case.
  const focusSelected = () => {
    const el = refs.current.get(current);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  // Keep the focused tab in view when selection changes via keyboard. Click
  // handlers call focusSelected() imperatively after onChange commits.
  useEffect(() => {
    // Only pull focus back if a tab in this strip already holds it — never steal
    // focus from the panel or elsewhere on an unrelated re-render.
    const active = document.activeElement;
    for (const el of refs.current.values()) {
      if (el === active) {
        const selected = refs.current.get(current);
        selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        selected?.focus();
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  return (
    <div
      role="tablist"
      aria-label={label}
      className="kt-sheet-tabs flex items-center gap-xs overflow-x-auto border-b border-border-soft px-panel scroll-thin"
    >
      {tabs.map(tab => {
        const selected = tab.key === current;
        return (
          <button
            key={tab.key}
            ref={el => {
              if (el) refs.current.set(tab.key, el);
              else refs.current.delete(tab.key);
            }}
            type="button"
            role="tab"
            id={sheetTabId(sheetId, tab.key)}
            aria-selected={selected}
            aria-controls={sheetPanelId(sheetId, tab.key)}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!selected) onChange(tab.key);
            }}
            onKeyDown={event => {
              const next = nextDetailsTab(event.key, tab.key, order);
              if (next === null) return;
              event.preventDefault();
              onChange(next);
              // Focus follows selection; the next render's ref holds the target.
              requestAnimationFrame(focusSelected);
            }}
            className={cn('kt-tab shrink-0 justify-center')}
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
