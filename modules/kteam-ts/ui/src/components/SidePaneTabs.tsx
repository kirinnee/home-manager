// EXPLORER-STYLE tabs for the unified session side pane.
//
// This deliberately reuses the settled `.kt-sheet-tabs .kt-tab` visual
// vocabulary from the details bottom sheet: a shared baseline, muted inactive
// tabs and one accent underline. The full surface set fits without resurrecting
// the old horizontal scroller by using an icon plus a short visible label;
// every tab's full surface name remains its accessible name and tooltip.

import { useRef, type ReactNode } from 'react';

export interface SidePaneTabSpec<T extends string> {
  key: T;
  /** Full accessible name. */
  label: string;
  /** Compact visible name; the full label remains exposed to AT. */
  shortLabel: string;
  icon: ReactNode;
}

export function sidePaneTabId(paneId: string, surface: string): string {
  return `${paneId}-tab-${surface}`;
}

export function sidePanePanelId(paneId: string, surface: string): string {
  return `${paneId}-tabpanel-${surface}`;
}

/** WAI-ARIA tab keyboard policy. Focus movement is invoked only from the
 * strip's own key handler, never when a surface opens through another trigger. */
export function nextSidePaneTab<T extends string>(key: string, current: T, order: readonly T[]): T | null {
  const index = order.indexOf(current);
  if (index === -1 || order.length === 0) return null;
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

export function SidePaneTabs<T extends string>({
  paneId,
  tabs,
  current,
  onSelect,
}: {
  paneId: string;
  tabs: readonly SidePaneTabSpec<T>[];
  current: T;
  onSelect: (surface: T) => void;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const order = tabs.map(tab => tab.key);

  return (
    <div
      role="tablist"
      aria-label="Session explorer"
      className="kt-sheet-tabs flex shrink-0 items-stretch border-b border-border-soft"
    >
      {tabs.map(tab => {
        const selected = tab.key === current;
        return (
          <button
            key={tab.key}
            ref={element => {
              if (element) refs.current.set(tab.key, element);
              else refs.current.delete(tab.key);
            }}
            type="button"
            role="tab"
            id={sidePaneTabId(paneId, tab.key)}
            aria-label={tab.label}
            aria-selected={selected}
            aria-controls={sidePanePanelId(paneId, tab.key)}
            tabIndex={selected ? 0 : -1}
            title={tab.label}
            onClick={() => {
              if (!selected) onSelect(tab.key);
            }}
            onKeyDown={event => {
              const next = nextSidePaneTab(event.key, tab.key, order);
              if (next === null) return;
              event.preventDefault();
              onSelect(next);
              // This is direct keyboard navigation inside the strip. External
              // opens and tab changes never run this focus movement.
              requestAnimationFrame(() => refs.current.get(next)?.focus());
            }}
            className="kt-tab min-h-[44px] min-w-0 flex-1 !flex-col justify-center !gap-0 px-0"
          >
            {tab.icon}
            <span aria-hidden="true" className="max-w-full truncate text-2xs leading-tight">
              {tab.shortLabel}
            </span>
          </button>
        );
      })}
    </div>
  );
}
