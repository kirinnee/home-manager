// The CLI/API contract for tasks: route matching, request-body parsing, error →
// HTTP status, and the markdown RENDERS (`kteam task list --md` emits the old
// STATUS-BOARD table).
//
// WHY THIS FILE EXISTS: `api-server.ts` and `index.ts` are the two most contended
// files in the tree. Every decision that could live outside them does — so their
// patch is a handful of lines that match a route, parse a body, call the service
// and map an error, with no task-specific validation or formatting inline. The
// whole file is pure: no I/O, no service, no fs.
//
// Session-scoped response shapes:
//   GET  /v1/sessions/:sid/tasks      => SessionTaskListResponse
//   GET  /v1/sessions/:sid/tasks/:id  => ScopedTaskDetailResponse
//   POST /v1/sessions/:sid/tasks      => the created ScopedTaskView
//   POST /v1/sessions/:sid/tasks/:id  => the updated ScopedTaskView
// `/v1/tasks[/id]` survives for compatibility: GET is the fleet aggregate;
// legacy POSTs resolve a real session and delegate to the same scoped store.

import {
  TASK_ACTIONS,
  TASK_BOARD_ORDER,
  TASK_KINDS,
  TASK_LINK_FIELDS,
  TASK_PHASES,
  TASK_STATUSES,
  TASK_WORKFLOWS,
  TaskError,
  taskReference,
  type TaskActionInput,
  type TaskActionName,
  type TaskActivity,
  type TaskCreateInput,
  type TaskDetailResponse,
  type TaskKind,
  type TaskLinkField,
  type TaskPhase,
  type TaskStaleness,
  type TaskStatus,
  type TaskSummary,
} from './tasks-types';
import { normalizeTaskId } from './tasks-store';
import { isSafeTaskSessionId } from './session-tasks-store';
import { taskPhaseFromStatus } from './tasks-workflow';

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export type TaskRoute =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'detail'; id: string }
  | { kind: 'action'; id: string }
  | { kind: 'session-list'; sessionId: string }
  | { kind: 'session-create'; sessionId: string }
  | { kind: 'session-detail'; sessionId: string; id: string }
  | { kind: 'session-action'; sessionId: string; id: string };

/** Match the four task routes, or null when the path is not ours (so the caller
 *  falls through to its own 404 handling). The id is CANONICALISED here — `f21`
 *  resolves to `F21` and anything that is not an id shape is rejected before it
 *  can be joined onto a filesystem path. */
export function matchTaskRoute(method: string, pathname: string): TaskRoute | null {
  if (pathname === '/v1/tasks' || pathname === '/v1/tasks/') {
    if (method === 'GET') return { kind: 'list' };
    if (method === 'POST') return { kind: 'create' };
    return null;
  }
  const match = pathname.match(/^\/v1\/tasks\/([^/]+)\/?$/);
  if (match) {
    const id = normalizeTaskId(decode(match[1]!));
    if (id === null) return null;
    if (method === 'GET') return { kind: 'detail', id };
    if (method === 'POST') return { kind: 'action', id };
    return null;
  }
  const scoped = pathname.match(/^\/v1\/sessions\/([^/]+)\/tasks(?:\/([^/]+))?\/?$/);
  if (!scoped) return null;
  const sessionId = decode(scoped[1]!);
  if (!isSafeTaskSessionId(sessionId)) return null;
  const rawTaskId = scoped[2];
  if (rawTaskId === undefined) {
    if (method === 'GET') return { kind: 'session-list', sessionId };
    if (method === 'POST') return { kind: 'session-create', sessionId };
    return null;
  }
  const id = normalizeTaskId(decode(rawTaskId));
  if (id === null) return null;
  if (method === 'GET') return { kind: 'session-detail', sessionId, id };
  if (method === 'POST') return { kind: 'session-action', sessionId, id };
  return null;
}

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
};

/** True for any task route this build serves — used by the wiring to decide
 *  whether the 404 is "no such task route" or "not a task route at all". */
