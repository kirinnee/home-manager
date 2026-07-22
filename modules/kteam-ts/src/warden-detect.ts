import type { SessionConfig, SessionState, SessionStatus } from './types';

/** Label that marks a fleet-warden session. Warden sessions are excluded from
 *  every anomaly class so the warden can never escalate against itself. */
export const WARDEN_LABEL = 'kteam-warden';

export type WardenAnomalyKind = 'dead_monitor' | 'unattended_question' | 'abandoned_wreckage' | 'quota_reset_passed';

export interface WardenAnomaly {
  kind: WardenAnomalyKind;
  sessionId: string;
  teammate?: string;
  label?: string;
  status: SessionStatus;
  /** Human-readable one-liner for the report / CLI. */
  detail: string;
  /** ISO timestamp the anomaly is anchored to (idle-since, finished-at, etc.). */
  since?: string;
  /** Whole minutes the session has been in the anomalous state, when known. */
  idleMinutes?: number;
}

export interface WardenDetectResult {
  anomalies: WardenAnomaly[];
  /** Stable identity of the anomaly SET (kind+session, order-independent) — used
   *  to suppress a repeat escalation for an unchanged situation. Empty when there
   *  are no anomalies. */
  fingerprint: string;
}

/** One session as the detector sees it: its persisted config/state plus the one
 *  fact the pure module cannot derive on its own — whether the daemon currently
 *  holds a live monitor handle for it. */
export interface WardenSessionView {
  config: SessionConfig;
  state: SessionState;
  hasLiveMonitor: boolean;
}

export interface WardenDetectOptions {
  /** A waiting session idle at least this long is an unanswered question. */
  unattendedMs: number;
  /** A failed/stalled session that entered its terminal state within this window
   *  is fresh wreckage worth flagging; older terminal sessions are ignored. */
  terminalWindowMs: number;
}

/** Statuses that MUST have a live monitor handle — a session claiming to be
 *  actively working with no monitor is a dead-monitor anomaly. */
const ACTIVE_MONITORED: SessionStatus[] = ['running', 'thinking', 'tool_running'];
/** Waiting statuses that, when idle too long, mean nobody answered. */
const WAITING_IDLE: SessionStatus[] = ['awaiting_question', 'awaiting_user', 'waiting'];

function parseMs(value: string | undefined): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

/** Latest of a set of ISO timestamps (0 when none parse). */
function latestMs(...values: (string | undefined)[]): number {
  let max = 0;
  for (const value of values) max = Math.max(max, parseMs(value));
  return max;
}

/** Pure fleet anomaly detector. Fed a snapshot of session views plus the current
 *  wall-clock time, it returns the anomaly list and a stable fingerprint. No I/O,
 *  no clock, no globals — everything comes in through the arguments. */
export function detectAnomalies(
  sessions: readonly WardenSessionView[],
  nowMs: number,
  options: WardenDetectOptions,
): WardenDetectResult {
  const anomalies: WardenAnomaly[] = [];
  // Ancestry index: a warden must be excluded along with everything it spawned,
  // not just sessions that literally carry the label. A warden's descendants are
  // force-labelled at start() too, but excluding by lineage here is the
  // authoritative guard even if a child slipped through with a different label.
  const byId = new Map(sessions.map(item => [item.config.id, item]));
  const inWardenLineage = (view: WardenSessionView): boolean => {
    const seen = new Set<string>();
    let current: WardenSessionView | undefined = view;
    while (current && !seen.has(current.config.id)) {
      seen.add(current.config.id);
      if (current.config.label === WARDEN_LABEL) return true;
      current = current.config.parent ? byId.get(current.config.parent) : undefined;
    }
    return false;
  };
  for (const view of sessions) {
    const { config, state } = view;
    // No-recursion: never flag a warden session or any of its descendants (it
    // would make the warden escalate against itself in an endless loop).
    if (inWardenLineage(view)) continue;
    const base: Omit<WardenAnomaly, 'kind' | 'detail'> = {
      sessionId: config.id,
      teammate: config.teammate,
      label: config.label,
      status: state.status,
    };

    if (ACTIVE_MONITORED.includes(state.status) && !view.hasLiveMonitor) {
      anomalies.push({
        ...base,
        kind: 'dead_monitor',
        detail: `status ${state.status} but no live monitor handle (the daemon is not watching this turn)`,
      });
    }

    // A waiting status is only "unattended" worth escalating when nobody is
    // expected to be at the keyboard. AUTO sessions have no human driver, so any
    // waiting-idle status is anomalous. INTERACTIVE sessions are often parked at
    // a ready prompt on purpose — only an explicit unanswered question
    // (awaiting_question) counts there, not a plain idle prompt.
    const waitingEscalatable = config.mode === 'auto' || state.status === 'awaiting_question';
    if (waitingEscalatable && WAITING_IDLE.includes(state.status)) {
      const idleSince = latestMs(
        state.lastActivityAt,
        state.lastTranscriptAt,
        state.lastPaneAt,
        state.startedAt,
        config.updatedAt,
      );
      const anchor = idleSince || parseMs(config.createdAt);
      const idleMs = anchor ? nowMs - anchor : Number.POSITIVE_INFINITY;
      if (idleMs >= options.unattendedMs) {
        const idleMinutes = Number.isFinite(idleMs) ? Math.floor(idleMs / 60_000) : undefined;
        anomalies.push({
          ...base,
          kind: 'unattended_question',
          detail: `${state.status} with no activity for ${idleMinutes ?? '∞'}m — a question nobody answered`,
          since: anchor ? new Date(anchor).toISOString() : undefined,
          idleMinutes,
        });
      }
    }

    if (state.status === 'failed' || state.status === 'stalled') {
      const finishedMs = latestMs(state.finishedAt, state.lastActivityAt, config.updatedAt);
      if (finishedMs && nowMs - finishedMs <= options.terminalWindowMs) {
        anomalies.push({
          ...base,
          kind: 'abandoned_wreckage',
          detail: `${state.status} within the sweep window and never resumed or stopped${state.reason ? `: ${state.reason}` : ''}`,
          since: new Date(finishedMs).toISOString(),
        });
      }
    }

    if (state.status === 'rate_limited') {
      const resetAt = state.quota?.resetAt;
      if (typeof resetAt === 'number' && resetAt <= nowMs) {
        anomalies.push({
          ...base,
          kind: 'quota_reset_passed',
          detail: 'rate_limited but the quota reset time has passed and it was never resumed',
          since: new Date(resetAt).toISOString(),
        });
      }
    }
  }

  return { anomalies, fingerprint: fingerprintAnomalies(anomalies) };
}

/** Order-independent identity of an anomaly set. Two sweeps with the same
 *  (kind, session) pairs fingerprint identically regardless of ordering or of
 *  volatile detail/timestamp fields. */
export function fingerprintAnomalies(anomalies: readonly WardenAnomaly[]): string {
  return [...anomalies.map(a => `${a.kind}:${a.sessionId}`)].sort().join('|');
}
