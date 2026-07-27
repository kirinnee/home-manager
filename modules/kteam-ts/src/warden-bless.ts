// Warden blessing store + predicate.
//
// The problem this solves (token burn observed 2026-07-27): a warden verdict of
// LEAVE ("this session is healthy and progressing; no action") currently changes
// nothing about the next sweep. So the same healthy-but-sus session is re-flagged
// on the following 5-minute trigger and re-investigated — each investigation a
// fresh Opus-class warden session. Confirmed instance: warden `mohammed`
// investigated `lenny`, found it healthy, returned LEAVE, and nothing stopped that
// repeating. (Under the one-warden-at-a-time concurrency gate in
// `warden-concurrency.ts`, the old per-target `assignedCooldownMinutes` no longer
// gates re-spawn once the warden goes terminal, so a cleared session becomes a
// candidate again immediately.)
//
// The fix: when a warden CLEARS a session (LEAVE verdict), record a *blessing*
// with a short TTL (default 15 minutes). The sweep then SKIPS that session as a
// candidate until the blessing lapses — so it never even occupies the single
// warden slot. Design constraints, all encoded here:
//
//   - NARROW. A blessing covers only the FLAGS (anomaly kinds) the warden cleared.
//     A genuinely new, different signal on the same session — a new anomaly kind —
//     is NOT covered and still triggers. A blanket blindfold on a session that
//     later breaks is a worse bug than the one being fixed.
//   - INVALIDATE ON STATE CHANGE. A blessing for a session in status X does not
//     survive that session changing status: `reconcileBlessings` drops it. A
//     running session that goes terminal, wedges, or starts awaiting a human is a
//     new situation the blessing must not hide. (`isAnomalyBlessed` also re-checks
//     status defensively so a stale store can never mis-bless.)
//   - EXPIRE. Every blessing carries an absolute `expiresAt`; past that it does
//     not apply and is pruned.
//   - PERSISTABLE. The store is a plain JSON-serializable record, meant to live in
//     the warden runtime state so a `kteamd` restart does not drop every blessing
//     and re-investigate the whole fleet at once.
//   - LEAVE ONLY. This module never inspects verdicts — the CALLER must only call
//     `recordBlessing` for a LEAVE/`cleared` verdict. Non-LEAVE verdicts must not
//     bless.
//
// Pure: no I/O, no clock, no globals. Time comes in as `nowMs`; the caller reads
// and writes the store. Mirrors the shape of `warden-concurrency.ts`.

import type { WardenAnomalyKind } from './warden-detect';
import type { SessionStatus } from './types';

/** One recorded blessing: a warden cleared `sessionId` (against `kinds`) while it
 *  was in `status`, valid until `expiresAt`. */
export interface Blessing {
  /** The session that was cleared. */
  sessionId: string;
  /** The anomaly kinds the warden cleared — the flags this blessing covers. A
   *  fresh anomaly of a kind NOT in this list is not blessed and still triggers.
   *  Empty means the blessing covers nothing (so it can never skip anything —
   *  harmless, but the caller should avoid recording an empty one). */
  kinds: WardenAnomalyKind[];
  /** Session status at bless time. The blessing applies only while the session
   *  stays in this status; any change invalidates it (see module header). */
  status: SessionStatus;
  /** ISO time the blessing was granted (observability / status display). */
  blessedAt: string;
  /** ISO expiry. `nowMs >= Date.parse(expiresAt)` ⇒ lapsed, does not apply. */
  expiresAt: string;
  /** The warden session that issued the LEAVE, for provenance in the journal. */
  wardenId?: string;
}

/** Blessing store: at most one active blessing per session, keyed by session id.
 *  A later LEAVE for the same session replaces the earlier blessing. */
export type BlessingStore = Record<string, Blessing>;

/** Clamp a configured blessing lifetime (minutes) to milliseconds, flooring at
 *  60s so a mis-set `0`/negative never produces an already-expired blessing that
 *  silently disables the feature. */
