// The task store: fleet-global, file-based, hand-inspectable, daemon-owned.
// Two halves, exactly like learning-store.ts:
//
//  1. PURE parse/validate functions — every field checked one at a time, a
//     malformed record degrading to a SKIPPED record with a parse-error count
//     instead of a throw (`parsePinStore` discipline). Fully unit-testable, no
//     I/O.
//  2. TaskStore — the I/O wrapper: `tasks/<id>/task.json` written with
//     `atomicJson` (temp+rename, io.ts) and `tasks/<id>/activity.jsonl` grown by
//     single one-line appends.
//
// WHY THE WRITE PATH IS SHAPED THIS WAY (design §6):
//
//   • THE DAEMON IS THE SOLE WRITER. A store constructed without
//     `{ role: 'daemon' }` refuses every write with TaskError('read-only'). The
//     CLI and the UI must go through `/v1/tasks`. This is not ceremony: a torn
//     write from two concurrent writers corrupted a file in this tree on
//     2026-07-27 (kteam-prob.md), and the whole point of a task board is that it
//     does not lie about state.
//   • WRITES ARE SERIALISED IN-PROCESS. Per-task chains order a record rewrite
//     against an activity append; one global chain orders id allocation. So
//     `seq` is gap-free and ids are never handed out twice even when ten
//     teammates POST in the same tick.
//   • RECORD WRITES ARE ATOMIC (temp+rename); APPENDS ARE ONE LINE. A single
//     `appendFile` of one complete JSON line under PIPE_BUF cannot interleave,
//     so a crash can only ever lose the tail, never corrupt earlier history.
//   • IDS ARE NEVER RECYCLED. The counter file is the fast path, but every
//     allocation also scans the existing directories and takes the max of both —
//     so a lost counters.json self-heals, and a deleted/trashed task's id is not
//     handed to a different task later (the design's open question, closed).