export const isTaskPath = (pathname: string): boolean =>
  /^\/v1\/tasks(?:\/|$)/.test(pathname) || /^\/v1\/sessions\/[^/]+\/tasks(?:\/|$)/.test(pathname);

/** Warden-scoped token policy (design §7): task READS are allowed, task WRITES
 *  are admin-only. Returns the "may not …" phrase for a denial, or null when the
 *  request is permitted — shaped to drop straight into `wardenScopeDenial`.
 *
 *  NOTE the CANNOT-TELL the designer flagged: whether a warden should see task
 *  DESCRIPTIONS (briefs can carry sensitive detail) is a policy call for the
 *  user. This implements the documented default (read-yes); flipping it later is
 *  a one-line change here, not a hunt through the api-server. */
export function taskWardenDenial(method: string, pathname: string): string | null {
  if (!isTaskPath(pathname)) return null;
  if (method === 'GET') return null;
  return 'change tasks';
}

// ---------------------------------------------------------------------------
// Query parsing (GET /v1/tasks?…)
// ---------------------------------------------------------------------------

export interface TaskListQuery {
  repo?: string;
  status?: TaskStatus[];
  assignee?: string;
  kind?: TaskKind;
  ids?: string[];
}

const isStatus = (value: string): value is TaskStatus => (TASK_STATUSES as readonly string[]).includes(value);
const isKind = (value: string): value is TaskKind => (TASK_KINDS as readonly string[]).includes(value);

/** Parse board filters. `?status=built&status=live` and `?status=built,live` both
 *  work (the `?sessionId=` convention in api-server.ts). An unrecognised status
 *  or kind is REFUSED rather than ignored: silently returning the unfiltered
 *  board would read as "there is nothing in that state". */
export function parseTaskListQuery(params: URLSearchParams): TaskListQuery {
  const query: TaskListQuery = {};
  const repo = params.get('repo');
  if (repo !== null && repo.trim().length > 0) query.repo = repo.trim();
  const assignee = params.get('assignee');
  if (assignee !== null && assignee.trim().length > 0) query.assignee = assignee.trim();

  const statuses = params
    .getAll('status')
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(value => value.length > 0);
  if (statuses.length > 0) {
    for (const value of statuses) {
      if (!isStatus(value)) throw new TaskError('invalid', `unknown status "${value}"`);
    }
    query.status = [...new Set(statuses.filter(isStatus))];
  }

  const kind = params.get('kind');
  if (kind !== null && kind.trim().length > 0) {
    const value = kind.trim();
    if (!isKind(value)) throw new TaskError('invalid', `unknown kind "${value}"`);
    query.kind = value;
  }

  const ids = params
    .getAll('id')
    .flatMap(value => value.split(','))
    .map(value => normalizeTaskId(value))
    .filter((value): value is string => value !== null);
  if (ids.length > 0) query.ids = [...new Set(ids)];
  return query;
}

/** `?after=<seq>` for the detail view's incremental activity fetch. A junk value
 *  degrades to 0 (send the whole log) rather than failing the read. */
export function parseAfterSeq(params: URLSearchParams): number {
  const raw = params.get('after');
  if (raw === null) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Body parsing (POST)
// ---------------------------------------------------------------------------

const asObject = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TaskError('invalid', 'expected a JSON object body');
  }
  return body as Record<string, unknown>;
};

const optionalString = (raw: Record<string, unknown>, key: string): string | undefined => {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TaskError('invalid', `${key} must be a string`);
  return value;
};

/** Task-create structural parse. Caps, enums and the
 *  reason-required rule are enforced by the service, so the CLI and the API
 *  cannot drift on them. */
