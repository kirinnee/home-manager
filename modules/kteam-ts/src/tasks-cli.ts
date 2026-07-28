// `kteam task …` — argv parsing, request building and terminal rendering, all
// pure. index.ts is contended, so its patch is a dispatch of a handful of lines:
//
//     const task = program.command('task').allowUnknownOption(true);
//     task.argument('[args...]').action(async (argv: string[]) => {
//       const command = parseTaskCli(argv);            // throws TaskError('invalid') with usage
//       const request = taskCliRequest(command);       // { method, path, body }
//       const response = await client.request(request.method, request.path, request.body);
//       process.stdout.write(renderTaskCli(command, response));
//     });
//
// Everything a reviewer would want to argue about — flag names, defaults, what
// `--md` prints, how a staleness badge reads in a terminal — is here and tested.
//
// TWO DELIBERATE NON-GOALS:
//  • No I/O. `--description-file` returns the PATH in the parsed command and the
//    wiring reads it, so this module stays pure and the file error stays the
//    caller's (which already has the right message shape for a missing file).
//  • No HTTP. `taskCliRequest` describes the call; the existing api-client makes
//    it, with the `x-kteam-request-id` header it already sends for retryable
//    mutations (see tasks-api.ts for the at-most-once contract that pairs with it).

import {
  TASK_BOARD_LANES,
  TASK_KINDS,
  TASK_LINK_FIELDS,
  TASK_PHASES,
  TASK_STATUSES,
  TASK_WORKFLOWS,
  TaskError,
  taskReference,
  type TaskActionInput,
  type TaskDetailResponse,
  type TaskKind,
  type TaskLinkField,
  type TaskPhase,
  type TaskListResponse,
  type TaskStatus,
  type TaskSummary,
  type TaskView,
} from './tasks-types';
import { normalizeTaskId } from './tasks-store';
import { TASK_STALENESS_COPY, TASK_STATUS_LABEL, renderTaskBoardMd, renderTaskMd } from './tasks-contract';
import { taskBoardLaneFromPhase, taskPhaseFromStatus } from './tasks-workflow';
import { TASK_TITLE_GUIDANCE, taskTitleIssue } from './task-title';

export const TASK_CLI_USAGE = `kteam task <command>

  create --kind <${TASK_KINDS.join('|')}> --title <title>
         ${TASK_TITLE_GUIDANCE}
         --ask <verbatim-human-words> --ask-source <message-link>
         [--workflow <${TASK_WORKFLOWS.join('|')}>] [--depends-on <#F12>]…
         [--file <path>]…
         [--description <text> | --description-file <file>] [--status <status>]
         [--reason <why>] [--repo <path>] [--assignee <who>] [--order <n>]
         [--pr <url>] [--branch <b>] [--commit <sha>] [--doc <path>]
  list   [--view <list|kanban|dag>] [--repo <path>] [--status <status>]… [--assignee <who>] [--kind <kind>] [--md]
  show   <id> [--after <seq>] [--md]
  status <id> <${TASK_STATUSES.join('|')}> [--reason <why>] [--note <text>]
  phase  <id> <${TASK_PHASES.join('|')}> --reason <why>
  clarify <id> <verbatim-text> --source <message-link>
  depend <id> <dependency-id> [--remove]
  file   <id> <path> [--remove] [--reason <why>]
  note   <id> <text>
  feedback <id> <text>
  link   <id> --pr <url> | --branch <b> | --commit <sha> | --doc <path>
  assign <id> <who|--none>
  order  <id> <n|--none>

  [--session <id>]       target a session explicitly; otherwise use
                         KTEAM_SESSION_ID (an agent may only write its own)
  list --all             fleet-wide aggregate READ

Every status/phase action REQUIRES --reason; creating blocked or dropped does too.
Research, design, and build remain audit phases but share the in_progress board lane.
File claims are ADVISORY (never a lock); --reason on file is optional.`;

export interface TaskCreateBody {
  kind: TaskKind;
  title: string;
  description?: string;
  ask?: { text: string; source: string };
  workflow?: (typeof TASK_WORKFLOWS)[number];
  dependsOn?: string[];
  files?: string[];
  status?: TaskStatus;
  statusReason?: string;
  repo?: string;
  assignee?: string;
  order?: number;
  links?: { prs?: string[]; branch?: string; commits?: string[]; docs?: string[] };
}

