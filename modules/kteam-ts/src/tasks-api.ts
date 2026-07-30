// The per-session /v1/sessions/:id/tasks route handler (plus legacy global
// read/write compatibility), self-contained and transport-shaped rather than
// Bun-shaped: it takes a method + URL + already-parsed JSON body and returns
// `{ status, body }`, or NULL when the path is not a task route.
//
// WHY IT LIVES OUTSIDE api-server.ts: that file is one of the most contended in
// the tree. Its whole task patch becomes:
//
//     const taskApi = new TaskApi(options.tasks);            // once, at startup
//     …
//     const answered = await taskApi.handle({
//       method: request.method,
//       url,
//       body: request.method === 'POST' ? await body(request) : undefined,
//       actor: { actor: actor.sessionId ?? 'user', actorName: actor.name },
//       requestId: request.headers.get('x-kteam-request-id') ?? undefined,
//     });
//     if (answered) return json(answered.body, answered.status);
//
// …and the warden gate gains one line (`taskWardenDenial`). Everything else —
// routing, validation, idempotency, error mapping — is here, and tested here.
//
// IDEMPOTENCY mirrors api-server's DEDUPED_ACTIONS contract, because a task
// mutation has exactly the retry problem a `send` has: the CLI's POST succeeded,
// the RESPONSE was lost, the CLI retries, and a second `note` line appears in
// history forever. Every POST carrying `x-kteam-request-id` is therefore applied
// AT MOST ONCE: a duplicate that arrives afterwards replays the first response,
// and a duplicate that overlaps the still-running first attempt shares its
// promise (and its failure, so a genuine error stays retryable for both callers).

import {
  TaskError,
  isTaskError,
  type TaskActor,
  type TaskActionInput,
  type TaskCreateInput,
  type FleetTaskListResponse,
  type TaskDetailResponse,
  type TaskListResponse,
  type ScopedTaskDetailResponse,
  type ScopedTaskView,
  type SessionTaskListResponse,
} from './tasks-types';
import {
  matchTaskRoute,
  parseAfterSeq,
  parseTaskActionBody,
  parseTaskCreateBody,
  parseTaskListQuery,
  taskErrorBody,
  taskErrorStatus,
} from './tasks-contract';

/** The narrow slice of TaskService the routes need. `TaskService` satisfies it
 *  structurally, and a test can pass a stub. */
export interface TaskApiService {
  /** Fleet-wide READ compatibility. */
  taskList(
    filter: ReturnType<typeof parseTaskListQuery>,
    actor?: TaskActor,
  ): Promise<TaskListResponse | FleetTaskListResponse>;
  taskDetail(
    id: string,
    afterSeq?: number,
    actor?: TaskActor,
  ): Promise<TaskDetailResponse | ScopedTaskDetailResponse | undefined>;
  sessionTaskList?(
    sessionId: string,
    filter: ReturnType<typeof parseTaskListQuery>,
    actor?: TaskActor,
  ): Promise<SessionTaskListResponse>;
  sessionTaskDetail?(
    sessionId: string,
    id: string,
    afterSeq?: number,
    actor?: TaskActor,
  ): Promise<ScopedTaskDetailResponse | undefined>;
  sessionTaskCreate?(sessionId: string, input: TaskCreateInput, actor: TaskActor): Promise<ScopedTaskView>;
  sessionTaskAct?(sessionId: string, id: string, input: TaskActionInput, actor: TaskActor): Promise<ScopedTaskView>;
  /** @deprecated Direct/global mutation ports retained only for old test doubles. */
  taskCreate?(input: TaskCreateInput & TaskActor): Promise<import('./tasks-types').TaskView>;
  /** @deprecated See taskCreate. No route calls it. */
  taskAct?(id: string, input: TaskActionInput & TaskActor): Promise<import('./tasks-types').TaskView>;
  subscribe?(listener: (event: import('./types').KTeamEvent) => void): () => void;
}

export interface TaskApiRequest {
  method: string;
  url: URL;
  /** The parsed JSON body for a POST. Parsing (and its own 400) stays with the
   *  caller, which already has that helper. */
  body?: unknown;
  /** Resolved by the api-server from the token/actor context — NEVER from the
   *  request body, so history cannot be forged by whoever is posting. */
  actor?: TaskActor;
  /** `x-kteam-request-id`, the idempotency key. */
  requestId?: string;
}

export interface TaskApiResponse {
  status: number;
  body: unknown;
}

/** Key-sorted JSON, so two bodies that differ only in field ORDER fingerprint
 *  identically — a retry must not be treated as a new operation because the
 *  client serialised its object differently. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The dedupe key BINDS the request id to the CLIENT PAYLOAD it was used for —
 *  the same discipline the session-create path uses (`Bun.hash(body)` in
 *  api-client.ts). It is the raw body, deliberately: resolved actor metadata is
 *  NOT part of the identity of a call (a rename between retries must not split
 *  one logical write into two).
 *
 *  WHY: keying on the id alone means a client that reuses one id for two
 *  DIFFERENT payloads gets the first task back for the second call — a silent
 *  wrong answer, and the worst possible failure for a board whose whole purpose
 *  is not lying. With the payload in the key, a reused id carrying different
 *  content is simply a different operation and both are applied; a genuine retry
 *  (identical payload) still replays exactly once. No new error class, and no
 *  legitimate client is ever blocked. */