import { appendFile, mkdir, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { KTeamPaths } from './paths';
import { atomicJson, now } from './io';
import { taskTitleIssue } from './task-title';
import {
  MAX_TASK_DESCRIPTION_LEN,
  MAX_TASK_CLARIFICATIONS,
  MAX_TASK_DEPENDENCIES,
  MAX_TASK_FILES,
  MAX_TASK_FILE_LEN,
  MAX_TASK_LINKS_PER_FIELD,
  MAX_TASK_LINK_LEN,
  MAX_TASK_NOTE_LEN,
  MAX_TASK_SOURCE_LEN,
  MAX_TASK_TITLE_LEN,
  TASK_ACTIVITY_TYPES,
  TASK_BOARD_ORDER,
  TASK_ID_PREFIX,
  TASK_KINDS,
  TASK_SCHEMA_VERSION,
  TASK_PHASES,
  TASK_STATUSES,
  TASK_WORKFLOWS,
  TaskError,
  emptyTaskLinks,
  type Task,
  type TaskActivity,
  type TaskActivityType,
  type TaskKind,
  type TaskMessage,
  type TaskClarification,
  type TaskLinks,
  type TaskListResult,
  type TaskStatus,
  type TaskPhase,
  type TaskWorkflow,
  type TaskSummary,
  type TaskView,
} from './tasks-types';
import { assertTaskPhaseInWorkflow, inferTaskWorkflow, taskPhaseFromStatus } from './tasks-workflow';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Task store layout, derived from the daemon dir — a sibling of
 *  `daemon/warden/` and `daemon/learning/`, same 0700 "files are authoritative"
 *  philosophy. Kept INTERNAL to the task module (not on KTeamPaths) so the whole
 *  subsystem type-checks without touching the concurrently-edited paths.ts; the
 *  lead's wiring patch may add `tasksDir` there and pass it through, or simply
 *  keep using this. */
export function taskPaths(paths: KTeamPaths) {
  const dir = path.join(paths.daemon, 'tasks');
  return {
    dir,
    /** Monotonic per-kind id counters. A CACHE of the max ever allocated — the
     *  directory scan is the backstop, so losing this file loses nothing. */
    counters: path.join(dir, 'counters.json'),
    taskDir: (id: string) => path.join(dir, id),
    record: (id: string) => path.join(dir, id, 'task.json'),
    activity: (id: string) => path.join(dir, id, 'activity.jsonl'),
  };
}

// ---------------------------------------------------------------------------
// Pure parsing — field by field, degrade to skip, never throw
// ---------------------------------------------------------------------------

const isKind = (value: unknown): value is TaskKind => TASK_KINDS.includes(value as TaskKind);
const isStatus = (value: unknown): value is TaskStatus => TASK_STATUSES.includes(value as TaskStatus);
const isActivityType = (value: unknown): value is TaskActivityType =>
  TASK_ACTIVITY_TYPES.includes(value as TaskActivityType);

/** Task ids are `<PREFIX><digits>`. Also the path-safety guard: an id from a
 *  request is joined onto the store dir, so anything with a separator, a dot, or
 *  a surprise character is rejected before it becomes a path. */
const TASK_ID = /^[BFIC][0-9]{1,9}$/;

export const isTaskId = (value: unknown): value is string => typeof value === 'string' && TASK_ID.test(value);

/** Normalise a user-supplied id reference (`f21`, ` F21 `) to canonical form.
 *  Returns null when it is not an id at all — never a guess. */
export function normalizeTaskId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().replace(/^[#&]/u, '').toUpperCase();
  return TASK_ID.test(upper) ? upper : null;
}

/** Split an id into its kind prefix and number, or null. */
export function splitTaskId(id: string): { prefix: string; number: number } | null {
  if (!isTaskId(id)) return null;
  const prefix = id.slice(0, 1);
  const number = Number(id.slice(1));
  return Number.isSafeInteger(number) && number > 0 ? { prefix, number } : null;
}

/** A string field that must be a string; anything else degrades to the fallback
 *  rather than failing the whole record (a missing note is a missing note). */
const str = (value: unknown, fallback: string | null = null): string | null =>
  typeof value === 'string' ? value : fallback;

/** A non-empty trimmed string, or null. */
const nonEmpty = (value: unknown): string | null => {
  const text = str(value);
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Defensive per-field parse of `links`. Unknown fields are dropped, wrong-typed
 *  entries are skipped, over-cap values are dropped (refuse-not-truncate holds on
 *  READ too, so a hand-edited file cannot smuggle a 1 MB "url" back in), and
 *  each list is de-duplicated and capped. */
export function parseTaskLinks(value: unknown): TaskLinks {
  const links = emptyTaskLinks();
  if (!value || typeof value !== 'object') return links;
  const raw = value as Record<string, unknown>;
  const listOf = (input: unknown): string[] => {
    if (!Array.isArray(input)) return [];
    const out: string[] = [];
    for (const entry of input) {
      const text = nonEmpty(entry);
      if (text === null || text.length > MAX_TASK_LINK_LEN) continue;
      if (out.includes(text)) continue;
      out.push(text);
      if (out.length >= MAX_TASK_LINKS_PER_FIELD) break;
    }
    return out;
  };
  links.prs = listOf(raw['prs']);
  links.commits = listOf(raw['commits']);
  links.docs = listOf(raw['docs']);
  const branch = nonEmpty(raw['branch']);
  links.branch = branch !== null && branch.length <= MAX_TASK_LINK_LEN ? branch : null;
  return links;
}

function parseTaskMessage(value: unknown): TaskMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const message = typeof raw['text'] === 'string' ? raw['text'] : null;
  const source = nonEmpty(raw['source']);
  if (
    message === null ||
    message.length === 0 ||
    message.length > MAX_TASK_DESCRIPTION_LEN ||
    source === null ||
    source.length > MAX_TASK_SOURCE_LEN
  ) {
    return null;
  }
  return { text: message, source };
}

function parseTaskClarifications(value: unknown): TaskClarification[] {
  if (!Array.isArray(value)) return [];
  const clarifications: TaskClarification[] = [];
  for (const item of value) {
    const message = parseTaskMessage(item);
    if (message === null || !item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const at = nonEmpty(raw['at']);
    const by = nonEmpty(raw['by']);
    if (at === null || by === null) continue;
    clarifications.push({ ...message, at, by, byName: nonEmpty(raw['byName']) });
    if (clarifications.length >= MAX_TASK_CLARIFICATIONS) break;
  }
  return clarifications;
}

function parseTaskDependencies(value: unknown, self: string): string[] {
  if (!Array.isArray(value)) return [];
  const dependencies: string[] = [];
  for (const item of value) {
    const id = normalizeTaskId(item);
    if (id === null || id === self || dependencies.includes(id)) continue;
    dependencies.push(id);
    if (dependencies.length >= MAX_TASK_DEPENDENCIES) break;
  }
  return dependencies;
}

/** Defensive parse of advisory file claims. Missing/wrong-typed → `[]` (a legacy
 *  record simply claims nothing), blanks and over-cap paths dropped, de-duped and
 *  capped. Spelling is preserved verbatim — a claim is compared as the author
 *  wrote it, not canonicalised, so `./a` and `a` are treated as distinct. */
function parseTaskFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const files: string[] = [];
  for (const item of value) {
    const file = nonEmpty(item);
    if (file === null || file.length > MAX_TASK_FILE_LEN || files.includes(file)) continue;
    files.push(file);
    if (files.length >= MAX_TASK_FILES) break;
  }
  return files;
}

/** Defensive parse of ONE task record. Returns null for anything this build does
 *  not understand, so a single bad file degrades to "that task is missing from
 *  the board" (counted in `parseErrors`), never to a throw.
 *
 *  REQUIRED to survive: `v` matching this build, a well-formed `id`, a known
 *  `kind`, a non-empty `title`, a known `status`, and a `statusReason` when the
 *  status demands one. Everything else degrades to a default. */
export function parseTaskRecord(value: unknown): Task | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  // Version mismatch is a migration point: skip rather than misread a shape this
  // build does not know.
  if (raw['v'] !== TASK_SCHEMA_VERSION) return null;
  const id = normalizeTaskId(raw['id']);
  if (id === null) return null;
  const kind = raw['kind'];
  if (!isKind(kind)) return null;
  // The id's prefix must agree with the kind, or the board would show a `bug`
  // numbered F21 and the counters would disagree with reality.
  if (id.slice(0, 1) !== TASK_ID_PREFIX[kind]) return null;
  const title = nonEmpty(raw['title']);
  if (title === null || title.length > MAX_TASK_TITLE_LEN) return null;
  const status = raw['status'];
  if (!isStatus(status)) return null;
  const description = str(raw['description'], '') ?? '';
  if (description.length > MAX_TASK_DESCRIPTION_LEN) return null;
  const statusReason = nonEmpty(raw['statusReason']);
  // A `blocked`/`dropped` record with no reason is exactly the row the user
  // cannot act on; treat it as unreadable rather than render a mystery.
  if (statusReason === null && (status === 'blocked' || status === 'dropped')) return null;
  if (statusReason !== null && statusReason.length > MAX_TASK_NOTE_LEN) return null;
  const orderRaw = raw['order'];
  const order = typeof orderRaw === 'number' && Number.isSafeInteger(orderRaw) && orderRaw >= 0 ? orderRaw : null;
  const createdAt = nonEmpty(raw['createdAt']);
  if (createdAt === null) return null;
  const links = parseTaskLinks(raw['links']);
  const parsedPhase = raw['phase'];
  const phase =
    typeof parsedPhase === 'string' && (TASK_PHASES as readonly string[]).includes(parsedPhase)
      ? (parsedPhase as TaskPhase)
      : taskPhaseFromStatus(status);
  const parsedWorkflow = raw['workflow'];
  const workflow =
    typeof parsedWorkflow === 'string' && (TASK_WORKFLOWS as readonly string[]).includes(parsedWorkflow)
      ? (parsedWorkflow as TaskWorkflow)
      : inferTaskWorkflow(phase);
  try {
    assertTaskPhaseInWorkflow(workflow, phase);
  } catch {
    return null;
  }
  // The v2 status/phase invariant (maya P1): a persisted record must not carry a
  // declared status that contradicts its phase, or the List/status filter and the
  // Kanban phase column will disagree and later activity records a transition
  // whose `from` and `phaseFrom` describe two different states. Reject at the
  // parse boundary rather than trust one field downstream.
  //   • `blocked` is EXEMPT — a manual block keeps the phase it was blocked in
  //     while the status reads `blocked` (status→phase is `todo`, deliberately).
  //   • every other status maps 1:1 to a phase, so `dropped` is forced to phase
  //     `dropped` by the same rule. Legacy records with no stored phase inferred
  //     it from status above, so they satisfy this by construction.
  if (status !== 'blocked' && taskPhaseFromStatus(status) !== phase) return null;
  const ask =
    parseTaskMessage(raw['ask']) ??
    ({
      text: description.length > 0 ? description : title,
      source: links.docs[0] ?? `legacy:${id}`,
    } satisfies TaskMessage);
  return {
    v: TASK_SCHEMA_VERSION,
    id,
    kind,
    title,
    description,
    ask,
    clarifications: parseTaskClarifications(raw['clarifications']),
    workflow,
    phase,
    dependsOn: parseTaskDependencies(raw['dependsOn'], id),
    status,
    statusReason,
    assignee: nonEmpty(raw['assignee']),
    repo: nonEmpty(raw['repo']),
    files: parseTaskFiles(raw['files']),
    links,
    order,
    createdAt,
    createdBy: nonEmpty(raw['createdBy']),
    updatedAt: nonEmpty(raw['updatedAt']) ?? createdAt,
  };
}

/** The ONLY thing ever written to `task.json`: an explicit whitelist of declared
 *  fields. A caller handing back a TaskView (record + derived `live`) therefore
 *  physically cannot persist the derived annotation — the invariant is enforced
 *  by the serializer, not by everyone remembering it. */
export function serializeTask(task: Task): Task {
  return {
    v: TASK_SCHEMA_VERSION,
    id: task.id,
    kind: task.kind,
    title: task.title,
    description: task.description,
    ask: { ...task.ask },
    clarifications: task.clarifications.map(clarification => ({ ...clarification })),
    workflow: task.workflow,
    phase: task.phase,
    dependsOn: [...task.dependsOn],
    status: task.status,
    statusReason: task.statusReason,
    assignee: task.assignee,
    repo: task.repo,
    files: [...task.files],
    links: {
      prs: [...task.links.prs],
      branch: task.links.branch,
      commits: [...task.links.commits],
      docs: [...task.links.docs],
    },
    order: task.order,
    createdAt: task.createdAt,
    createdBy: task.createdBy,
    updatedAt: task.updatedAt,
  };
}

/** Defensive parse of ONE activity line. Returns null for anything malformed —
 *  one bad line loses one line of history, nothing else. */
export function parseTaskActivity(value: unknown): TaskActivity | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw['v'] !== TASK_SCHEMA_VERSION) return null;
  const seq = raw['seq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return null;
  const time = nonEmpty(raw['time']);
  if (time === null) return null;
  const type = raw['type'];
  if (!isActivityType(type)) return null;
  const dataRaw = raw['data'];
  const data =
    dataRaw && typeof dataRaw === 'object' && !Array.isArray(dataRaw) ? (dataRaw as Record<string, unknown>) : {};
  return {
    v: TASK_SCHEMA_VERSION,
    seq,
    time,
    actor: nonEmpty(raw['actor']) ?? 'unknown',
    actorName: nonEmpty(raw['actorName']),
    type,
    data,
  };
}

