// The task record's data model (v1) — the standardised replacement for the
// hand-maintained STATUS-BOARD.md. Designed in
// `~/.kteam/ms2s74rp-2b53ab8e/task-format-design.md`; this file is that design's
// §4/§5 expressed as types, and nothing else (no I/O, no service).
//
// It is declared HERE rather than in the shared `types.ts` for the same reason
// `learning-types.ts` exists: the whole task subsystem must type-check on its own
// while the shared daemon files are concurrently edited. `types.ts` can later
// re-export these (`export type { Task, TaskActivity, TaskLive } from './tasks'`)
// as a one-line wiring patch owned by the lead.
//
// THE TWO INVARIANTS THESE TYPES PROTECT:
//
//  1. DECLARED status is asserted by a human or an agent and stored; DERIVED
//     liveness (`TaskLive`) is computed at read time and NEVER stored, and never
//     changes `status`. That is why `TaskLive` is a separate type joined onto a
//     `TaskView` instead of fields on `Task`: the record on disk physically
//     cannot carry a derived verdict. A board that auto-promotes a task because
//     an agent claimed "completed" launders a claim into truth — the exact
//     failure this system exists to remove.
//  2. Text is REFUSED over its cap, never truncated (pins.ts MAX_NOTE_LEN
//     rationale). A brief silently cut at 64 KiB is a brief that lies about what
//     the work is.

/** On-disk schema version for task records and activity entries. A value from
 *  another version is skipped by the parser (a migration point, never a crash). */
export const TASK_SCHEMA_VERSION = 1;

/** The board's own vocabulary (B7 / F21 / I3 / C2), so migration is 1:1. */
export type TaskKind = 'bug' | 'feature' | 'infra' | 'chore';

export const TASK_KINDS: readonly TaskKind[] = ['bug', 'feature', 'infra', 'chore'];

/** Human-id prefix per kind. Ids are `<prefix><monotonic counter>` — the
 *  vocabulary the user already reads and says out loud. */
export const TASK_ID_PREFIX: Record<TaskKind, string> = {
  bug: 'B',
  feature: 'F',
  infra: 'I',
  chore: 'C',
};

/** DECLARED status — intent, asserted, stored. Mirrors the live board's seven
 *  states plus `blocked` ("What I need from you"). Deliberately NOT derivable:
 *  `built` means gates ran green, `live` means deployed, `designed` means a human
 *  judged the spec done. Guessing those is the disease, not the cure. */
export type TaskStatus = 'todo' | 'researched' | 'designed' | 'in_progress' | 'built' | 'live' | 'blocked' | 'dropped';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'todo',
  'researched',
  'designed',
  'in_progress',
  'built',
  'live',
  'blocked',
  'dropped',
];

/** Board display order (design §7): shipped work first, the things needing a
 *  human last-but-loudest (`blocked` gets its own pinned strip in the UI). */
export const TASK_BOARD_ORDER: readonly TaskStatus[] = [
  'live',
  'built',
  'in_progress',
  'designed',
  'researched',
  'todo',
  'blocked',
  'dropped',
];

/** `statusReason` is REQUIRED (non-empty) for these two: "❌ NOT POSSIBLE" is
 *  worthless without the reason, and a `blocked` task with no stated blocker is
 *  what the user has to chase the lead about. */
export const TASK_REASON_REQUIRED: readonly TaskStatus[] = ['blocked', 'dropped'];

export const taskReasonRequired = (status: TaskStatus): boolean => TASK_REASON_REQUIRED.includes(status);

/** Title cap. Refused, not truncated — a half title is a mystery row. */
export const MAX_TASK_TITLE_LEN = 200;
/** The full brief. 64 KiB is generous for the largest observed `brief-*.md`;
 *  over it the create/update is REFUSED so the caller shortens it deliberately
 *  (or points at the file with `links.docs`). */
export const MAX_TASK_DESCRIPTION_LEN = 64 * 1024;
/** One activity note / status reason. Refused over cap, never truncated. */
export const MAX_TASK_NOTE_LEN = 2 * 1024;
/** One link value (URL, branch, sha, doc path). */
export const MAX_TASK_LINK_LEN = 512;
/** Per-field link cap, so an automated appender cannot grow the record without
 *  bound. Adding past it is REFUSED (the record is not a log — the log is). */
export const MAX_TASK_LINKS_PER_FIELD = 64;

export interface TaskLinks {
  /** Full PR urls; the UI renders GitHub ones as `repo#123` chips. */
  prs: string[];
  /** The single working branch, or null. */
  branch: string | null;
  commits: string[];
  /** Briefs, design docs, transcripts — usually `~/.kteam/<id>/brief-*.md`. */
  docs: string[];
}

export const emptyTaskLinks = (): TaskLinks => ({ prs: [], branch: null, commits: [], docs: [] });

/** The link fields a `link` action can write. `branch` is singular (last write
 *  wins); the rest append. */
export type TaskLinkField = 'pr' | 'branch' | 'commit' | 'doc';

