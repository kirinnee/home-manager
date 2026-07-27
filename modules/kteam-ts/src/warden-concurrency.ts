// Fleet-wide warden concurrency + dedup gate.
//
// The fleet runs two kinds of warden, both under WARDEN_LABEL:
//   - the fleet-SWEEP warden (`warden-sweep`), which triages the whole anomaly
//     set at once (no single target), spawned by `maybeEscalate`;
//   - per-target ASSIGNED wardens (`warden:<teammate>`), one per sus session,
//     spawned by `spawnAssignedWardens`.
//
// Historically the two spawn sites counted concurrency independently:
// `spawnAssignedWardens` capped only the ASSIGNED wardens (`maxAssignedWardens`,
// default 3) and never saw the sweep warden, so a sweep warden plus three
// assigned wardens = four live Opus sessions at once. The user asked for "if a
// warden already exists, don't spawn another warden" — i.e. ONE warden at a time
// across the whole fleet (configurable), with the other targets QUEUED rather
// than dropped.
//
// This module is the pure decision core both spawn sites share. It has no I/O
// and no session-manager coupling, so it unit-tests in isolation and the
// session-manager wiring is a thin adapter over it.

/** A currently-live warden session (assigned or sweep). Both share
 *  WARDEN_LABEL, so the count of live WARDEN_LABEL sessions IS the fleet-wide
 *  concurrency figure the gate bounds. */
export interface LiveWarden {
  wardenId: string;
  /** The session this warden is investigating. `undefined` for the fleet-sweep
   *  warden, which triages the whole set rather than a single target — so it
   *  contributes to the concurrency count but not to the per-target dedup set. */
  targetId?: string;
}

export interface WardenGateInput {
  /** Fleet-wide cap on concurrently-live wardens (assigned + sweep). The gate
   *  clamps this to >=1 — a 0 cap would wedge the warden entirely. `1` means
   *  "only ever one warden at a time", the requested default. */
  maxConcurrent: number;
  /** Every live warden session right now (assigned + sweep). Its length is the
   *  current concurrency; the gate never lets spawns push past `maxConcurrent`. */
  live: LiveWarden[];
  /** Fresh sus targets from THIS sweep, in priority order. */
  candidates: string[];
  /** Targets carried over from earlier sweeps that could not be spawned yet,
   *  FIFO (oldest first). Persisted across sweeps so a deferred investigation is
   *  never silently lost. */
  queued: string[];
  /** True while `targetId` is STILL a live, still-suspect session worth a
   *  warden. Returns false for a target that has recovered, gone terminal, or
   *  vanished — the gate DROPS such targets rather than investigating them. */
  isStillSuspect: (targetId: string) => boolean;
}

export interface WardenGateDecision {
  /** Targets to spawn a warden for right now, in order. Never longer than the
   *  free slots; never a target that already has a live warden. */
  spawn: string[];
  /** Targets to persist for the next sweep: still suspect, but no slot free. */
  queue: string[];
  /** Targets removed from the queue because they recovered / vanished. Reported
   *  so the caller can log that an investigation was closed without a warden
   *  (as opposed to being lost). */
  dropped: string[];
}

/** Fleet-wide free warden slots: the cap (clamped to >=1) minus the live count
 *  (floored at 0). Shared by both spawn sites so the sweep and assigned wardens
 *  draw down the SAME budget. */
export function wardenSlotsFree(maxConcurrent: number, liveCount: number): number {
  const cap = Math.max(1, Math.floor(maxConcurrent));
  return Math.max(0, cap - Math.max(0, liveCount));
}

/** Pure concurrency + dedup gate for per-target assigned wardens.
 *
 *  Guarantees:
 *  - never spawns past the fleet-wide cap — and counts the sweep warden, so a
 *    live sweep warden alone can fill a cap of 1;
 *  - never a SECOND warden for a target already under investigation;
 *  - a still-suspect target with no free slot is QUEUED, not dropped;
 *  - a queued target that has since recovered is DROPPED, not investigated;
 *  - queued targets are retried before fresh candidates (FIFO — no starvation);
 *  - duplicate ids across the queue and this sweep collapse to one.
 */
export function decideAssignedWardens(input: WardenGateInput): WardenGateDecision {
  const { maxConcurrent, live, candidates, queued, isStillSuspect } = input;

  // Targets that already have a live warden — the dedup set. A live warden with
  // no targetId (the sweep warden) counts toward concurrency but guards no
  // single target, so it never blocks an assigned spawn by identity.
  const underInvestigation = new Set<string>();
  for (const warden of live) {
    if (warden.targetId !== undefined) underInvestigation.add(warden.targetId);
  }

  // Queue first (FIFO / anti-starvation), then fresh candidates; collapse dupes.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of [...queued, ...candidates]) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }

  const queuedSet = new Set(queued);
  const dropped: string[] = [];
  const eligible: string[] = [];
  for (const id of ordered) {
    // Already being investigated: not a new spawn and not re-queued. Not
    // "dropped" (it didn't recover) — it is simply handled.
    if (underInvestigation.has(id)) continue;
    if (!isStillSuspect(id)) {
      // Only report a drop for something we were actively holding — a fresh
      // candidate that isn't suspect was never queued to begin with.
      if (queuedSet.has(id)) dropped.push(id);
      continue;
    }
    eligible.push(id);
  }

  const slots = wardenSlotsFree(maxConcurrent, live.length);
  return {
    spawn: eligible.slice(0, slots),
    queue: eligible.slice(slots),
    dropped,
  };
}