export interface ParsedActivity {
  activity: TaskActivity[];
  /** Non-blank lines that did not parse. Reported, never hidden. */
  parseErrors: number;
  /** Non-blank lines seen, parsed or not — the floor for the next `seq` so a
   *  corrupt line can never cause a duplicate sequence number. */
  lines: number;
}

/** Parse a whole `activity.jsonl` blob: ordered by `seq`, corrupt lines counted
 *  and skipped. Never throws. */
export function parseTaskActivityLog(text: string): ParsedActivity {
  const activity: TaskActivity[] = [];
  let parseErrors = 0;
  let lines = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parseErrors += 1;
      continue;
    }
    const entry = parseTaskActivity(parsed);
    if (entry === null) {
      parseErrors += 1;
      continue;
    }
    activity.push(entry);
  }
  activity.sort((a, b) => a.seq - b.seq);
  return { activity, parseErrors, lines };
}

// ---------------------------------------------------------------------------
// Pure validation — the refuse-never-truncate boundary
// ---------------------------------------------------------------------------

/** Refuse over-cap text with a message that names the cap AND the actual length,
 *  so the caller can fix it instead of guessing. NEVER truncates. */
function capped(label: string, text: string, max: number): string {
  if (text.length > max) {
    throw new TaskError('too-long', `${label} is ${text.length} characters; the maximum is ${max} (not truncated)`);
  }
  return text;
}

