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
  /** Drop the visible word and keep the icon.
   *
   *  This exists for ONE reason: on a phone the session header is a single
   *  nowrap row that also has to hold a back/identity target, the drawer
   *  trigger, the theme picker and the session-actions overflow, all at a 44px
   *  touch floor. `CHAT`/`TERMINAL` spelled out costs ~96px of that row and is
   *  what forced it to wrap onto a second line. The name is not lost — it moves
   *  to `aria-label` and `title`, so assistive tech and a long-press both still
   *  say "Terminal", and `aria-pressed` still carries the state. */
  iconOnly?: boolean;
}

// This is a view-mode switcher, NOT a WAI-ARIA tab pattern: the buttons do not
// own `role="tabpanel"` regions and there is no roving tabindex, so claiming
// `role="tablist"`/`role="tab"` made AT announce "tab 1 of 3" and then arrow
// keys did nothing (a11y report M-2). It is an honest labelled group of toggle
// buttons instead — each carries `aria-pressed`, and native Tab/Space/Enter is
// then exactly right. Selection visuals are unchanged: `.kt-tab` keys its
// selected treatment off `[aria-pressed='true']` as well as `[aria-selected]`.
export function ViewTabs<T extends string>({
  tabs,
  current,
  onChange,
  className,
  label = 'View mode',
  iconOnly,
}: Props<T>) {
  return (
    // The track keeps its own geometry; each tab is `.kt-tab`, which owns the
    // height, padding, radius, casing, font and selected treatment per theme —
    // pills in Ember, notched mono caps in Mission, hard blocks in Neo. Nothing
    // here knows which.
    <div
      role="group"
      aria-label={label}
      className={cn(
        'inline-flex items-center rounded-control border border-border bg-surface-2',
        // The track's vertical inset is 4px of a phone header that has a hard
        // 52px budget and a 44px button inside it — it is the difference between
        // one row and one row plus a rounding error. The horizontal inset and the
        // border stay: they are what makes the pair read as one segmented control.
        iconOnly ? 'px-0.5 py-0' : 'p-0.5',
        className,
      )}
    >
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          aria-pressed={tab.id === current}
          aria-label={iconOnly ? tab.label : undefined}
          title={iconOnly ? tab.label : undefined}
          onClick={() => onChange(tab.id)}
          className="kt-tab"
        >
          {tab.icon}
          {!iconOnly && tab.label}
        </button>
      ))}
    </div>
  );
}
