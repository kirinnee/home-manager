import type { TaskStatus } from '../lib/tasks';
import { TASK_STATUS_META } from '../lib/tasks';
import { orderedTaskStatuses } from '../lib/task-views';
import { cn } from '../lib/utils';
import './task-views.css';

export function TaskStatusFilter({
  counts,
  selected,
  onSelect,
  onShowAll,
}: {
  counts: ReadonlyMap<TaskStatus, number>;
  selected: ReadonlySet<TaskStatus> | null;
  onSelect: (status: TaskStatus) => void;
  onShowAll: () => void;
}) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return (
    <div
      data-task-status-filter
      className="flex gap-xs overflow-x-auto overscroll-x-contain pb-1 scroll-thin"
      role="group"
      aria-label="Filter tasks by status"
    >
      <button
        type="button"
        aria-pressed={selected === null}
        onClick={onShowAll}
        className={cn(
          'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center gap-xs rounded-control border px-2 text-2xs font-semibold',
          selected === null
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-border-soft bg-surface text-muted hover:border-accent-border hover:text-fg',
        )}
      >
        All <span className="mono text-faint">{total}</span>
      </button>
      {orderedTaskStatuses(counts, selected).map(status => {
        const active = selected?.has(status) ?? false;
        const count = counts.get(status) ?? 0;
        const { label, tone } = TASK_STATUS_META[status];
        return (
          // Each chip wears its status tone: a dot at rest (previewing the rail
          // colour the rows use), the full tone treatment when selected — so an
          // active filter reads as "these colours are showing", not a generic
          // accent press.
          <button
            key={status}
            type="button"
            data-tone={tone}
            aria-pressed={active}
            aria-label={`${label}, ${count} ${count === 1 ? 'task' : 'tasks'}`}
            title={active ? `Remove ${label} from the filter` : `Show ${label} tasks`}
            onClick={() => onSelect(status)}
            className={cn(
              'kt-task-tone inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center gap-xs rounded-control border px-2 text-2xs font-semibold',
              active
                ? 'kt-task-chip-active'
                : 'border-border-soft bg-surface text-muted hover:border-accent-border hover:text-fg',
            )}
          >
            <span className="kt-task-tone-dot" aria-hidden="true" />
            {label} <span className={cn('mono', active ? 'kt-task-tone-ink' : 'text-faint')}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}
