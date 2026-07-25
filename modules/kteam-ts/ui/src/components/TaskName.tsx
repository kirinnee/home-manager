// THE TASK — `config.name`, rendered.
//
// `--name` is documented to the CLI's callers as "a succinct summary of what
// this session is supposed to do", so it is the single most useful string about
// a session and it belongs wherever a session is listed. The core now writes
// `[Hayden] Fix the Transcript scroller`-shaped values: a bracketed TEAMMATE
// prefix followed by the actual task.
//
// The parse is deliberately conservative — ONE leading `[…]` group, no nesting,
// nothing anywhere else in the string:
//
//   "[Hayden] Fix the scroller"  → chip "Hayden" + task "Fix the scroller"
//   "Fix the scroller"           → task only (the overwhelmingly common case
//                                  for hand-launched sessions)
//   "[Hayden]"                   → the bracket content IS the task; rendering an
//                                  empty cell next to a chip would be worse than
//                                  rendering the one fact we have
//   "fix [Hayden] later"         → left ALONE. A bracket mid-string is prose, and
//                                  a regex greedy enough to find it would mangle
//                                  markdown-ish task names.
//   ""/undefined                 → an explicit em dash, never a blank cell
//
// The chip is tokenised (`--surface-3`/`--muted`) rather than accent-coloured:
// the teammate is context for the task, not the headline.

import { cn } from '../lib/utils';

const BRACKET_PREFIX = /^\[([^[\]]+)\]\s*(.*)$/s;

export interface ParsedTask {
  /** Bracketed prefix, when the value had one AND had a task after it. */
  prefix: string | null;
  /** The task text. Empty only when `config.name` itself was empty. */
  task: string;
}

export function parseTaskName(name?: string | null): ParsedTask {
  const raw = (name ?? '').trim();
  if (!raw) return { prefix: null, task: '' };
  const m = BRACKET_PREFIX.exec(raw);
  if (!m) return { prefix: null, task: raw };
  const prefix = (m[1] ?? '').trim();
  const rest = (m[2] ?? '').trim();
  // `[Hayden]` on its own: promote the bracket content to the task rather than
  // showing a chip with nothing beside it.
  if (!rest) return { prefix: null, task: prefix || raw };
  return { prefix: prefix || null, task: rest };
}

/** True when the task string says nothing the teammate name did not already
 *  say — used by callers that render both and want to skip the duplicate. */
export function taskIsRedundant(name: string | undefined, teammate: string | undefined): boolean {
  const { task } = parseTaskName(name);
  if (!task) return true;
  return !!teammate && task.toLowerCase() === teammate.trim().toLowerCase();
}

export function TaskName({
  name,
  teammate,
  className = '',
  /** Hide the `[Bracket]` chip when the surrounding row already names the
   *  teammate — the sidebar row does, so repeating it twice per row is noise. */
  showPrefix = true,
  /** `sm` is the sidebar/card weight; `md` is the dashboard TASK column. */
  size = 'md',
}: {
  name?: string | null;
  teammate?: string;
  className?: string;
  showPrefix?: boolean;
  size?: 'sm' | 'md';
}) {
  const { prefix, task } = parseTaskName(name);
  const title = [prefix ? `[${prefix}]` : null, task].filter(Boolean).join(' ');

  if (!task) {
    return (
      <span className={cn('text-faint', className)} title="this session was launched without a --name">
        —
      </span>
    );
  }

  const chipVisible = showPrefix && prefix && prefix.toLowerCase() !== (teammate ?? '').trim().toLowerCase();

  return (
    <span className={cn('inline-flex min-w-0 items-baseline gap-1.5', className)} title={title}>
      {chipVisible && (
        <span
          className={cn(
            'shrink-0 rounded border border-border-soft bg-surface-3 px-1 font-medium text-muted',
            size === 'sm' ? 'text-[10px]' : 'text-[10.5px]',
          )}
        >
          {prefix}
        </span>
      )}
      <span className={cn('min-w-0 truncate text-fg', size === 'sm' ? 'text-[12.5px]' : 'text-[13px] font-medium')}>
        {task}
      </span>
    </span>
  );
}
