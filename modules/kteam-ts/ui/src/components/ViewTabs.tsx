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
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center rounded-md border border-border bg-surface-2 p-0.5 text-[12px]',
        className,
      )}
    >
      {tabs.map(tab => {
        const active = tab.id === current;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              'inline-flex items-center gap-1.5 h-6 px-2.5 rounded font-medium transition-colors',
              active
                ? 'bg-surface text-fg border border-border shadow-sm'
                : 'text-muted hover:text-fg border border-transparent',
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