function dedupeKey(scope: string, requestId: string | undefined, payload: unknown): string {
  return `${scope}\n${requestId ?? ''}\n${Bun.hash(canonicalJson(payload)).toString(16)}`;
}

/** Insertion-ordered, hard-capped store of already-applied request ids →
 *  response, so a retry replays instead of re-applying. Same shape as
 *  api-server's RecentRequestIds/BoundedMap pair, kept local so this module does
 *  not depend on a contended file. */
class AppliedRequests {
  private readonly entries = new Map<string, TaskApiResponse>();
  constructor(private readonly capacity = 200) {}

  get(key: string): TaskApiResponse | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Touch, so a client that keeps retrying the same id keeps its entry.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: TaskApiResponse): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }

  get size(): number {
    return this.entries.size;
  }
}

export class TaskApi {
  private readonly applied = new AppliedRequests();
  private readonly inFlight = new Map<string, Promise<TaskApiResponse>>();

  constructor(private readonly service: TaskApiService) {}

  /** Forward the live `tasks.updated` stream to the API server's broadcaster. */
  subscribe(listener: (event: import('./types').KTeamEvent) => void): () => void {
    return this.service.subscribe?.(listener) ?? ((): void => {});
  }

  /** Handle a task request, or return null when `url.pathname` is not ours.
   *
   *  Never throws for a client mistake: every TaskError becomes a status + body
   *  (`taskErrorStatus`/`taskErrorBody`). A non-TaskError is rethrown so the
   *  caller's own 500 handling and logging still apply — a genuine daemon bug
   *  must not be laundered into a 400. */
  async handle(request: TaskApiRequest): Promise<TaskApiResponse | null> {
    const route = matchTaskRoute(request.method, request.url.pathname);
    if (route === null) return null;
    try {
      switch (route.kind) {
        case 'list': {
          const filter = parseTaskListQuery(request.url.searchParams);
          return { status: 200, body: await this.service.taskList(filter, request.actor) };
        }
        case 'detail': {
          const detail = await this.service.taskDetail(
            route.id,
            parseAfterSeq(request.url.searchParams),
            request.actor,
          );
          if (detail === undefined) {
            return { status: 404, body: { error: `unknown task ${route.id}`, code: 'not-found' } };
          }
          return { status: 200, body: detail };
        }
        case 'create': {
          const input = parseTaskCreateBody(request.body);
          const createMethod = this.service.taskCreate;
          if (!createMethod) throw new Error('compatibility task create service is not configured');
          const create = createMethod.bind(this.service);
          const actor = { ...(request.actor ?? {}), requestId: request.requestId };
          const scope =
            typeof actor.actor === 'string' && actor.actor.trim() && actor.actor !== 'user'
              ? actor.actor.trim()
              : typeof input.assignee === 'string' && input.assignee.trim()
                ? input.assignee.trim()
                : 'unresolved';
          return await this.once(
            dedupeKey(`${scope}#create`, request.requestId, request.body),
            request.requestId,
            async () => ({ status: 201, body: await create({ ...input, ...actor }) }),
          );
        }
        case 'action': {
          const input = parseTaskActionBody(request.body);
          const actMethod = this.service.taskAct;
          if (!actMethod) throw new Error('compatibility task action service is not configured');
          const act = actMethod.bind(this.service);
          return await this.once(dedupeKey(route.id, request.requestId, request.body), request.requestId, async () => ({
            status: 200,
            body: await act(route.id, { ...input, ...(request.actor ?? {}), requestId: request.requestId }),
          }));
        }
        case 'session-list': {
          const filter = parseTaskListQuery(request.url.searchParams);
          if (!this.service.sessionTaskList) throw new Error('session task list service is not configured');
          return { status: 200, body: await this.service.sessionTaskList(route.sessionId, filter, request.actor) };
        }
        case 'session-detail': {
          if (!this.service.sessionTaskDetail) throw new Error('session task detail service is not configured');
          const detail = await this.service.sessionTaskDetail(
            route.sessionId,
            route.id,
            parseAfterSeq(request.url.searchParams),
            request.actor,
          );
          if (detail === undefined) {
            return {
              status: 404,
              body: { error: `unknown task ${route.id} in session ${route.sessionId}`, code: 'not-found' },
            };
          }
          return { status: 200, body: detail };
        }
        case 'session-create': {
          const input = parseTaskCreateBody(request.body);
          const createMethod = this.service.sessionTaskCreate;
          if (!createMethod) throw new Error('session task create service is not configured');
          const create = createMethod.bind(this.service);
          // Fingerprint the CLIENT payload, never the parsed input: the parsed
          // input carries resolved actor metadata, and a teammate rename (or a
          // transient session lookup failure) between two attempts of the SAME
          // logical call would otherwise change the key and write twice.
          return await this.once(
            dedupeKey(`${route.sessionId}#create`, request.requestId, request.body),
            request.requestId,
            async () => ({
              status: 201,
              body: await create(route.sessionId, input, {
                ...(request.actor ?? {}),
                requestId: request.requestId,
              }),
            }),
          );
        }
        case 'session-action': {
          const input = parseTaskActionBody(request.body);
          const actMethod = this.service.sessionTaskAct;
          if (!actMethod) throw new Error('session task action service is not configured');
          const act = actMethod.bind(this.service);
          return await this.once(dedupeKey(route.id, request.requestId, request.body), request.requestId, async () => ({
            status: 200,
            body: await act(route.sessionId, route.id, input, {
              ...(request.actor ?? {}),
              requestId: request.requestId,
            }),
          }));
        }
      }
    } catch (error) {
      if (isTaskError(error)) return { status: taskErrorStatus(error.code), body: taskErrorBody(error) };
      throw error;
    }
  }