export function validateTaskTitle(value: unknown): string {
  const title = nonEmpty(value);
  if (title === null) throw new TaskError('invalid', 'title is required');
  const cappedTitle = capped('title', title, MAX_TASK_TITLE_LEN);
  const issue = taskTitleIssue(cappedTitle);
  if (issue !== null) throw new TaskError('invalid', issue);
  return cappedTitle;
}

/** The brief. Empty is allowed (a placeholder row); over-cap is refused. */
export function validateTaskDescription(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new TaskError('invalid', 'description must be a string');
  return capped('description', value, MAX_TASK_DESCRIPTION_LEN);
}

export function validateTaskSource(value: unknown, label = 'source'): string {
  const source = nonEmpty(value);
  if (source === null) throw new TaskError('invalid', `${label} is required and may not be blank`);
  return capped(label, source, MAX_TASK_SOURCE_LEN);
}

export function validateTaskMessage(value: unknown, label = 'ask'): TaskMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskError('invalid', `${label} must contain text and source`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw['text'] !== 'string' || raw['text'].trim().length === 0) {
    throw new TaskError('invalid', `${label}.text is required and may not be blank`);
  }
  return {
    text: capped(`${label}.text`, raw['text'], MAX_TASK_DESCRIPTION_LEN),
    source: validateTaskSource(raw['source'], `${label}.source`),
  };
}