export function parseTaskCreateBody(body: unknown): TaskCreateInput {
  const raw = asObject(body);
  const kind = raw['kind'];
  if (typeof kind !== 'string') throw new TaskError('invalid', `kind is required (${TASK_KINDS.join(', ')})`);
  const title = raw['title'];
  if (typeof title !== 'string') throw new TaskError('invalid', 'title is required');
  const linksRaw = raw['links'];
  const input: TaskCreateInput = {
    kind: kind as TaskKind,
    title,
  };
  const description = optionalString(raw, 'description');
  if (description !== undefined) input.description = description;
  if (raw['ask'] === undefined) {
    throw new TaskError('invalid', 'ask requires verbatim text and a source message link');
  }
  const ask = asObject(raw['ask']);
  const text = optionalString(ask, 'text');
  const source = optionalString(ask, 'source');
  if (text === undefined || source === undefined) {
    throw new TaskError('invalid', 'ask requires verbatim text and a source message link');
  }
  input.ask = { text, source };
  const workflow = optionalString(raw, 'workflow');
  if (workflow !== undefined) {
    if (!(TASK_WORKFLOWS as readonly string[]).includes(workflow)) {
      throw new TaskError('invalid', `workflow must be one of ${TASK_WORKFLOWS.join(', ')}`);
    }
    input.workflow = workflow as TaskCreateInput['workflow'];
  }
  const phase = optionalString(raw, 'phase');
  if (phase !== undefined) input.phase = phase as TaskPhase;
  if (raw['dependsOn'] !== undefined) {
    if (!Array.isArray(raw['dependsOn'])) throw new TaskError('invalid', 'dependsOn must be an array');
    input.dependsOn = raw['dependsOn'] as string[];
  }
  if (raw['files'] !== undefined) {
    if (!Array.isArray(raw['files'])) throw new TaskError('invalid', 'files must be an array of paths');
    input.files = raw['files'] as string[];
  }
  const status = optionalString(raw, 'status');
  if (status !== undefined) input.status = status as TaskStatus;
  const reason = optionalString(raw, 'statusReason') ?? optionalString(raw, 'reason');
  if (reason !== undefined) input.statusReason = reason;
  if (raw['assignee'] !== undefined)
    input.assignee = raw['assignee'] === null ? null : (optionalString(raw, 'assignee') ?? null);
  if (raw['repo'] !== undefined) input.repo = raw['repo'] === null ? null : (optionalString(raw, 'repo') ?? null);
  if (raw['order'] !== undefined) {
    const order = raw['order'];
    if (order !== null && typeof order !== 'number') throw new TaskError('invalid', 'order must be a number or null');
    input.order = order as number | null;
  }
  if (linksRaw !== undefined && linksRaw !== null) {
    const links = asObject(linksRaw);
    input.links = {
      ...(links['prs'] !== undefined ? { prs: links['prs'] as string[] } : {}),
      ...(links['commits'] !== undefined ? { commits: links['commits'] as string[] } : {}),
      ...(links['docs'] !== undefined ? { docs: links['docs'] as string[] } : {}),
      ...(links['branch'] !== undefined ? { branch: links['branch'] as string | null } : {}),
    };
  }
  // The actor supplied by the CALLER is authoritative (the api-server resolves it
  // from the token/actor context); a client-supplied `actor` in the body is
  // ignored on purpose — history must not be forgeable by whoever is posting.
  return input;
}

const isActionName = (value: unknown): value is TaskActionName =>
  typeof value === 'string' && (TASK_ACTIONS as readonly string[]).includes(value);

const isLinkField = (value: unknown): value is TaskLinkField =>
  typeof value === 'string' && (TASK_LINK_FIELDS as readonly string[]).includes(value);

/** Task-action structural parse. Returns a discriminated action ready for the
 *  session-scoped service mutation. */
