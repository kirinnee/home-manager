// The mode is the single most important fact about a session, so it gets one
// shared, consistent rendering everywhere it appears (list card, table row,
// chat header):
//
//   interactive — a human's terminal. Driven from this UI, the pane, or the
//     harness's remote-control surface. NEVER auto-nudged, auto-killed or
//     flagged: idle for days is its normal state.
//   auto — an autonomous teammate. Works unattended and IS supervised: the
//     reflex layer nudges it at 180 s of silence, kills it at 300 s, and the
//     warden sweep escalates it when it looks stuck.
//
// Quiet on purpose: accent for interactive (the one you can talk to), neutral
// for auto (the common case). No banners.

import { User, Cpu } from 'lucide-react';
import type { InteractionMode } from '../types';
import { Badge } from './Primitives';

export const MODE_HINT: Record<InteractionMode, string> = {
  interactive: 'interactive — human-driven; never auto-nudged, auto-killed or flagged',
  auto: 'auto — autonomous; nudged at 180s of silence, killed at 300s, watched by the warden',
};

export function ModeBadge({
  mode,
  size = 'md',
  className = '',
}: {
  mode: InteractionMode;
  /** `sm` drops the word and keeps the icon — for dense mobile rows. */
  size?: 'sm' | 'md';
  className?: string;
}) {
  const interactive = mode === 'interactive';
  const Icon = interactive ? User : Cpu;
  return (
    <Badge
      tone={interactive ? 'accent' : 'pend'}
      title={MODE_HINT[mode]}
      className={`shrink-0 ${interactive ? '' : 'font-medium'} ${className}`}
    >
      <Icon size={11} />
      {size === 'md' && mode}
    </Badge>
  );
}