export function blessingTtlMs(minutes: number): number {
  const m = Number.isFinite(minutes) ? minutes : 0;
  return Math.max(60_000, Math.floor(m * 60_000));
}

/** The active (non-expired) blessing for a session, or undefined. Does not check
 *  status — callers that care use `isAnomalyBlessed`. */
export function activeBlessing(store: BlessingStore, sessionId: string, nowMs: number): Blessing | undefined {
  const blessing = store[sessionId];
  if (!blessing) return undefined;
  const expiry = Date.parse(blessing.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= nowMs) return undefined;
  return blessing;
}

/** True when `anomaly` is covered by an active blessing: the session has a
 *  non-expired blessing, the current status still matches the blessed status, and
 *  the anomaly's kind is one the warden cleared. This is the predicate the sweep
 *  uses to drop a candidate BEFORE it reaches the concurrency gate.
 *
 *  Returns false — i.e. the anomaly is NOT suppressed and still triggers — for:
 *   - no blessing / expired blessing,
 *   - a status that has changed since the blessing (new situation),
 *   - a NEW anomaly kind the blessing never covered. */
export function isAnomalyBlessed(
  store: BlessingStore,
  anomaly: { sessionId: string; kind: WardenAnomalyKind },
  currentStatus: SessionStatus,
  nowMs: number,
): boolean {
  const blessing = activeBlessing(store, anomaly.sessionId, nowMs);
  if (!blessing) return false;
  if (blessing.status !== currentStatus) return false; // invalidate on state change
  return blessing.kinds.includes(anomaly.kind); // narrow: only the cleared flags
}

/** Record (or replace) a blessing for a session. LEAVE-ONLY is the caller's
 *  contract; this function does not know about verdicts. Returns a NEW store
 *  (immutable update). `ttlMs` is typically `blessingTtlMs(config.blessMinutes)`.
 *
 *  Kinds are de-duplicated. If `kinds` is empty the call is a no-op (an empty
 *  blessing could never suppress anything and would only add churn to the store). */
export function recordBlessing(
  store: BlessingStore,
  entry: { sessionId: string; kinds: WardenAnomalyKind[]; status: SessionStatus; wardenId?: string },
  nowMs: number,
  ttlMs: number,
): BlessingStore {
  const kinds = [...new Set(entry.kinds)];
  if (kinds.length === 0) return store;
  const blessing: Blessing = {
    sessionId: entry.sessionId,
    kinds,
    status: entry.status,
    blessedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + Math.max(0, ttlMs)).toISOString(),
    ...(entry.wardenId ? { wardenId: entry.wardenId } : {}),
  };
  return { ...store, [entry.sessionId]: blessing };
}

/** Housekeeping run each sweep: return a NEW store with blessings dropped when
 *   - expired (`nowMs` past `expiresAt`),
 *   - the session's CURRENT status differs from the blessed status (state change —
 *     the blessing must not survive it), or
 *   - the session is gone entirely (absent from `statusById`).
 *
 *  Dropping (rather than merely ignoring) keeps the persisted store bounded and
 *  makes "a blessing does not survive a status change" literal rather than
 *  dormant-and-revivable. `statusById` is the live session status map from the
 *  sweep. Also returns the ids dropped for a state change / disappearance, so the
 *  caller can journal that a blessing was revoked early (as opposed to lapsing). */
export function reconcileBlessings(
  store: BlessingStore,
  statusById: Map<string, SessionStatus>,
  nowMs: number,
): { store: BlessingStore; revoked: string[]; expired: string[] } {
  const next: BlessingStore = {};
  const revoked: string[] = [];
  const expired: string[] = [];
  for (const [sessionId, blessing] of Object.entries(store)) {
    const expiry = Date.parse(blessing.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= nowMs) {
      expired.push(sessionId);
      continue;
    }
    const current = statusById.get(sessionId);
    if (current === undefined || current !== blessing.status) {
      // Session vanished or changed state — the blessing does not survive it.
      revoked.push(sessionId);
      continue;
    }
    next[sessionId] = blessing;
  }
  return { store: next, revoked, expired };
}
