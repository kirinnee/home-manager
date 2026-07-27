// DERIVED liveness: the read-time annotator that turns "an agent said it is
// working on this" into "here is what the fleet actually shows".
//
// THIS MODULE IS PURE AND IT ANNOTATES. It never mutates a task, never returns a
// different `status` than the one it was given, and has no write path at all —
// `annotateTask` copies the record and attaches a `live` block beside it. That is
// the single most important rule in the whole task subsystem (design §5):
//
//     DERIVED ANNOTATES. DECLARED ASSERTS. NEITHER WRITES THE OTHER.
//
// Auto-promoting `in_progress → built` because a session reported `completed`
// would launder an agent's claim into board truth. This board exists precisely
// because a hand-maintained one reported an item as "in progress" while its agent
// had already failed twice; the fix is a LOUD MISMATCH BADGE, not a silent flip.
// So `completed` + a done marker produces `staleness: 'maybe-finished'` — a
// prompt for a human to verify — and the declared status stays exactly where its
// author left it.
//
// Structural typing keeps this decoupled: `TaskAssigneeView` is satisfied by a
// real `SessionView` plus the one fact a pure module cannot derive (whether a
// done marker certifies the CURRENT turn), which is exactly how warden-detect.ts
// takes its input.

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { markerFile, type KTeamPaths } from './paths';
import { unknownTaskLive, type Task, type TaskAssigneeHealth, type TaskLive, type TaskView } from './tasks-types';

/** One session as the annotator sees it. A real `SessionView` satisfies this
 *  structurally; tests pass literals. */
export interface TaskAssigneeView {
  config: {
    id: string;
    name?: string;
    teammate?: string;
    createdAt?: string;
    turn?: number;
  };
  state: {
    status?: string;
    turn?: number;
    lastActivityAt?: string;
    startedAt?: string;
    finishedAt?: string;
  };
  /** True when `markers/done.json` certifies the session's CURRENT turn — the
   *  teammate declared its work finished. Supplied by the caller (see
   *  `hasCurrentDoneMarker`) because a pure module cannot read a file. */
  hasDoneMarker?: boolean;
}

/** Session statuses that mean "this session is no longer running, and it did not
 *  finish cleanly" — the ones that make an `in_progress` claim untrustworthy.
 *  `completed` is deliberately NOT here: it gets `maybe-finished` instead, which
 *  is a different (and more interesting) message. */
const DEAD_STATUSES = new Set(['failed', 'stalled', 'stopped', 'kill_failed']);

/** Alive and doing something. */
const ACTIVE_STATUSES = new Set(['created', 'starting', 'running', 'thinking', 'tool_running', 'retrying']);

/** Alive but not working: parked on a question, a human, a declared wait, a quota
 *  reset, or an interrupted turn. Not a stall and not a death. */
const WAITING_STATUSES = new Set(['awaiting_question', 'awaiting_user', 'waiting', 'rate_limited', 'interrupted']);

/** Health for the liveness dot. Anything this build does not recognise is
 *  `unknown` — never guessed into `active`, because a green dot that is wrong is
 *  worse than an honest grey one. */
export function assigneeHealthOf(status: string | undefined): TaskAssigneeHealth {
  if (status === undefined) return 'unknown';
  if (ACTIVE_STATUSES.has(status)) return 'active';
  if (WAITING_STATUSES.has(status)) return 'waiting';
  // `completed` is dead for HEALTH purposes (it is not running); the "it says it
  // finished" nuance is carried by staleness, not by the dot.
  if (DEAD_STATUSES.has(status) || status === 'completed') return 'dead';
  return 'unknown';
}

/** The most recent moment this session showed any sign of life. */
function lastActivityOf(view: TaskAssigneeView): string | null {
  return view.state.lastActivityAt ?? view.state.finishedAt ?? view.state.startedAt ?? view.config.createdAt ?? null;
}

/** Resolve a task's `assignee` (a session id, a teammate callsign, or a session
 *  name) against the fleet. An id match always wins; among callsign/name matches
 *  the most recently active session wins, because callsigns are only unique among
 *  sessions started in the last few days and the newest holder is the one a
 *  reader means. Returns null when nothing matches — "the assignee is gone" is a
 *  first-class answer, not an error. */
export function resolveAssignee<V extends TaskAssigneeView>(assignee: string | null, views: readonly V[]): V | null {
  if (assignee === null) return null;
  const wanted = assignee.trim();
  if (wanted.length === 0) return null;
  const byId = views.find(view => view.config.id === wanted);
  if (byId) return byId;
  const named = views.filter(view => view.config.teammate === wanted || view.config.name === wanted);
  if (named.length === 0) return null;
  return named.reduce((best, candidate) =>
    (lastActivityOf(candidate) ?? '') > (lastActivityOf(best) ?? '') ? candidate : best,
  );
}