export type TaskCliCommand =
  | { command: 'create'; body: TaskCreateBody; descriptionFile?: string; session?: string }
  | {
      command: 'list';
      query: URLSearchParams;
      md: boolean;
      view: 'list' | 'kanban' | 'dag';
      all?: boolean;
      session?: string;
    }
  | { command: 'show'; id: string; afterSeq: number; md: boolean; session?: string }
  | { command: 'act'; id: string; body: TaskActionInput; session?: string };

/** A parsed argv, as flags and positionals. `--flag value` and `--flag=value`
 *  both work; a repeated flag collects. */
export function splitTaskArgs(argv: readonly string[]): { positional: string[]; flags: Map<string, string[]> } {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const push = (name: string, value: string): void => {
    const list = flags.get(name);
    if (list) list.push(value);
    else flags.set(name, [value]);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      push(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    // A bare flag (--md, --none) records the empty string, so callers can test
    // presence without the parser having to know which flags take a value.
    if (next === undefined || next.startsWith('--')) {
      push(body, '');
      continue;
    }
    push(body, next);
    index += 1;
  }
  return { positional, flags };
}

const one = (flags: Map<string, string[]>, name: string): string | undefined => flags.get(name)?.at(-1);
const has = (flags: Map<string, string[]>, name: string): boolean => flags.has(name);
const invalid = (message: string): never => {
  throw new TaskError('invalid', `${message}\n\n${TASK_CLI_USAGE}`);
};

const requireId = (value: string | undefined): string => {
  const id = value === undefined ? null : normalizeTaskId(value);
  if (id === null) return invalid(`expected a task id like F21, got ${value === undefined ? 'nothing' : value}`);
  return id;
};

const requireStatus = (value: string | undefined): TaskStatus => {
  if (value === undefined || !(TASK_STATUSES as readonly string[]).includes(value)) {
    return invalid(`status must be one of ${TASK_STATUSES.join(', ')}`);
  }
  return value as TaskStatus;
};

const requireNumber = (value: string, label: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return invalid(`${label} must be a whole number (or --none)`);
  return parsed;
};

/** Parse `kteam task …` argv (WITHOUT the leading `task`). Throws
 *  TaskError('invalid') whose message already contains the usage block, so the
 *  wiring prints `error.message` and exits 1. */
export function parseTaskCli(argv: readonly string[]): TaskCliCommand {
  const { positional, flags } = splitTaskArgs(argv);
  const command = positional[0];
  const rawSession = one(flags, 'session');
  const session = rawSession !== undefined && rawSession.trim().length > 0 ? rawSession.trim() : undefined;
  const scoped = session === undefined ? {} : { session };
  if (has(flags, 'all') && command !== 'list') return invalid('--all is only valid with task list');
  if (has(flags, 'all') && session !== undefined) return invalid('task list accepts --all or --session, not both');
  switch (command) {
    case 'create':
      return parseCreate(flags, positional.slice(1), session);
    case 'list':
      return {
        command: 'list',
        query: buildTaskListQuery(flags),
        md: has(flags, 'md'),
        view: (() => {
          const view = one(flags, 'view') ?? (has(flags, 'kanban') ? 'kanban' : has(flags, 'dag') ? 'dag' : 'list');
          if (view !== 'list' && view !== 'kanban' && view !== 'dag')
            return invalid('--view must be list, kanban, or dag');
          return view;
        })(),
        all: has(flags, 'all'),
        ...scoped,
      };
    case 'show':
      return {
        command: 'show',
        id: requireId(positional[1]),
        afterSeq: (() => {
          const after = one(flags, 'after');
          return after === undefined || after === '' ? 0 : requireNumber(after, 'after');
        })(),
        md: has(flags, 'md'),
        ...scoped,
      };
    case 'status': {
      const id = requireId(positional[1]);
      const status = requireStatus(positional[2]);
      const reason = one(flags, 'reason');
      const note = one(flags, 'note');
      // Refuse locally too, so the teammate is told what is missing without a
      // round trip (the daemon enforces the same rule — this is not the guard).
      if (reason === undefined || reason.trim() === '') {
        return invalid(`status "${status}" requires --reason so history records why it moved`);
      }
      return {
        command: 'act',
        id,
        body: {
          action: 'status',
          status,
          ...(reason !== undefined && reason !== '' ? { reason } : {}),
          ...(note !== undefined && note !== '' ? { note } : {}),
        },
        ...scoped,
      };
    }
    case 'phase': {
      const id = requireId(positional[1]);
      const phase = positional[2];
      if (phase === undefined || !(TASK_PHASES as readonly string[]).includes(phase)) {
        return invalid(`phase must be one of ${TASK_PHASES.join(', ')}`);
      }
      const reason = one(flags, 'reason');
      if (reason === undefined || reason.trim() === '') return invalid('phase requires --reason');
      return { command: 'act', id, body: { action: 'phase', phase: phase as TaskPhase, reason }, ...scoped };
    }
    case 'clarify': {
      const id = requireId(positional[1]);
      const text = positional.slice(2).join(' ').trim();
      const source = one(flags, 'source');
      if (text.length === 0 || source === undefined || source.trim() === '') {
        return invalid('clarify requires verbatim text and --source <message-link>');
      }
      return { command: 'act', id, body: { action: 'clarify', text, source }, ...scoped };
    }
    case 'depend': {
      const id = requireId(positional[1]);
      const taskId = requireId(positional[2]);
      return {
        command: 'act',
        id,
        body: { action: 'dependency', taskId, ...(has(flags, 'remove') ? { remove: true } : {}) },
        ...scoped,
      };
    }
    case 'file': {
      const id = requireId(positional[1]);
      const path = positional[2];
      if (path === undefined || path.trim().length === 0) {
        return invalid('file needs a path, e.g. task file F21 src/foo.ts');
      }
      // Advisory claim: --reason is welcome but NOT required (unlike status/phase).
      const reason = one(flags, 'reason');
      return {
        command: 'act',
        id,
        body: {
          action: 'file',
          path,
          ...(has(flags, 'remove') ? { remove: true } : {}),
          ...(reason !== undefined && reason.trim() !== '' ? { reason } : {}),
        },
        ...scoped,
      };
    }
    case 'note':
    case 'feedback': {
      const id = requireId(positional[1]);
      const text = positional.slice(2).join(' ').trim();
      if (text.length === 0) return invalid(`${command} needs some text`);
      return { command: 'act', id, body: { action: command, text }, ...scoped };
    }
    case 'link': {
      const id = requireId(positional[1]);
      const fields = TASK_LINK_FIELDS.filter(field => has(flags, field));
      if (fields.length !== 1)
        return invalid(`link needs exactly one of ${TASK_LINK_FIELDS.map(f => `--${f}`).join(', ')}`);
      const field = fields[0] as TaskLinkField;
      const value = one(flags, field) ?? '';
      if (value.trim().length === 0) return invalid(`--${field} needs a value`);
      return { command: 'act', id, body: { action: 'link', field, value }, ...scoped };
    }
    case 'assign': {
      const id = requireId(positional[1]);
      const who = positional[2];
      if (has(flags, 'none')) return { command: 'act', id, body: { action: 'assign', assignee: null }, ...scoped };
      if (who === undefined || who.trim().length === 0)
        return invalid('assign needs a teammate, or --none to unassign');
      return { command: 'act', id, body: { action: 'assign', assignee: who }, ...scoped };
    }
    case 'order': {
      const id = requireId(positional[1]);
      if (has(flags, 'none')) return { command: 'act', id, body: { action: 'order', order: null }, ...scoped };
      const rank = positional[2];
      if (rank === undefined) return invalid('order needs a rank, or --none to unrank');
      return { command: 'act', id, body: { action: 'order', order: requireNumber(rank, 'order') }, ...scoped };
    }
    case undefined:
      return invalid('which task command?');
    default:
      return invalid(`unknown task command "${command}"`);
  }
}

function parseCreate(flags: Map<string, string[]>, rest: readonly string[], session?: string): TaskCliCommand {
  const kind = one(flags, 'kind');
  if (kind === undefined || !(TASK_KINDS as readonly string[]).includes(kind)) {
    return invalid(`--kind must be one of ${TASK_KINDS.join(', ')}`);
  }
  // A bare `create --kind feature "Title"` is accepted as well as --title.
  const title = one(flags, 'title') ?? rest.join(' ');
  if (title.trim().length === 0) return invalid('--title is required');
  const canonicalTitle = title.trim();
  const titleIssue = taskTitleIssue(canonicalTitle);
  if (titleIssue !== null) return invalid(titleIssue);
  const body: TaskCreateBody = { kind: kind as TaskKind, title: canonicalTitle };
  const ask = one(flags, 'ask');
  const askSource = one(flags, 'ask-source');
  if (ask === undefined || ask.length === 0 || askSource === undefined || askSource.trim().length === 0) {
    return invalid('create requires --ask with the human words and --ask-source with the source message link');
  }
  body.ask = { text: ask, source: askSource };
  const workflow = one(flags, 'workflow') ?? 'quick';
  if (!(TASK_WORKFLOWS as readonly string[]).includes(workflow)) {
    return invalid(`--workflow must be one of ${TASK_WORKFLOWS.join(', ')}`);
  }
  body.workflow = workflow as TaskCreateBody['workflow'];
  const dependsOn = flags.get('depends-on') ?? [];
  if (dependsOn.length > 0) body.dependsOn = dependsOn.map(requireId);
  // Advisory file claims: a repeated --file collects. Empty/blank entries are
  // dropped here; the daemon normalizes and de-dupes authoritatively.
  const files = (flags.get('file') ?? []).map(file => file.trim()).filter(file => file.length > 0);
  if (files.length > 0) body.files = files;
  const description = one(flags, 'description');
  if (description !== undefined && description !== '') body.description = description;
  const status = one(flags, 'status');
  if (status !== undefined && status !== '') body.status = requireStatus(status);
  const reason = one(flags, 'reason');
  if (reason !== undefined && reason !== '') body.statusReason = reason;
  if ((body.status === 'blocked' || body.status === 'dropped') && body.statusReason === undefined) {
    return invalid(`status "${body.status}" requires --reason`);
  }
  const repo = one(flags, 'repo');
  if (repo !== undefined && repo !== '') body.repo = repo;
  const assignee = one(flags, 'assignee');
  if (assignee !== undefined && assignee !== '') body.assignee = assignee;
  const order = one(flags, 'order');
  if (order !== undefined && order !== '') body.order = requireNumber(order, 'order');
  const links: NonNullable<TaskCreateBody['links']> = {};
  const prs = (flags.get('pr') ?? []).filter(value => value !== '');
  if (prs.length > 0) links.prs = prs;
  const commits = (flags.get('commit') ?? []).filter(value => value !== '');
  if (commits.length > 0) links.commits = commits;
  const docs = (flags.get('doc') ?? []).filter(value => value !== '');
  if (docs.length > 0) links.docs = docs;
  const branch = one(flags, 'branch');
  if (branch !== undefined && branch !== '') links.branch = branch;
  if (Object.keys(links).length > 0) body.links = links;
  const descriptionFile = one(flags, 'description-file');
  if (descriptionFile !== undefined && descriptionFile !== '') {
    if (body.description !== undefined) return invalid('pass --description or --description-file, not both');
    return { command: 'create', body, descriptionFile, ...(session ? { session } : {}) };
  }
  return { command: 'create', body, ...(session ? { session } : {}) };
}

/** Build the query string for `task list` from parsed flags. Repeated
 *  `--status` collects, matching the API's repeatable filter. */
export function buildTaskListQuery(flags: Map<string, string[]>): URLSearchParams {
  const query = new URLSearchParams();
  const repo = one(flags, 'repo');
  if (repo !== undefined && repo !== '') query.set('repo', repo);
  const assignee = one(flags, 'assignee');
  if (assignee !== undefined && assignee !== '') query.set('assignee', assignee);
  const kind = one(flags, 'kind');
  if (kind !== undefined && kind !== '') {
    if (!(TASK_KINDS as readonly string[]).includes(kind)) invalid(`--kind must be one of ${TASK_KINDS.join(', ')}`);
    query.set('kind', kind);
  }
  for (const status of flags.get('status') ?? []) {
    if (status === '') continue;
    query.append('status', requireStatus(status));
  }
  return query;
}

export interface TaskCliRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

/** The HTTP call a parsed command needs. For `create` with
 *  `--description-file`, the wiring reads the file and merges it in first:
 *  `{ ...command.body, description: await readFile(command.descriptionFile) }`. */
export function taskCliRequest(command: TaskCliCommand, selfSessionId?: string): TaskCliRequest {
  if (command.command === 'list' && command.all) {
    const query = command.query.toString();
    return { method: 'GET', path: query.length > 0 ? `/v1/tasks?${query}` : '/v1/tasks' };
  }
  const sessionId =
    command.session ??
    (selfSessionId !== undefined && selfSessionId.trim().length > 0 ? selfSessionId.trim() : undefined);
  if (sessionId === undefined) {
    throw new TaskError('invalid', 'no session id; run inside a kteam session, pass --session <id>, or use list --all');
  }
  const base = `/v1/sessions/${encodeURIComponent(sessionId)}/tasks`;
  switch (command.command) {
    case 'create':
      return { method: 'POST', path: base, body: command.body };
    case 'list': {
      const query = command.query.toString();
      return { method: 'GET', path: query.length > 0 ? `${base}?${query}` : base };
    }
    case 'show':
      return {
        method: 'GET',
        path: command.afterSeq > 0 ? `${base}/${command.id}?after=${command.afterSeq}` : `${base}/${command.id}`,
      };
    case 'act':
      return { method: 'POST', path: `${base}/${command.id}`, body: command.body };
  }
}

// ---------------------------------------------------------------------------
// Terminal rendering
// ---------------------------------------------------------------------------

const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + ' '.repeat(width - text.length);

/** Board for the terminal: grouped by declared status in board order, blocked
 *  first because that is the section the user acts on. A derived staleness flag
 *  is shown as `⚠ <flag>` next to the assignee and NEVER as a status. */
export function renderTaskListText(response: TaskListResponse): string {
  const lines: string[] = [];
  const ordered = [...response.tasks].sort((a, b) => {
    const aUrgency = a.blocked ? 0 : a.live.staleness !== null ? 1 : 2;
    const bUrgency = b.blocked ? 0 : b.live.staleness !== null ? 1 : 2;
    if (aUrgency !== bUrgency) return aUrgency - bUrgency;
    if (a.blocked && b.blocked) {
      const left = taskListTime(a.blockedSince);
      const right = taskListTime(b.blockedSince);
      if (left !== right) return left - right;
    }
    if (aUrgency === 1) {
      const left = taskListTime(a.updatedAt);
      const right = taskListTime(b.updatedAt);
      if (left !== right) return left - right;
    }
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
  const line = (task: TaskSummary): string => {
    const stalled = task.blocked ? ` 🚧 ${task.blockedReason ?? 'reason unavailable'}` : '';
    const stale = task.live.staleness === null ? '' : ` ⚠ ${task.live.staleness}`;
    const phase = task.phase ?? taskPhaseFromStatus(task.status);
    const primaryState = task.blocked ? 'BLOCKED' : taskBoardLaneFromPhase(phase).replace('_', ' ').toUpperCase();
    return `${pad(taskReference(task.id), 6)} ${pad(primaryState, 11)} ${pad(task.assignee ?? '—', 12)} ${task.title}${stalled}${stale}`;
  };
  const attention = ordered.filter(task => task.blocked && (task.blockedBy ?? []).length === 0);
  if (attention.length > 0) {
    lines.push('ATTENTION');
    for (const task of attention) lines.push(line(task));
    lines.push('');
  }
  for (const task of ordered) {
    if (attention.includes(task)) continue;
    lines.push(line(task));
  }
  if (ordered.length > attention.length) lines.push('');
  if (response.tasks.length === 0) lines.push('No tasks.', '');
  if (response.parseErrors > 0) {
    lines.push(
      `⚠ ${response.parseErrors} task record(s) could not be read and are missing from this board${
        response.parseErrorIds ? `: ${response.parseErrorIds.join(', ')}` : ''
      }`,
      '',
    );
  }
  return lines.join('\n');
}

const taskListTime = (value: string | null): number => {
  if (value === null) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

export function renderTaskKanbanText(response: TaskListResponse): string {
  const lines: string[] = [];
  for (const lane of TASK_BOARD_LANES) {
    const tasks = response.tasks.filter(
      task => taskBoardLaneFromPhase(task.phase ?? taskPhaseFromStatus(task.status)) === lane,
    );
    if (tasks.length === 0) continue;
    lines.push(`${lane.replace('_', ' ').toUpperCase()} (${tasks.length})`);
    for (const task of tasks) {
      lines.push(
        `  ${taskReference(task.id)} ${task.blocked ? `BLOCKED 🚧 ${task.blockedReason ?? 'reason unavailable'} — ` : ''}${task.title}`,
      );
    }
    lines.push('');
  }
  if (response.tasks.length === 0) lines.push('No tasks.', '');
  return lines.join('\n');
}

export function renderTaskDagText(response: TaskListResponse): string {
  const lines = response.tasks.map(task => {
    const dependsOn = task.dependsOn ?? [];
    const edges = dependsOn.length > 0 ? dependsOn.map(taskReference).join(', ') : '∅';
    return `${taskReference(task.id)} → ${edges}${task.blocked ? `  🚧 ${task.blockedReason}` : ''}  ${task.title}`;
  });
  if (lines.length === 0) lines.push('No tasks.');
  return `${lines.join('\n')}\n`;
}

/** One task for the terminal. The derived warning is labelled as derived, so
 *  nobody reads it as a status change. */
export function renderTaskShowText(detail: TaskDetailResponse): string {
  const { task, activity } = detail;
  const workflow = task.workflow ?? 'quick';
  const phase = task.phase ?? taskPhaseFromStatus(task.status);
  const dependsOn = task.dependsOn ?? [];
  const files = task.files ?? [];
  const clarifications = task.clarifications ?? [];
  const ask = task.ask ?? {
    text: task.description.trim().length > 0 ? task.description : task.title,
    source: 'legacy record (source unavailable)',
  };
  const lines = [
    `${taskReference(task.id)}  ${task.title}`,
    `workflow  ${workflow}`,
    `phase     ${phase}`,
    `status    ${task.status}${task.statusReason ? ` — ${task.statusReason}` : ''}`,
    `kind      ${task.kind}`,
    `assignee  ${task.assignee ?? '—'}${task.live.assigneeStatus ? ` (${task.live.assigneeStatus})` : ''}`,
    `repo      ${task.repo ?? '—'}`,
    `order     ${task.order ?? '—'}`,
    `updated   ${task.updatedAt}`,
  ];
  if (task.live.staleness !== null) lines.push(`⚠ derived  ${TASK_STALENESS_COPY[task.live.staleness]}`);
  if (task.blocked)
    lines.push(`🚧 blocked  ${task.blockedReason ?? 'blocked'} since ${task.blockedSince ?? 'unknown'}`);
  lines.push(`depends   ${dependsOn.length > 0 ? dependsOn.map(taskReference).join(', ') : '—'}`);
  lines.push(`files     ${files.length > 0 ? files.join(', ') : '—'} (advisory)`);
  const links = [
    ...task.links.prs.map(pr => `pr     ${pr}`),
    ...(task.links.branch !== null ? [`branch ${task.links.branch}`] : []),
    ...task.links.commits.map(sha => `commit ${sha}`),
    ...task.links.docs.map(doc => `doc    ${doc}`),
  ];
  if (links.length > 0) lines.push('', 'links', ...links.map(link => `  ${link}`));
  lines.push('', 'original ask', `  "${ask.text.replace(/\n/g, '\n  ')}"`, `  source ${ask.source}`);
  if (clarifications.length > 0) {
    lines.push('', 'clarifications');
    for (const item of clarifications) lines.push(`  ${item.at} ${item.text} — ${item.source}`);
  }
  if (task.description.trim().length > 0) lines.push('', task.description.trim());
  lines.push('', `activity (${activity.length})`);
  for (const entry of activity) {
    lines.push(`  ${pad(String(entry.seq), 4)} ${entry.time}  ${pad(entry.type, 9)} ${entry.actorName ?? entry.actor}`);
  }
  if (detail.activityParseErrors) lines.push(`  ⚠ ${detail.activityParseErrors} history line(s) unreadable`);
  return `${lines.join('\n')}\n`;
}

/** What a command prints, given the daemon's response. `create` prints the new
 *  id on its own first line, so `id=$(kteam task create …)` style use works. */
export function renderTaskCli(command: TaskCliCommand, response: unknown): string {
  switch (command.command) {
    case 'create': {
      const task = response as TaskView;
      return `${taskReference(task.id)}\n`;
    }
    case 'list': {
      const listed = response as TaskListResponse;
      if (command.md) return renderTaskBoardMd(listed.tasks);
      return command.view === 'kanban'
        ? renderTaskKanbanText(listed)
        : command.view === 'dag'
          ? renderTaskDagText(listed)
          : renderTaskListText(listed);
    }
    case 'show': {
      const detail = response as TaskDetailResponse;
      return command.md ? renderTaskMd(detail) : renderTaskShowText(detail);
    }
    case 'act': {
      const task = response as TaskView;
      const suffix = task.live.staleness === null ? '' : `  ⚠ ${TASK_STALENESS_COPY[task.live.staleness]}`;
      return `${taskReference(task.id)}  ${task.phase}${task.statusReason ? ` — ${task.statusReason}` : ''}${suffix}\n`;
    }
  }
}