export function parseTaskActionBody(body: unknown): TaskActionInput {
  const raw = asObject(body);
  const action = raw['action'];
  if (!isActionName(action)) {
    throw new TaskError('invalid', `action is required, one of ${TASK_ACTIONS.join(', ')}`);
  }
  switch (action) {
    case 'status': {
      const status = raw['status'];
      if (typeof status !== 'string') throw new TaskError('invalid', 'status is required');
      const reason = optionalString(raw, 'reason') ?? optionalString(raw, 'statusReason');
      const note = optionalString(raw, 'note');
      return {
        action: 'status',
        status: status as TaskStatus,
        ...(reason !== undefined ? { reason } : {}),
        ...(note !== undefined ? { note } : {}),
      };
    }
    case 'phase': {
      const phase = raw['phase'];
      if (typeof phase !== 'string' || !(TASK_PHASES as readonly string[]).includes(phase)) {
        throw new TaskError('invalid', `phase must be one of ${TASK_PHASES.join(', ')}`);
      }
      const reason = optionalString(raw, 'reason');
      if (reason === undefined) throw new TaskError('invalid', 'phase requires a reason');
      return { action: 'phase', phase: phase as TaskPhase, reason };
    }
    case 'note':
    case 'feedback': {
      const text = optionalString(raw, 'text');
      if (text === undefined) throw new TaskError('invalid', `${action} requires text`);
      return { action, text };
    }
    case 'clarify': {
      const text = optionalString(raw, 'text');
      const source = optionalString(raw, 'source');
      if (text === undefined || source === undefined) {
        throw new TaskError('invalid', 'clarify requires verbatim text and a source message link');
      }
      return { action: 'clarify', text, source };
    }
    case 'dependency': {
      const taskId = optionalString(raw, 'taskId') ?? optionalString(raw, 'dependsOn');
      if (taskId === undefined) throw new TaskError('invalid', 'dependency requires a task id');
      if (raw['remove'] !== undefined && typeof raw['remove'] !== 'boolean') {
        throw new TaskError('invalid', 'dependency remove must be a boolean');
      }
      return { action: 'dependency', taskId, ...(raw['remove'] === true ? { remove: true } : {}) };
    }
    case 'file': {
      const path = optionalString(raw, 'path');
      if (path === undefined) throw new TaskError('invalid', 'file requires a path');
      if (raw['remove'] !== undefined && typeof raw['remove'] !== 'boolean') {
        throw new TaskError('invalid', 'file remove must be a boolean');
      }
      // A reason is advisory for file claims — accepted and recorded when present,
      // never required (unlike phase/status moves).
      const reason = optionalString(raw, 'reason');
      return {
        action: 'file',
        path,
        ...(raw['remove'] === true ? { remove: true } : {}),
        ...(reason !== undefined ? { reason } : {}),
      };
    }
    case 'link': {
      const field = raw['field'];
      if (!isLinkField(field))
        throw new TaskError('invalid', `link field must be one of ${TASK_LINK_FIELDS.join(', ')}`);
      const value = optionalString(raw, 'value');
      if (value === undefined) throw new TaskError('invalid', 'link requires a value');
      return { action: 'link', field, value };
    }
    case 'assign': {
      const assignee = raw['assignee'];
      if (assignee !== null && typeof assignee !== 'string') {
        throw new TaskError('invalid', 'assignee must be a string, or null to unassign');
      }
      return { action: 'assign', assignee: assignee as string | null };
    }
    case 'order': {
      const order = raw['order'];
      if (order !== null && typeof order !== 'number') {
        throw new TaskError('invalid', 'order must be a number, or null to unrank');
      }
      return { action: 'order', order: order as number | null };
    }
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** TaskError → HTTP status. `read-only` can only happen if a non-daemon process
 *  built a writable store, which is a bug, not a client mistake — but it answers
 *  403 rather than 500 because the message tells the caller exactly what to do
 *  instead (go through the API). */
export function taskErrorStatus(code: TaskError['code']): number {
  switch (code) {
    case 'not-found':
      return 404;
    case 'too-long':
      return 413;
    case 'read-only':
    case 'forbidden':
    case 'approval-required':
      return 403;
    case 'ambiguous':
    case 'dependency-conflict':
      return 409;
    case 'invalid':
    case 'reason-required':
    case 'transition':
    case 'cycle':
      return 400;
  }
}

/** The JSON body for a refused task request: the message the CLI prints verbatim,
 *  plus the machine code so a client can branch (the UI distinguishes
 *  "reason-required" — it needs to prompt for one). */
export function taskErrorBody(error: TaskError): { error: string; code: TaskError['code'] } {
  return { error: error.message, code: error.code };
}

// ---------------------------------------------------------------------------
// Renders — markdown is a VIEW, never storage (design §2)
// ---------------------------------------------------------------------------

/** The board's legend, kept because it is the user's vocabulary. */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  live: '🟢 LIVE',
  done: '✅ DONE',
  built: '🟡 BUILT',
  in_progress: '🔵 IN PROGRESS',
  designed: '🟣 DESIGNED',
  researched: '🟠 RESEARCHED',
  todo: '⚪ NOT STARTED',
  blocked: '🟤 BLOCKED',
  dropped: '❌ NOT POSSIBLE',
};

/** What a staleness flag means, in the words the badge shows. */
export const TASK_STALENESS_COPY: Record<TaskStaleness, string> = {
  'assignee-dead': 'assignee is not running — verify this is still moving',
  'maybe-finished': 'assignee reported finished — verify, then set the status',
  quiet: 'no activity for a while — check it has not silently stopped',
};

const cell = (value: string | null | undefined): string => (value ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/** Render summaries as the old STATUS-BOARD table: the blocked strip first
 *  (design §7 — "What I need from you" is what the user acts on), then one
 *  section per status in board order. This is `kteam task list --md`, an escape
 *  hatch and a terminal view, NEVER written back to a file. */
export function renderTaskBoardMd(tasks: readonly TaskSummary[]): string {
  const lines: string[] = ['# Tasks', ''];
  const blocked = tasks.filter(task => task.blocked);
  const blockedIds = new Set(blocked.map(task => task.id));
  if (blocked.length > 0) {
    lines.push('## What I need from you', '');
    for (const task of blocked) {
      lines.push(`- **${taskReference(task.id)}** ${cell(task.title)} — ${cell(task.blockedReason)}`);
    }
    lines.push('');
  }
  for (const status of TASK_BOARD_ORDER) {
    if (status === 'blocked') continue; // already shown, loudly, at the top
    const rows = tasks.filter(task => task.status === status && !blockedIds.has(task.id));
    if (rows.length === 0) continue;
    lines.push(
      `## ${TASK_STATUS_LABEL[status]} (${rows.length})`,
      '',
      '| id | title | who | note |',
      '| --- | --- | --- | --- |',
    );
    for (const task of rows) {
      const flag = task.live.staleness === null ? '' : ` ⚠️ ${task.live.staleness}`;
      lines.push(
        `| ${taskReference(task.id)} | ${cell(task.title)} | ${cell(task.assignee)}${flag} | ${cell(task.statusReason)} |`,
      );
    }
    lines.push('');
  }
  if (tasks.length === 0) lines.push('_No tasks._', '');
  return lines.join('\n');
}

/** Render one task for `kteam task show --md`: the declared record, the derived
 *  annotation (clearly labelled as derived), the full brief, then the history. */
export function renderTaskMd(detail: TaskDetailResponse): string {
  const { task, activity } = detail;
  // Renderers also serve compatibility callers, which may still hold a v1
  // object that did not pass through the additive on-disk parser. Treat every
  // v2 collection as empty instead of crashing the whole CLI on an old record.
  const dependsOn = task.dependsOn ?? [];
  const blockedBy = task.blockedBy ?? [];
  const clarifications = task.clarifications ?? [];
  const files = task.files ?? [];
  const workflow = task.workflow ?? 'quick';
  const phase = task.phase ?? taskPhaseFromStatus(task.status);
  const ask = task.ask ?? {
    text: task.description.trim().length > 0 ? task.description : task.title,
    source: 'legacy record (source unavailable)',
  };
  const lines: string[] = [
    `# ${taskReference(task.id)} · ${task.title}`,
    '',
    `- status: **${TASK_STATUS_LABEL[task.status]}**${task.statusReason ? ` — ${task.statusReason}` : ''}`,
    `- workflow: ${workflow}`,
    `- phase: ${phase}`,
    `- depends on: ${dependsOn.length > 0 ? dependsOn.map(taskReference).join(', ') : '—'}`,
    `- files (advisory): ${files.length > 0 ? files.map(file => `\`${file}\``).join(', ') : '—'}`,
    `- kind: ${task.kind}`,
    `- assignee: ${task.assignee ?? '—'}`,
    `- repo: ${task.repo ?? '—'}`,
    `- order: ${task.order ?? '—'}`,
    `- updated: ${task.updatedAt}`,
  ];
  if (task.live.staleness !== null) {
    lines.push(`- ⚠️ derived: ${TASK_STALENESS_COPY[task.live.staleness]} (declared status unchanged)`);
  }
  if (task.blocked) {
    lines.push(
      `- 🚧 blocked since ${task.blockedSince ?? 'unknown'}: ${task.blockedReason ?? 'unknown'}${
        blockedBy.length > 0 ? ` (${blockedBy.map(taskReference).join(', ')})` : ''
      }`,
    );
  }
  const links = [
    ...task.links.prs.map(pr => `PR ${pr}`),
    ...(task.links.branch !== null ? [`branch ${task.links.branch}`] : []),
    ...task.links.commits.map(sha => `commit ${sha}`),
    ...task.links.docs.map(doc => `doc ${doc}`),
  ];
  if (links.length > 0) lines.push('', '## Links', '', ...links.map(link => `- ${link}`));
  lines.push('', '## Original ask', '', `> ${ask.text.replace(/\n/g, '\n> ')}`, '', `[Source message](${ask.source})`);
  if (clarifications.length > 0) {
    lines.push('', '## Clarifications', '');
    for (const clarification of clarifications) {
      lines.push(
        `- ${clarification.at} (${clarification.byName ?? clarification.by}): ${clarification.text} — ${clarification.source}`,
      );
    }
  }
  lines.push('', '## Brief', '', task.description.trim().length > 0 ? task.description : '_No description._');
  lines.push('', '## Activity', '');
  if (activity.length === 0) lines.push('_No activity._');
  for (const entry of activity) {
    lines.push(
      `- ${entry.seq}. \`${entry.time}\` **${entry.type}** (${entry.actorName ?? entry.actor}) ${summariseActivity(entry)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** One-line human summary of an activity record — shared by the markdown render
 *  and available to the UI timeline so both describe history the same way. */
export function summariseActivity(entry: TaskActivity): string {
  const data = entry.data;
  const text = typeof data['text'] === 'string' ? data['text'] : null;
  const note = typeof data['note'] === 'string' ? data['note'] : null;
  switch (entry.type) {
    case 'created':
      return `as ${String(data['status'] ?? 'todo')}`;
    case 'status':
      return `${String(data['from'] ?? '?')} → ${String(data['to'] ?? '?')}${
        data['reason'] ? ` (${String(data['reason'])})` : ''
      }${note ? `: ${note}` : ''}`;
    case 'note':
    case 'feedback':
      return text ?? '';
    case 'clarification':
      return `${text ?? ''} (${String(data['source'] ?? 'source unavailable')})`;
    case 'dependency':
      return `${String(data['operation'] ?? 'add')} ${taskReference(String(data['taskId'] ?? '?'))}`;
    case 'file':
      return `${String(data['operation'] ?? 'add')} \`${String(data['path'] ?? '?')}\`${
        data['reason'] ? ` (${String(data['reason'])})` : ''
      }`;
    case 'link':
      return `${String(data['field'] ?? '?')} = ${String(data['value'] ?? '')}`;
    case 'assign':
      return `${String(data['from'] ?? '—')} → ${String(data['to'] ?? '—')}`;
    case 'order':
      return `${String(data['from'] ?? '—')} → ${String(data['to'] ?? '—')}`;
    case 'session':
      return `${String(data['session'] ?? '?')} ${String(data['event'] ?? '')}${
        data['turn'] !== undefined ? ` (turn ${String(data['turn'])})` : ''
      }`;
  }
}
