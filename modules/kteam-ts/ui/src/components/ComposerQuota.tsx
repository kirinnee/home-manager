// Account usage (5-hour + weekly window) ON the composer's context line.
//
// The reader asked for the composer to show "the weekly and 5h-ly usage too" —
// the same numbers `kteam ps` renders in its QUOTA column (`7%/12%`) and the
// details sheet spells out in BudgetRows. This is the fixed-shape, single-line
// form of that fact, built for the desktop context strip's height contract:
//
//   - FIXED SHAPE. Both windows always render — `5h 7% · wk 12%`, with an
//     unknown side as `—` exactly like the strip's other fields — so a quota
//     arriving (or vanishing) can never change the composer's height. The
//     whole readout is `whitespace-nowrap shrink-0`: it is a token on the
//     non-wrapping line, never a wrapper.
//   - UNKNOWN IS NOT ZERO. API-key accounts and codex sessions have no quota
//     window; `kteam ps` shows them as `—` and so does this. A confident
//     "0% used" where the truth is "unknown" is worse than a blank. 0 itself
//     IS a real reading and renders as `0%`.
//   - AN AUTH FAILURE IS NOT A QUOTA. `authOk === false` means the wrapper
//     needs logging in — a different problem, said differently (`quota auth!`,
//     matching QuotaBadge), never dressed up as percentages.
//   - `7%/12%` ALONE IS A RIDDLE, so each number carries its window label
//     (`5h` / `wk`) and the title + spoken text spell both out in words.
//
// Same polarity and tone ramp as `ctx %` and QuotaBadge: percent USED, quiet
// until a window is actually running out (warn ≥75, err ≥90, err at limit).

import type { Quota } from '../lib/usage';
import { cn } from '../lib/utils';

/** Display form of one window's reading: honest but never impossible — the
 *  raw value may drift outside [0,100] between daemon ticks, the readout must
 *  not. Unknown stays unknown. */
export function quotaPercentLabel(pct: number | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  return `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
}

/** The tone a window's number takes. At-limit overrides everything: it is the
 *  state that stops work, not merely "a big number". */
function pctTone(pct: number | undefined, atLimit: boolean): string {
  if (atLimit) return 'text-err';
  if (pct == null) return 'text-faint';
  return pct >= 90 ? 'text-err' : pct >= 75 ? 'text-warn' : '';
}

/** The full-words form for the tooltip and screen readers, so `5h`/`wk` are
 *  never the only explanation the reader gets. Pure for the test matrix. */
export function composerQuotaSpoken(quota: Quota | null): string {
  if (quota?.authOk === false) {
    return 'account usage unavailable: this wrapper needs logging in';
  }
  const parts = [
    `5-hour window ${quota?.fiveHourPercent == null ? 'unknown' : `${quotaPercentLabel(quota.fiveHourPercent)} used`}`,
    `weekly window ${quota?.weeklyPercent == null ? 'unknown' : `${quotaPercentLabel(quota.weeklyPercent)} used`}`,
  ];
  if (quota?.atLimit === true) {
    parts.push('account AT LIMIT — work is blocked until the window resets');
  }
  return `account usage: ${parts.join(', ')}`;
}

/** `quota` null ⇒ nothing is known about this wrapper: the readout still
 *  renders, as `5h — · wk —`, because on the fixed-height context line an
 *  always-present token with honest dashes is the shape-stable form (the same
 *  contract as the strip's model/ctx/status fields). */
export function ComposerQuota({ quota, className }: { quota: Quota | null; className?: string }) {
  const authFailed = quota?.authOk === false;
  const atLimit = !authFailed && quota?.atLimit === true;
  const five = authFailed ? undefined : quota?.fiveHourPercent;
  const week = authFailed ? undefined : quota?.weeklyPercent;
  const spoken = composerQuotaSpoken(quota);

  return (
    <span
      data-density-region="composer-quota"
      className={cn('mono inline-flex shrink-0 items-center gap-xs whitespace-nowrap', className)}
      title={spoken}
    >
      {/* The visible tokens are abbreviations; the words live here and in the
          tooltip, so the pair is never announced as a bare riddle. */}
      <span className="sr-only">{spoken}</span>
      {authFailed ? (
        <span className="text-warn" aria-hidden="true">
          quota auth!
        </span>
      ) : (
        <span className="inline-flex items-center gap-xs" aria-hidden="true">
          <span className={pctTone(five, atLimit)}>5h {quotaPercentLabel(five)}</span>
          <span className="text-border">·</span>
          <span className={pctTone(week, atLimit)}>wk {quotaPercentLabel(week)}</span>
        </span>
      )}
    </span>
  );
}
