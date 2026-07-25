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
}

export function ViewTabs<T extends string>({ tabs, current, onChange, className }: Props<T>) {
  return (
    // The track keeps its own geometry; each tab is `.kt-tab`, which owns the
    // height, padding, radius, casing, font and selected treatment per theme —
    // pills in Ember, notched mono caps in Mission, hard blocks in Neo. Nothing
    // here knows which.
    <div
      role="tablist"
      className={cn('inline-flex items-center rounded-control border border-border bg-surface-2 p-0.5', className)}
    >
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === current}
          onClick={() => onChange(tab.id)}
          className="kt-tab"
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
