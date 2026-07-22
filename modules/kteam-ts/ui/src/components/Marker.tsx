// Marker — slim, low-emphasis rows for the transcript: status updates, tool
// activity, system notes, and labeled separators. Implements the intent of
// shadcn's `Marker` in-tree (only `message-scroller` ships as a headless
// package; the styled registry components require a full shadcn init that
// would take over our CSS variables, so these stay hand-rolled to match the
// transcript's calm palette).

import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

/** A labeled center divider, e.g. turn boundaries or date breaks. */
export function MarkerSeparator({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'faint' }) {
  return (
    <div className="flex items-center gap-3 py-1 select-none">
      <span className="h-px flex-1 bg-border-soft" />
      <span
        className={cn(
          'text-[10.5px] uppercase tracking-[0.14em] font-medium',
          tone === 'faint' ? 'text-faint' : 'text-muted',
        )}
      >
        {children}
      </span>
      <span className="h-px flex-1 bg-border-soft" />
    </div>
  );
}

/** A single slim status line with a leading dot/icon. Used for the running
 *  tool indicator, system notices, and the thinking summary. */
export function MarkerLine({
  icon,
  children,
  onClick,
  title,
  className,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  className?: string;
}) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-muted',
        onClick && 'hover:bg-surface-2 transition-colors',
        className,
      )}
    >
      {icon && <span className="shrink-0 text-faint group-hover:text-muted">{icon}</span>}
      <span className="min-w-0 flex-1">{children}</span>
    </Comp>
  );
}