export function validateTaskWorkflow(value: unknown): TaskWorkflow {
  if (typeof value !== 'string' || !(TASK_WORKFLOWS as readonly string[]).includes(value)) {
    throw new TaskError('invalid', `workflow must be one of ${TASK_WORKFLOWS.join(', ')}`);
  }
  return value as TaskWorkflow;
}

export function validateTaskPhase(value: unknown): TaskPhase {
  if (typeof value !== 'string' || !(TASK_PHASES as readonly string[]).includes(value)) {
    throw new TaskError('invalid', `phase must be one of ${TASK_PHASES.join(', ')}`);
  }
  return value as TaskPhase;
}

export function validateTaskDependencies(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TaskError('invalid', 'dependsOn must be an array of task ids');
  if (value.length > MAX_TASK_DEPENDENCIES) {
    throw new TaskError('too-long', `dependsOn holds ${value.length} entries; the maximum is ${MAX_TASK_DEPENDENCIES}`);
  }
  const dependencies: string[] = [];
  for (const item of value) {
    const id = normalizeTaskId(item);
    if (id === null) throw new TaskError('invalid', `dependency must look like &F12, got ${String(item)}`);
    if (!dependencies.includes(id)) dependencies.push(id);
  }
  return dependencies;
}

/** One advisory file claim, authoritatively supplied. Trimmed, non-blank,
 *  capped. Spelling is preserved as given — the claim is compared verbatim. */
export function validateTaskFile(value: unknown, label = 'file'): string {
  const file = nonEmpty(value);
  if (file === null) throw new TaskError('invalid', `${label} path is required and may not be blank`);
  return capped(label, file, MAX_TASK_FILE_LEN);
}

/** Normalize a supplied `files` array on create: each path trimmed, blanks
 *  dropped, order-preserving de-dupe, over-long paths refused, count capped.
 *  Blank entries are noise (trailing commas, empty splits) so they are dropped
 *  rather than failing the whole create — the single-file action stays strict. */
export function validateTaskFiles(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TaskError('invalid', 'files must be an array of paths');
  if (value.length > MAX_TASK_FILES) {
    throw new TaskError('too-long', `files holds ${value.length} entries; the maximum is ${MAX_TASK_FILES}`);
  }
  const files: string[] = [];
  for (const item of value) {
    const file = nonEmpty(item);
    if (file === null) continue;
    const checked = capped('file', file, MAX_TASK_FILE_LEN);
    if (!files.includes(checked)) files.push(checked);
  }
  return files;
}

/** A note / status reason / feedback line. */
export function validateTaskNote(value: unknown, label = 'note'): string {
  const text = nonEmpty(value);
  if (text === null) throw new TaskError('invalid', `${label} is required and may not be blank`);
  return capped(label, text, MAX_TASK_NOTE_LEN);
}

export function validateTaskLinkValue(value: unknown, label = 'link'): string {
  const text = nonEmpty(value);
  if (text === null) throw new TaskError('invalid', `${label} is required and may not be blank`);
  return capped(label, text, MAX_TASK_LINK_LEN);
}

export function validateTaskKind(value: unknown): TaskKind {
  if (!isKind(value)) throw new TaskError('invalid', `kind must be one of ${TASK_KINDS.join(', ')}`);
  return value;
}

/** `order` is a rank: a non-negative safe integer, or null for unranked.
 *  Anything else is refused rather than coerced — a NaN rank sorts randomly. */
export function validateTaskOrder(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TaskError('invalid', 'order must be a non-negative whole number, or null to unrank');
  }
  return value;
}

export function validateTaskStatus(value: unknown): TaskStatus {
  if (!isStatus(value)) throw new TaskError('invalid', `status must be one of ${TASK_STATUSES.join(', ')}`);
  return value;
}

/** `blocked`/`dropped` REQUIRE a reason: "❌ NOT POSSIBLE" with no reason is the
 *  row the user cannot act on, and a blocker nobody wrote down is a blocker
 *  nobody unblocks. Any other status keeps a supplied reason and is happy
 *  without one. */
export function resolveStatusReason(status: TaskStatus, reason: unknown): string | null {
  const text = nonEmpty(reason);
  if (status === 'blocked' || status === 'dropped') {
    if (text === null) {
      throw new TaskError('reason-required', `status "${status}" requires a reason (--reason)`);
    }
    return capped('reason', text, MAX_TASK_NOTE_LEN);
  }
  return text === null ? null : capped('reason', text, MAX_TASK_NOTE_LEN);
}

/** Board sort: declared-status groups in the board's order, then `order` (a set
 *  rank always beats an unranked task), then id number, then id. Total and
 *  deterministic — two tasks never swap places between two reads. */