export const TASK_LINK_FIELDS: readonly TaskLinkField[] = ['pr', 'branch', 'commit', 'doc'];

/** The DECLARED record inside a session's `tasks.json` snapshot.
 *  Everything here was asserted by somebody; nothing here is derived. */
export interface Task {
  v: number;
  /** `B7`, `F21` — daemon-assigned, monotonic per kind, never recycled. */
  id: string;
  kind: TaskKind;
  title: string;
  /** THE brief: full markdown, what this work is supposed to do. May be empty
   *  (a placeholder row), never truncated. */
  description: string;
  status: TaskStatus;
  /** Required non-empty for `blocked`/`dropped`; null otherwise. */
  statusReason: string | null;
  /** kteam session id or teammate callsign, verbatim as supplied. Resolution to
   *  a live session happens at read time (see TaskLive) — a dead session's name
   *  stays on the record as history. */
  assignee: string | null;
  /** The cwd/repo this task is ABOUT (grouping is by field, not by directory). */
  repo: string | null;
  links: TaskLinks;
  /** Lead-set priority rank; null = unranked. Lower sorts first. */
  order: number | null;
  createdAt: string;
  /** Provenance ONLY — the creating session's death orphans nothing. */
  createdBy: string | null;
  updatedAt: string;
}

/** One activity entry inside a session's `tasks.json`. `note`/`feedback` carry `text`; `status` carries
 *  `from`/`to` (+ optional `note`); `link` carries `field`/`value`; `assign`
 *  carries `from`/`to`; `order` carries `from`/`to` numbers; `session` is the
 *  phase-2 daemon-auto evidence line. */
export type TaskActivityType = 'created' | 'status' | 'note' | 'link' | 'assign' | 'order' | 'feedback' | 'session';

export const TASK_ACTIVITY_TYPES: readonly TaskActivityType[] = [
  'created',
  'status',
  'note',
  'link',
  'assign',
  'order',
  'feedback',
  'session',
];

export interface TaskActivity {
  v: number;
  /** Per-task, gap-free, daemon-assigned under the same lock as the append, so
   *  the UI can page with `?after=<seq>` and trust it. Starts at 1. */
  seq: number;
  time: string;
  /** Session id / `user` / `daemon`. */
  actor: string;
  /** Display name for `actor` (teammate callsign) when known. */
  actorName: string | null;
  type: TaskActivityType;
  data: Record<string, unknown>;
}

/** How alive the assignee looks. Union FROZEN with the parent session
 *  (ms2sdz76-f6226292, 2026-07-27): `active | waiting | dead | unknown`, plus
 *  `null` for "no assignee, or it no longer resolves to a session".
 *
 *  `dead` means NOT RUNNING, which includes `completed` — a completed session is
 *  no longer working on anything. The nuance ("it says it finished, verify")
 *  lives in `staleness: 'maybe-finished'`, not in health, so that health stays a
 *  simple liveness dot and the interesting claim stays in the loud field. */
export type TaskAssigneeHealth = 'active' | 'waiting' | 'dead' | 'unknown';

/** The mismatch flag: declared status vs. the evidence. The most valuable output
 *  of the whole design — it is what catches "in_progress, but its agent failed
 *  twice two hours ago". */
export type TaskStaleness = 'assignee-dead' | 'maybe-finished' | 'quiet';

/** DERIVED at read time from session state. Never written to disk, never allowed
 *  to change `Task.status`. */
export interface TaskLive {
  /** The assignee session's SessionStatus, or null when there is no assignee or
   *  it no longer resolves to a session. */
  assigneeStatus: string | null;
  /** null = no assignee / unresolved (see TaskAssigneeHealth). */
  assigneeHealth: TaskAssigneeHealth | null;
  /** `markers/done.json` certified for the assignee's CURRENT turn. */
  assigneeDoneMarker: boolean;
  assigneeLastActivityAt: string | null;
  /** null when declared status and evidence agree (or cannot disagree). */
  staleness: TaskStaleness | null;
}

/** The annotation for "there is nothing to check against" — no assignee, or an
 *  assignee that no longer resolves. Note `staleness` is still computed by the
 *  annotator (an `in_progress` task whose assignee vanished IS `assignee-dead`);
 *  this is only the neutral starting point. */
export const unknownTaskLive = (): TaskLive => ({
  assigneeStatus: null,
  assigneeHealth: null,
  assigneeDoneMarker: false,
  assigneeLastActivityAt: null,
  staleness: null,
});

/** Alias for the stored record, the name the API contract uses. */
export type TaskRecord = Task;

/** A record plus its derived annotation — what every read returns. */
export interface TaskView extends Task {
  live: TaskLive;
}

/** A task returned from a session-scoped route. `sessionId` is derived from the
 *  route/storage path and is never persisted inside the task record itself. */
export interface ScopedTaskView extends TaskView {
  sessionId: string;
}

/** List rows: no `description` (a 40-row board must not ship 40 briefs), but the
 *  length is reported so the UI can show "has a brief" honestly. */
export type TaskSummary = Omit<TaskView, 'description'> & { descriptionChars: number };