export interface TaskLiveOptions {
  /** Enables the `quiet` flag. Both this and `nowMs` must be supplied; without
   *  them `quiet` is never reported (phase 1 ships without the service wiring
   *  that would provide a clock — see the note on `quiet` below). */
  quietAfterMs?: number;
  /** Explicit clock, so this stays pure and testable. */
  nowMs?: number;
}

const parseTime = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** Compute the derived `live` block for one task.
 *
 *  `staleness`, the whole point (design §5):
 *   • `in_progress` + assignee failed/stalled/stopped/missing → `assignee-dead`
 *   • `in_progress` + assignee completed or done-marker      → `maybe-finished`
 *   • `in_progress` + nothing has moved for `quietAfterMs`   → `quiet` (opt-in)
 *   • otherwise                                              → null
 *
 *  Only `in_progress` can be stale: a dead assignee on a `built` or `live` task
 *  is normal (the work is done), and a `blocked` task is waiting on a human by
 *  definition. An `in_progress` task with NO assignee at all reports null — no
 *  one is claiming to work on it, so there is no claim to contradict.
 *
 *  `quiet` needs a clock and a threshold, which is why it is opt-in per call: the
 *  helper supports it cleanly, and phase 1 simply does not pass the options, so
 *  no service wiring is required to ship the other two flags. */
export function computeTaskLive(
  task: Pick<Task, 'status' | 'assignee' | 'updatedAt'>,
  assignee: TaskAssigneeView | null,
  options: TaskLiveOptions = {},
): TaskLive {
  const live: TaskLive = unknownTaskLive();
  const inProgress = task.status === 'in_progress';

  if (assignee === null) {
    // Assigned to somebody the fleet cannot find → the claim has no backing.
    if (inProgress && task.assignee !== null) live.staleness = 'assignee-dead';
    return live;
  }

  const status = assignee.state.status;
  live.assigneeStatus = status ?? null;
  live.assigneeHealth = assigneeHealthOf(status);
  live.assigneeDoneMarker = assignee.hasDoneMarker === true;
  live.assigneeLastActivityAt = lastActivityOf(assignee);

  if (!inProgress) return live;

  if (status === undefined || DEAD_STATUSES.has(status)) {
    live.staleness = 'assignee-dead';
    return live;
  }
  if (status === 'completed' || live.assigneeDoneMarker) {
    live.staleness = 'maybe-finished';
    return live;
  }
  const { quietAfterMs, nowMs } = options;
  if (quietAfterMs !== undefined && quietAfterMs > 0 && nowMs !== undefined) {
    const taskMoved = parseTime(task.updatedAt) ?? 0;
    const sessionMoved = parseTime(live.assigneeLastActivityAt) ?? 0;
    const moved = Math.max(taskMoved, sessionMoved);
    if (moved > 0 && nowMs - moved >= quietAfterMs) live.staleness = 'quiet';
  }
  return live;
}

/** Attach the derived block WITHOUT touching the record. Returns a new object;
 *  the input is never mutated and `status` is copied through verbatim. */
export function annotateTask(task: Task, assignee: TaskAssigneeView | null, options: TaskLiveOptions = {}): TaskView {
  return { ...task, live: computeTaskLive(task, assignee, options) };
}

/** Annotate a whole board against one fleet listing. O(tasks × sessions) with a
 *  small index; at 40 tasks and ~700 sessions that is nothing, and it keeps the
 *  caller from having to build the index itself. */
export function annotateTasks<V extends TaskAssigneeView>(
  tasks: readonly Task[],
  views: readonly V[],
  options: TaskLiveOptions = {},
): TaskView[] {
  const cache = new Map<string, V | null>();
  return tasks.map(task => {
    const key = task.assignee ?? '';
    if (!cache.has(key)) cache.set(key, resolveAssignee(task.assignee, views));
    return annotateTask(task, cache.get(key) ?? null, options);
  });
}

/** Does `markers/done.json` certify the session's CURRENT turn? The one impure
 *  helper here, kept alongside the annotator so the service wiring is a single
 *  call and no existing file has to expose its private done-marker logic.
 *
 *  A marker for an OLDER turn is not a claim about now (the session was revived
 *  and is working again), so it reports false. Any read/parse failure reports
 *  false: absence of evidence, never invented evidence. */
export async function hasCurrentDoneMarker(
  paths: KTeamPaths,
  sessionId: string,
  turn: number | undefined,
): Promise<boolean> {
  const file = markerFile(paths, sessionId, 'done');
  if (!existsSync(file)) return false;
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return false;
  try {
    const marker = JSON.parse(text) as { turn?: unknown };
    // Match SessionManager.doneMarkerForTurn exactly: legacy/turnless markers
    // and sessions whose current turn is unknown are stale evidence, not proof
    // about the current run.
    if (typeof marker.turn !== 'number' || turn === undefined) return false;
    return marker.turn === turn;
  } catch {
    return false;
  }
}