export function compareTasks(a: Task, b: Task): number {
  const group = TASK_BOARD_ORDER.indexOf(a.status) - TASK_BOARD_ORDER.indexOf(b.status);
  if (group !== 0) return group;
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  const an = splitTaskId(a.id)?.number ?? 0;
  const bn = splitTaskId(b.id)?.number ?? 0;
  if (an !== bn) return an - bn;
  return a.id.localeCompare(b.id);
}

/** Strip the brief off a view for list rows, reporting its length instead. */
export function toTaskSummary(view: TaskView): TaskSummary {
  const { description, ask, clarifications, ...rest } = view;
  return {
    ...rest,
    descriptionChars: description.length,
    askChars: ask.text.length,
    askSource: ask.source,
    clarificationCount: clarifications.length,
  };
}

export interface TaskFilter {
  repo?: string;
  status?: TaskStatus | TaskStatus[];
  assignee?: string;
  kind?: TaskKind;
  ids?: string[];
}

/** Apply a filter to a record. All supplied predicates must match (AND). */
export function matchesTaskFilter(task: Task, filter: TaskFilter = {}): boolean {
  if (filter.repo !== undefined && task.repo !== filter.repo) return false;
  if (filter.kind !== undefined && task.kind !== filter.kind) return false;
  if (filter.assignee !== undefined && task.assignee !== filter.assignee) return false;
  if (filter.ids !== undefined && !filter.ids.includes(task.id)) return false;
  if (filter.status !== undefined) {
    const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!wanted.includes(task.status)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Serialisation of writes
// ---------------------------------------------------------------------------

/** One promise chain per key: `run(key, fn)` never starts `fn` until every
 *  earlier `fn` for that key has settled. A rejected step does NOT poison the
 *  chain (the next caller still runs) but DOES reject its own caller. */
export class SerialQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    // Track a swallowed copy so one failure cannot reject the next queued step.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      // Drop the entry once this step is the tail, so the map does not grow
      // without bound across a long-lived daemon.
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return result;
  }

  /** Pending chains — test/diagnostic visibility only. */
  get size(): number {
    return this.chains.size;
  }
}

interface TaskCounters {
  v: number;
  /** kind → highest number ever allocated. */
  counters: Partial<Record<TaskKind, number>>;
}

/** Defensive parse of counters.json: any damage degrades to "no cache", and the
 *  directory scan then supplies the real floor. */
export function parseTaskCounters(text: string | null): TaskCounters {
  const empty: TaskCounters = { v: TASK_SCHEMA_VERSION, counters: {} };
  if (!text) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const raw = parsed as Record<string, unknown>;
  if (raw['v'] !== TASK_SCHEMA_VERSION) return empty;
  const countersRaw = raw['counters'];
  if (!countersRaw || typeof countersRaw !== 'object') return empty;
  const counters: Partial<Record<TaskKind, number>> = {};
  for (const kind of TASK_KINDS) {
    const value = (countersRaw as Record<string, unknown>)[kind];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) counters[kind] = value;
  }
  return { v: TASK_SCHEMA_VERSION, counters };
}

export type TaskStoreRole = 'daemon' | 'reader';

export interface TaskStoreOptions {
  /** Only a `daemon` store may write. Anything else gets TaskError('read-only')
   *  telling it to use `/v1/tasks` — see the header comment. Default `reader`,
   *  so a store is read-only unless someone deliberately says otherwise. */
  role?: TaskStoreRole;
}

/** The one thing an activity append needs from its caller. `seq` and `time` are
 *  assigned by the store, never by the caller. */
export interface TaskActivityInput {
  type: TaskActivityType;
  actor?: string | null;
  actorName?: string | null;
  data?: Record<string, unknown>;
  /** Test/migration hook: an explicit timestamp instead of the clock. */
  time?: string;
}

/** The handle a `transact` body gets: the record as it exists UNDER THE LOCK,
 *  plus unlocked write/append primitives for that same task. */
export interface TaskMutation {
  readonly id: string;
  /** undefined when the task does not exist (or its record does not parse). */
  readonly current: Task | undefined;
  write(task: Task, options?: { updatedAt?: string }): Promise<Task>;
  append(input: TaskActivityInput): Promise<TaskActivity>;
}

export class TaskStore {
  private readonly p: ReturnType<typeof taskPaths>;
  private readonly role: TaskStoreRole;
  private readonly queue = new SerialQueue();
  /** Per-task last-assigned `seq`, seeded from disk on first append. The daemon
   *  is the sole writer, so this cache cannot go stale under us. */
  private readonly seqCache = new Map<string, number>();

  constructor(paths: KTeamPaths, options: TaskStoreOptions = {}) {
    this.p = taskPaths(paths);
    this.role = options.role ?? 'reader';
  }

