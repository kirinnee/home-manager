// WHICH SESSION ACTIONS A ROW OFFERS — the same gating SessionHeader's inline
// controls use, lifted out as pure data so the sidebar context menu and the
// header agree by construction rather than by two hand-kept copies.
//
// The menu REUSES the existing action paths (api.interrupt/stop/resume and the
// RenameSheet / MigrateSheet flows); this module only decides which ones are
// available for a given session, mirroring SessionActions in SessionHeader.tsx
// and the onRename/onMigrate gating in SessionHeader. Migrate stays a sheet with
// its own confirmation and in-flight warning — this only surfaces the entry
// point, it never bypasses the guard.

import type { SessionView } from '../types';
import { TERMINAL_STATUSES } from './utils';

export type SessionAction = 'interrupt' | 'stop' | 'resume' | 'rename' | 'migrate';

export interface SessionActionSpec {
  action: SessionAction;
  label: string;
  /** Destructive tone for Stop and Migrate (relaunch) — the two that discard or
   *  interrupt work. */
  danger?: boolean;
}

/**
 * The ordered actions for a session row's context menu. Empty for a read-only
 * origin (no embedding token), exactly as the header hides every control there.
 *
 *   Interrupt — a running (non-terminal) session only.
 *   Resume    — a finished session that did not fail to die.
 *   Stop      — anything still running, plus a kill_failed session (Stop again).
 *   Rename    — always available with a token.
 *   Migrate   — always available with a token; opens the destructive sheet.
 *
 * `kill_failed` is a terminal status (utils.TERMINAL_STATUSES) but the one that
 * still needs Stop, so it is called out rather than folded into "terminal".
 */
export function sessionActionSpecs(view: SessionView, hasToken: boolean): SessionActionSpec[] {
  if (!hasToken) return [];
  const status = view.state.status;
  const isTerminal = TERMINAL_STATUSES.has(status);
  const isKillFailed = status === 'kill_failed';

  const specs: SessionActionSpec[] = [];
  if (!isTerminal) specs.push({ action: 'interrupt', label: 'Interrupt turn' });
  if (isTerminal && !isKillFailed) specs.push({ action: 'resume', label: 'Resume session' });
  if (!isTerminal || isKillFailed) specs.push({ action: 'stop', label: 'Stop session', danger: true });
  specs.push({ action: 'rename', label: 'Rename…' });
  specs.push({ action: 'migrate', label: 'Move account + relaunch…', danger: true });
  return specs;
}