  /** Apply once per request id. Without an id there is nothing to dedupe on, so
   *  the operation simply runs (the CLI always sends one). */
  private async once(
    key: string,
    requestId: string | undefined,
    operation: () => Promise<TaskApiResponse>,
  ): Promise<TaskApiResponse> {
    if (requestId === undefined) return operation();
    const replay = this.applied.get(key);
    if (replay !== undefined) return replay;
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;
    const attempt = (async () => {
      const response = await operation();
      this.applied.set(key, response);
      return response;
    })();
    this.inFlight.set(key, attempt);
    try {
      return await attempt;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Diagnostics for tests: how many request ids are remembered. */
  get rememberedRequests(): number {
    return this.applied.size;
  }
}

// ---------------------------------------------------------------------------
// Actor attribution
// ---------------------------------------------------------------------------

/** The one capability actor resolution needs. `KTeamService.get` satisfies it;
 *  the returned shape is deliberately narrow so a stub is two lines. */
export interface TaskActorLookup {
  get(id: string): Promise<{ config: { id: string; teammate?: string; name?: string } } | undefined>;
}

export interface TaskActorInput {
  /** `x-kteam-session-id` — present when the call came from inside a
   *  teammate/warden pane, absent for the human's own shell and the browser. */
  sessionId?: string | null;
  /** Optionally the api-server's own actor string (`peer:<id>`, `warden:<id>`,
   *  `admin-cli`, `admin-ui`); the session id is lifted out of the prefixed
   *  forms so the caller can pass whichever it has to hand. */
  actorSource?: string | null;
}

export type ResolvedTaskActor = TaskActor & { actor: string; actorName: string | null };

const sessionRefOf = (input: TaskActorInput): string | null => {
  const direct = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (direct.length > 0) return direct;
  const source = typeof input.actorSource === 'string' ? input.actorSource.trim() : '';
  const colon = source.indexOf(':');
  if (colon === -1) return null; // 'admin-cli' / 'admin-ui' / 'warden' carry no id
  const id = source.slice(colon + 1).trim();
  return id.length > 0 ? id : null;
};

/** Resolve who to record on an activity line: the canonical session id plus its
 *  teammate callsign, or `user`/`user` for a human at the CLI or the browser.
 *
 *  ATTRIBUTION ONLY, NEVER AUTHORIZATION. The bearer token already authorized the
 *  request; this decides whose name appears in history. Body-supplied `actor`
 *  fields stay ignored (see `parseTaskCreateBody`), so a caller cannot sign
 *  somebody else's name to a status change.
 *
 *  A session id that does not resolve keeps the RAW id with a null name rather
 *  than degrading to `user`: writing "user" onto an agent's action would put the
 *  human's name on work they did not do, which is a worse answer than an
 *  unrecognised id. Only an absent/blank identity reads as the human. */
export async function resolveTaskActor(
  lookup: TaskActorLookup | undefined,
  input: TaskActorInput,
): Promise<ResolvedTaskActor> {
  const ref = sessionRefOf(input);
  if (ref === null) return { actor: 'user', actorName: 'user', humanAdmin: true };
  const view = lookup === undefined ? undefined : await lookup.get(ref).catch(() => undefined);
  if (view === undefined) return { actor: ref, actorName: null };
  const name = view.config.teammate ?? view.config.name ?? null;
  return { actor: view.config.id, actorName: name !== null && name.trim().length > 0 ? name : null };
}

/** Convenience for a caller that already has a `Request`: the exact fields
 *  `handle` wants, minus the body (which the caller parses with its own helper
 *  so JSON errors keep their existing message). */
export function taskApiRequestFrom(
  request: { method: string; headers: { get(name: string): string | null } },
  url: URL,
  body: unknown,
  actor: TaskActor,
): TaskApiRequest {
  return {
    method: request.method,
    url,
    body,
    actor,
    requestId: request.headers.get('x-kteam-request-id') ?? undefined,
  };
}

/** Re-exported so the wiring patch imports one module. */
export { TaskError };