  get dir(): string {
    return this.p.dir;
  }

  get writable(): boolean {
    return this.role === 'daemon';
  }

  recordFile(id: string): string {
    return this.p.record(id);
  }

  activityFile(id: string): string {
    return this.p.activity(id);
  }

  /** Every write funnels through here, so the daemon-only rule has exactly one
   *  enforcement point. */
  private assertWritable(): void {
    if (this.role !== 'daemon') {
      throw new TaskError(
        'read-only',
        'task files are daemon-owned: send this write to the daemon via /v1/tasks (see design §6)',
      );
    }
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.p.dir, { recursive: true, mode: 0o700 });
  }

  /** Read one record. Returns undefined for "absent OR unreadable OR malformed":
   *  all three mean the same thing to a reader, and none of them may throw. */
  async readTask(id: string): Promise<Task | undefined> {
    const canonical = normalizeTaskId(id);
    if (canonical === null) return undefined;
    const file = this.p.record(canonical);
    if (!existsSync(file)) return undefined;
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    return parseTaskRecord(parsed) ?? undefined;
  }

  /** Read a task's history, optionally only the lines after `afterSeq` (the
   *  UI's incremental fetch). Corrupt lines are skipped and counted. */
  async readActivity(id: string, afterSeq = 0): Promise<ParsedActivity> {
    const canonical = normalizeTaskId(id);
    if (canonical === null) return { activity: [], parseErrors: 0, lines: 0 };
    const file = this.p.activity(canonical);
    if (!existsSync(file)) return { activity: [], parseErrors: 0, lines: 0 };
    const text = await readFile(file, 'utf8').catch(() => '');
    const parsed = parseTaskActivityLog(text);
    if (afterSeq > 0) {
      return { ...parsed, activity: parsed.activity.filter(entry => entry.seq > afterSeq) };
    }
    return parsed;
  }

  /** Every task id present on disk, in canonical order. Directory names that are
   *  not task ids (a stray file, a `.tmp` left by a crashed rename) are ignored,
   *  not counted as errors — they were never tasks. */
  async listIds(): Promise<string[]> {
    const entries = await readdir(this.p.dir).catch(() => [] as string[]);
    return entries
      .map(entry => normalizeTaskId(entry))
      .filter((id): id is string => id !== null)
      .sort();
  }

  /** List records. A task whose `task.json` exists but does not parse is SKIPPED
   *  and counted in `parseErrors` — one corrupt file costs one row, never the
   *  board. Records are returned without a `live` annotation; the service joins
   *  that on (tasks-live.ts). */
  async listTasks(filter: TaskFilter = {}): Promise<{ tasks: Task[]; parseErrors: number; parseErrorIds: string[] }> {
    const ids = await this.listIds();
    const tasks: Task[] = [];
    const parseErrorIds: string[] = [];
    for (const id of ids) {
      // Only a PRESENT-but-unreadable record is an error. An id directory with
      // no record file at all (mid-create, or a hand-made dir) is not.
      const present = existsSync(this.p.record(id));
      const task = await this.readTask(id);
      if (task === undefined) {
        if (present) parseErrorIds.push(id);
        continue;
      }
      if (!matchesTaskFilter(task, filter)) continue;
      tasks.push(task);
    }
    tasks.sort(compareTasks);
    return { tasks, parseErrors: parseErrorIds.length, parseErrorIds };
  }

  /** Allocate the next id for a kind, under the ONE global lock so ten
   *  simultaneous creates get ten distinct ids.
   *
   *  The number is `max(counter cache, highest id on disk) + 1`, which makes the
   *  cache an optimisation rather than a source of truth: delete counters.json
   *  and ids continue where they left off; delete a task directory and its id is
   *  still never reused. */
  async allocateId(kind: TaskKind): Promise<string> {
    this.assertWritable();
    return this.queue.run('__counters__', async () => {
      await this.ensureDir();
      const prefix = TASK_ID_PREFIX[kind];
      const text = await readFile(this.p.counters, 'utf8').catch(() => null);
      const counters = parseTaskCounters(text);
      let highest = counters.counters[kind] ?? 0;
      for (const id of await this.listIds()) {
        const split = splitTaskId(id);
        if (split && split.prefix === prefix && split.number > highest) highest = split.number;
      }
      const next = highest + 1;
      counters.counters[kind] = next;
      await atomicJson(this.p.counters, counters);
      return `${prefix}${next}`;
    });
  }

  /** Replace a record atomically (temp+rename), stamping `updatedAt`. Only
   *  declared fields are written — a derived `live` block cannot leak onto disk
   *  (see `serializeTask`). Serialised per task against appends.
   *
   *  For a read-modify-write use `transact` instead: this method takes the lock
   *  only for the WRITE, so a caller that read the record outside the lock can
   *  still lose a concurrent update. */
  async writeTask(task: Task, options: { updatedAt?: string } = {}): Promise<Task> {
    this.assertWritable();
    const canonical = this.canonical(task.id);
    return this.queue.run(canonical, () => this.writeRecord(canonical, task, options));
  }

  /** Append ONE activity line. `seq` is assigned inside the per-task lock from
   *  `max(highest parsed seq, non-blank line count)` — the line count keeps a
   *  corrupt line from causing a duplicate sequence number, so the log stays
   *  gap-free and strictly increasing even after damage. */
  async appendActivity(id: string, input: TaskActivityInput): Promise<TaskActivity> {
    this.assertWritable();
    const canonical = this.canonical(id);
    return this.queue.run(canonical, () => this.appendLine(canonical, input));
  }

  /** ONE PER-TASK TRANSACTION: read → mutate → write record → append activity,
   *  all under a single hold of the task's lock.
   *
   *  THIS IS THE ONLY CORRECT WAY TO UPDATE A TASK, and the reason it exists is a
   *  real lost update: a `note` and a `status` arriving together used to read the
   *  same old record, and whichever wrote last silently reverted the other's
   *  declared fields. A board that quietly un-does a status change is exactly the
   *  lying board this system replaces. Inside the transaction `current` is read
   *  under the lock, so the second writer always sees the first writer's result.
   *
   *  The handle's `write`/`append` are the UNLOCKED primitives — the lock is
   *  already held. Never call `writeTask`/`appendActivity`/`transact` from inside
   *  a transaction body: the queue is not reentrant and it would deadlock. */
  async transact<T>(id: string, body: (mutation: TaskMutation) => Promise<T>): Promise<T> {
    this.assertWritable();
    const canonical = this.canonical(id);
    return this.queue.run(canonical, async () => {
      const current = await this.readTask(canonical);
      return body({
        id: canonical,
        current,
        write: (task, options) => this.writeRecord(canonical, task, options ?? {}),
        append: input => this.appendLine(canonical, input),
      });
    });
  }

  private canonical(id: string): string {
    const canonical = normalizeTaskId(id);
    if (canonical === null) throw new TaskError('invalid', `not a task id: ${String(id)}`);
    return canonical;
  }

  /** Unlocked record write — callers must already hold the task's lock. */
  private async writeRecord(id: string, task: Task, options: { updatedAt?: string }): Promise<Task> {
    const next = serializeTask({ ...task, id, updatedAt: options.updatedAt ?? now() });
    await mkdir(this.p.taskDir(id), { recursive: true, mode: 0o700 });
    await atomicJson(this.p.record(id), next);
    return next;
  }

  /** Unlocked activity append — callers must already hold the task's lock. */
  private async appendLine(id: string, input: TaskActivityInput): Promise<TaskActivity> {
    const last = await this.lastSeq(id);
    const entry: TaskActivity = {
      v: TASK_SCHEMA_VERSION,
      seq: last + 1,
      time: input.time ?? now(),
      actor: nonEmpty(input.actor) ?? 'unknown',
      actorName: nonEmpty(input.actorName),
      type: input.type,
      data: input.data ?? {},
    };
    await mkdir(this.p.taskDir(id), { recursive: true, mode: 0o700 });
    // One complete JSON record, one appendFile, one line: under PIPE_BUF this
    // cannot interleave, so history can only ever lose a tail, never tear.
    await appendFile(this.p.activity(id), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.seqCache.set(id, entry.seq);
    return entry;
  }

  private async lastSeq(id: string): Promise<number> {
    const cached = this.seqCache.get(id);
    if (cached !== undefined) return cached;
    const file = this.p.activity(id);
    if (!existsSync(file)) {
      this.seqCache.set(id, 0);
      return 0;
    }
    const text = await readFile(file, 'utf8').catch(() => '');
    const parsed = parseTaskActivityLog(text);
    const highest = parsed.activity.at(-1)?.seq ?? 0;
    const seeded = Math.max(highest, parsed.lines);
    this.seqCache.set(id, seeded);
    return seeded;
  }
}

/** Convenience: shape a store list result into API list rows given an annotator.
 *  Kept here (not in the service) so a caller with only a store can render a
 *  board — the migration script and `kteam task list --md` both want this. */
export function toTaskListResult(tasks: TaskView[], parseErrors: number, parseErrorIds: string[]): TaskListResult {
  return { tasks: tasks.map(toTaskSummary), parseErrors, parseErrorIds };
}