/** Aggregate reads carry the storage owner on every row. IDs remain
 *  fleet-global for stable links and spoken references; `null` names an
 *  unresolved legacy-global record deliberately retained outside a fake
 *  session. */
export type ScopedTaskSummary = TaskSummary & { sessionId: string | null };

// ---- API-facing shapes (FROZEN with ms2sdz76-f6226292, 2026-07-27) ----------
//
//   GET  /v1/tasks      => TaskListResponse   { tasks, parseErrors }
//   GET  /v1/tasks/:id  => TaskDetailResponse { task, activity }
//
// Any additional field here is ADDITIVE and safe for an older client to ignore;
// the two frozen keys of each response never change shape.

export interface TaskListResponse {
  tasks: TaskSummary[];
  /** Records that were unreadable/malformed and therefore skipped. Surfaced,
   *  never thrown — one corrupt entry degrades to one missing row. */
  parseErrors: number;
  /** Additive: ids/scopes of skipped records, so the user can inspect them. */
  parseErrorIds?: string[];
}

export interface TaskDetailResponse {
  task: TaskView;
  activity: TaskActivity[];
  /** Additive: activity lines on disk that failed to parse (never silently zero). */
  activityParseErrors?: number;
}

/** The session board returned by `GET /v1/sessions/:id/tasks` and carried in a
 *  live `tasks.updated` event. It is deliberately list-shaped (briefs and
 *  histories stay on the detail route), just like the whole-board pins event. */
export interface SessionTaskListResponse extends Omit<TaskListResponse, 'tasks'> {
  v: number;
  sessionId: string;
  tasks: ScopedTaskSummary[];
  /** ISO timestamp of the underlying tasks.json snapshot. */
  updatedAt: string;
}

/** Fleet-wide compatibility/read view. Writes never target this scope. */
export interface FleetTaskListResponse extends Omit<TaskListResponse, 'tasks'> {
  v: number;
  sessionId: null;
  tasks: ScopedTaskSummary[];
  updatedAt: string;
}

export interface ScopedTaskDetailResponse extends Omit<TaskDetailResponse, 'task'> {
  sessionId: string | null;
  task: TaskView & { sessionId: string | null };
}

/** The store's own list result, before it is shaped into a response. */
export interface TaskListResult {
  tasks: TaskSummary[];
  parseErrors: number;
  parseErrorIds: string[];
}

// ---- inputs (shared by the CLI, the API route and the service) --------------

/** Who is acting. Filled from the caller's session (the CLI knows its own
 *  `KTEAM_SESSION_ID`) or `user` for a human at the browser. Never trusted as
 *  authorization — the bearer token already did that; this only labels history. */
export interface TaskActor {
  actor?: string | null;
  actorName?: string | null;
}

export interface TaskCreateInput {
  kind: TaskKind;
  title: string;
  /** The full brief. Optional; refused over MAX_TASK_DESCRIPTION_LEN. */
  description?: string;
  /** Defaults to `todo`. A create straight into `blocked`/`dropped` must carry a
   *  reason exactly like any other status write. */
  status?: TaskStatus;
  statusReason?: string;
  assignee?: string | null;
  repo?: string | null;
  links?: Partial<{ prs: string[]; branch: string | null; commits: string[]; docs: string[] }>;
  order?: number | null;
  /** @deprecated Transport parsers deliberately drop these. Kept only for
   *  source compatibility with direct pre-session service callers. */
  actor?: string | null;
  /** @deprecated See actor. Server-resolved TaskActor is a separate argument. */
  actorName?: string | null;
}

/** The five mutations of design §7 (`status|note|link|assign|order`) plus
 *  `feedback`, which is a note the UI renders louder because it came from the
 *  user ("every time you get feedback, add to it"). */
export type TaskActionInput =
  | { action: 'status'; status: TaskStatus; reason?: string; note?: string }
  | { action: 'note'; text: string }
  | { action: 'feedback'; text: string }
  | { action: 'link'; field: TaskLinkField; value: string }
  | { action: 'assign'; assignee: string | null }
  | { action: 'order'; order: number | null };

export type TaskActionName = TaskActionInput['action'];

export const TASK_ACTIONS: readonly TaskActionName[] = ['status', 'note', 'feedback', 'link', 'assign', 'order'];

/** Why a task operation was refused. Mapped to HTTP status by
 *  `taskErrorStatus` (tasks-contract.ts) so the route wiring stays thin. */
export type TaskErrorCode =
  | 'invalid'
  /** Over a cap. The message names the cap and the actual length. */
  | 'too-long'
  | 'reason-required'
  | 'not-found'
  /** A resolved agent attempted to write another session's board. */
  | 'forbidden'
  /** An aggregate id lookup found a migration conflict or damaged duplicate. */
  | 'ambiguous'
  /** A non-daemon process attempted a write. */
  | 'read-only';

export class TaskError extends Error {
  constructor(
    readonly code: TaskErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TaskError';
  }
}

export const isTaskError = (error: unknown): error is TaskError => error instanceof TaskError;
