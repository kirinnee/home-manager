// Small segmented control used to switch between views on a page (e.g.
// Chat | Terminal on the session page). Hand-rolled to stay consistent with
// the rest of the in-tree primitives — no shadcn dependency, no separate
// Tab primitive module.

import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

export interface TabSpec<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
}

interface Props<T extends string> {
  tabs: TabSpec<T>[];
  current: T;
  onChange: (id: T) => void;
  className?: string;
  /** Accessible name for the button group. */
  label?: string;
  /** Legacy caller compatibility. The phone switch now lives in the details
   * sheet, where both visible labels fit and icon-only ambiguity is needless. */
  iconOnly?: boolean;
}

// This is a view-mode switcher, NOT a WAI-ARIA tab pattern: the buttons do not
// own `role="tabpanel"` regions and there is no roving tabindex, so claiming
// `role="tablist"`/`role="tab"` made AT announce "tab 1 of 3" and then arrow
// keys did nothing (a11y report M-2). It is an honest labelled group of toggle
// buttons instead — each carries `aria-pressed`, and native Tab/Space/Enter is
// then exactly right. Selection visuals are unchanged: `.kt-tab` keys its
// selected treatment off `[aria-pressed='true']` as well as `[aria-selected]`.
export function ViewTabs<T extends string>({ tabs, current, onChange, className, label = 'View mode' }: Props<T>) {
  return (
    // The track keeps its own geometry; each tab is `.kt-tab`, which owns the
    // height, padding, radius, casing, font and selected treatment per theme —
    // pills in Ember, notched mono caps in Mission, hard blocks in Neo. Nothing
    // here knows which.
    <div
      role="group"
      aria-label={label}
      className={cn('inline-flex items-center rounded-control border border-border bg-surface-2 p-0.5', className)}
    >
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          aria-pressed={tab.id === current}
          onClick={() => onChange(tab.id)}
          className="kt-tab justify-center"
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
