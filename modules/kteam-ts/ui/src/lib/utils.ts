// Miscellaneous helpers: classnames, time formatting, status styling.

import { clsx, type ClassValue } from 'clsx';
import { formatDistanceToNow, format } from 'date-fns';
import type { SessionView } from '../types';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export function fmtAbsolute(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return format(d, 'yyyy-MM-dd HH:mm:ss');
}

export function fmtRelative(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return formatDistanceToNow(d, { addSuffix: true });
}

export function fmtClock(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return format(d, 'HH:mm:ss');
}

// Map a session status to a "tone" used by the badge — kept terse on purpose.
export type Tone = 'ok' | 'warn' | 'err' | 'pend' | 'accent';
export function toneFor(status: string): Tone {
  const s = String(status).toLowerCase();
  if (/(completed|awaiting_user|interrupted|healthy|awaiting_user|ready|done)/.test(s)) return 'ok';
  if (/(failed|stalled|stopped|kill_failed|err)/.test(s)) return 'err';
  if (/(running|starting|thinking|tool|retry|rate|waiting|awaiting_question)/.test(s)) return 'warn';
  if (/(awaiting_user)/.test(s)) return 'accent';
  return 'pend';
}

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'stalled',
  'stopped',
  'kill_failed',
]);
export const WAITING_STATUSES: ReadonlySet<string> = new Set([
  'waiting',
  'awaiting_user',
  'awaiting_question',
  'interrupted',
  'rate_limited',
]);

export function isBusy(view: SessionView): boolean {
  const s = view.state.status;
  if (WAITING_STATUSES.has(s)) return false;
  if (TERMINAL_STATUSES.has(s)) return false;
  return view.state.promptReady !== true;
}

// Debounce trailing edge; resets on each call.
export function debounce<F extends (...args: never[]) => void>(fn: F, ms: number): F {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<F>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  }) as F;
}

// Tail-first paginated record window. We keep an internal offset cursor that
// grows as the user scrolls up; oldest-known offset is preserved so the API
// can return more pages without rounding errors.
export interface ChatWindow {
  // Records we currently have, ordered oldest→newest (the API is tail-first,
  // so we prepend older pages to the front of the array).
  records: import('../types').ChatRecord[];
  // The API's total offset for the *current* page — used as `before` for the
  // next "scroll older" fetch.
  nextBefore: number | null;
  total: number;
}
