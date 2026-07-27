// STATUS AS A SHAPE, NOT A COLOUR.
//
// The sidebar row has room for exactly one status glyph, and a coloured dot is
// the classic accessibility failure: ~8% of men cannot separate the green one
// from the amber one, and nobody can hear either. So the glyph carries THREE
// signals at once —
//
//   SHAPE   circle   the session is doing something right now
//           diamond  it is parked, waiting on a human, a peer or a deadline
//           square   it is over (completed, failed, stalled, stopped)
//   COLOUR  the existing ok / warn / err / pend tones, per theme, never the
//           only difference between two states
//   TEXT    an `aria-label` + `title` naming the class AND the raw status, so a
//           screen reader says "waiting — awaiting_user" and a mouse user gets
//           the same string on hover
//
// The shapes are markup rather than tokens on purpose (a theme may not redefine
// "waiting is a diamond" — the convention has to hold across all of them); only
// the colours come from tokens.

import type { SessionView } from '../types';
import { TERMINAL_STATUSES, WAITING_STATUSES, cn } from '../lib/utils';

export type StatusShape = 'circle' | 'diamond' | 'square';
export type StatusClass = 'active' | 'waiting' | 'finished';

export interface StatusMarkInfo {
  shape: StatusShape;
  klass: StatusClass;
  tone: 'ok' | 'warn' | 'err' | 'pend' | 'accent';
  /** The full accessible string: "waiting — parked←freddie". */
  label: string;
  /** Whether the mark should breathe (live work only, motion-gated in CSS). */
  live: boolean;
}

export function statusMark(view: SessionView): StatusMarkInfo {
  const status = view.state.status;
  const parked = !!view.state.waiting;

  if (TERMINAL_STATUSES.has(status)) {
    const ok = status === 'completed';
    return {
      shape: 'square',
      klass: 'finished',
      tone: ok ? 'ok' : 'err',
      label: `finished — ${status}`,
      live: false,
    };
  }

  if (parked || WAITING_STATUSES.has(status)) {
    // A DECLARED park is healthy and names its condition; an unanswered question
    // is a request for a human. Both are "waiting" in shape, and the label is
    // what tells them apart.
    const wait = view.state.waiting;
    const detail = wait
      ? `parked${wait.peerName ? ` for ${wait.peerName}` : ''}${wait.condition ? `: ${wait.condition}` : ''}`
      : status;
    return {
      shape: 'diamond',
      klass: 'waiting',
      tone: status === 'awaiting_question' || status === 'awaiting_user' ? 'accent' : 'warn',
      label: `waiting — ${detail}`,
      live: false,
    };
  }

  return {
    shape: 'circle',
    klass: 'active',
    tone: 'warn',
    label: `active — ${status}`,
    live: true,
  };
}

/** How a ROW carrying this session should treat its name, so a dense list has
 *  vertical variation without re-adding any fact. A finished session is over,
 *  so its name recedes to `--muted`; live and waiting work stays at full
 *  `--fg` strength and anchors the eye. This is the ONLY differentiator that is
 *  safe in greyscale AND colour-blind vision: it is a lightness step on a
 *  contrast-checked ink (`muted` is gated ≥4.5:1 on every surface), never a hue,
 *  so it reads the same when the status tones collapse to grey. Callers keep
 *  their own weight (`font-semibold`) and hover (`group-hover:text-accent`). */
export function nameToneClass(view: SessionView): string {
  return statusMark(view).klass === 'finished' ? 'text-muted' : 'text-fg';
}

const TONE_FILL: Record<StatusMarkInfo['tone'], string> = {
  ok: 'bg-ok border-ok-border',
  warn: 'bg-warn border-warn-border',
  err: 'bg-err border-err-border',
  pend: 'bg-pend border-pend-border',
  accent: 'bg-accent border-accent-border',
};

const SHAPE_CLASS: Record<StatusShape, string> = {
  circle: 'rounded-full',
  // A rotated square reads as a diamond at 8px where an SVG path would not.
  diamond: 'rotate-45 rounded-[1px]',
  square: 'rounded-[1px]',
};

/** The glyph. `role="img"` + `aria-label` so it is announced as one thing
 *  rather than as an empty span, and `title` so the same words are available on
 *  hover. */
export function StatusMark({
  view,
  size = 8,
  className = '',
}: {
  view: SessionView;
  size?: number;
  className?: string;
}) {
  const info = statusMark(view);
  return (
    <span
      role="img"
      aria-label={info.label}
      title={info.label}
      // The wrapper keeps a stable, unrotated box so a diamond does not change
      // the row's metrics relative to a circle.
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size + 4, height: size + 4 }}
    >
      <span
        aria-hidden
        className={cn('block border', SHAPE_CLASS[info.shape], TONE_FILL[info.tone], info.live && 'kt-pulse')}
        style={{ width: size, height: size }}
      />
    </span>
  );
}
