// Account quota (5-hour + weekly window) for the wrapper a session runs under.
//
// One rendering, used by the chat header, the fleet table, the session card and
// the folder sidebar, because "how much of this account is left" is the same
// fact everywhere. See lib/usage.ts for HOW a session's quota is resolved
// (session state when its monitor has stamped one, else the /v1/usage feed
// joined by wrapper binary). Numbers are percent USED — same polarity as
// context, so higher is worse.
//
// Three rules the daemon side already enforces and this must not undo:
//   - unknown is not zero. A wrapper with no usage record renders an explicit
//     "quota —", never a confident "0%".
//   - an auth failure is not a quota. `authOk === false` means the wrapper
//     needs logging in, which is a different problem and says so.
//   - AT LIMIT is not merely "100%". It is the state that stops work, so it
//     takes the one piece of real colour and weight in this component.
//
// Muted by default: this is reference information, not an alert. It only takes
// colour once a window is actually running out.

import type { Quota } from '../lib/usage';
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

function Unknown({ className }: { className: string }) {
  return (
    <span
      className={cn('mono shrink-0 text-faint', className)}
      title="kfleet reports no usage for this wrapper (API-key accounts have no quota window)"
    >
      quota —
    </span>
  );
}

/**
 * `quota` null ⇒ nothing is known about this wrapper.
 *
 * `showUnknown` decides what that means HERE. In a table cell or a sidebar row
 * the column exists either way, so an explicit em-dash is the honest fill; in
 * the chat header an absent readout should simply take no space.
 */
export function QuotaReadout({
  quota,
  className = '',
  showUnknown = false,
}: {
  quota: Quota | null;
  className?: string;
  showUnknown?: boolean;
}) {
  if (!quota) return showUnknown ? <Unknown className={className} /> : null;

  if (quota.authOk === false) {
    return (
      <span
        className={cn('mono shrink-0 text-warn', className)}
        title="this wrapper is not logged in — kfleet reports no usage"
      >
        quota auth!
      </span>
    );
  }

  const five = quota.fiveHourPercent;
  const week = quota.weeklyPercent;
  // At-limit with no percentages is still the most important thing to say, so
  // it is not folded into the unknown case.
  if (five == null && week == null && quota.atLimit !== true) {
    return showUnknown ? <Unknown className={className} /> : null;
  }

  const fiveIn = resetsIn(quota.fiveHourResetAt);
  const weekIn = resetsIn(quota.weeklyResetAt);
  const title = [
    five == null ? null : `5-hour window ${five}% used${fiveIn ? ` · resets in ${fiveIn}` : ''}`,
    week == null ? null : `weekly window ${week}% used${weekIn ? ` · resets in ${weekIn}` : ''}`,
    quota.atLimit ? 'this account is AT LIMIT — work is blocked until the window resets' : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span className={cn('mono inline-flex shrink-0 items-center gap-1', className)} title={title}>
      {five != null && <span className={tone(five)}>5h {five}%</span>}
      {five != null && week != null && <span className="text-border">·</span>}
      {week != null && <span className={tone(week)}>wk {week}%</span>}
      {quota.atLimit && (
        <span className="rounded-sm bg-err-bg px-1 font-semibold uppercase tracking-wide text-err">at limit</span>
      )}
    </span>
  );
}
