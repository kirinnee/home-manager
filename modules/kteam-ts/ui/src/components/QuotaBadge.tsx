// Account quota (5-hour + weekly window) for the wrapper a session runs under.
//
// One rendering, used by the chat header, the fleet table and the session card,
// because "how much of this account is left" is the same fact everywhere. The
// numbers come from the daemon's cached `kfleet usage` feed (see src/usage.ts);
// they are percent USED, same polarity as context.
//
// Two rules the daemon side already enforces and this must not undo:
//   - unknown is not zero. A wrapper with no usage record renders nothing at
//     all rather than a confident "0%".
//   - an auth failure is not a quota. `usageAuthOk === false` means the wrapper
//     needs logging in, which is a different problem and says so.
//
// Muted by default: this is reference information, not an alert. It only takes
// colour once a window is actually running out.

import type { SessionState } from '../types';
import { cn } from '../lib/utils';

/** Humanised time until a window rolls over: "47m", "3h 10m", "2d". */
function resetsIn(at?: number): string | null {
  if (at == null) return null;
  const ms = at - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h < 10 && m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function tone(pct: number): string {
  return pct >= 90 ? 'text-err' : pct >= 75 ? 'text-warn' : '';
}

export function hasQuota(state: SessionState): boolean {
  return state.usageAuthOk === false || state.usage5hPercent != null || state.usageWeeklyPercent != null;
}

export function QuotaReadout({ state, className = '' }: { state: SessionState; className?: string }) {
  if (state.usageAuthOk === false) {
    return (
      <span
        className={cn('mono shrink-0 text-warn', className)}
        title="this wrapper is not logged in — kfleet reports no usage"
      >
        quota auth!
      </span>
    );
  }
  const five = state.usage5hPercent;
  const week = state.usageWeeklyPercent;
  if (five == null && week == null) return null;

  const fiveIn = resetsIn(state.usage5hResetAt);
  const weekIn = resetsIn(state.usageWeeklyResetAt);
  const title = [
    five == null ? null : `5-hour window ${five}% used${fiveIn ? ` · resets in ${fiveIn}` : ''}`,
    week == null ? null : `weekly window ${week}% used${weekIn ? ` · resets in ${weekIn}` : ''}`,
    state.usageAtLimit ? 'this account is AT LIMIT' : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span className={cn('mono inline-flex shrink-0 items-center gap-1', className)} title={title}>
      {five != null && <span className={tone(five)}>5h {five}%</span>}
      {five != null && week != null && <span className="text-border">·</span>}
      {week != null && <span className={tone(week)}>wk {week}%</span>}
      {state.usageAtLimit && <span className="font-semibold text-err">at limit</span>}
    </span>
  );
}
