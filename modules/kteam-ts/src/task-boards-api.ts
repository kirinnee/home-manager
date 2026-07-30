import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ResolvedTaskActor } from './tasks-api';
import type { TaskActor } from './tasks-types';
import { atomicJson } from './io';
import { taskBoardSessionCapabilityFile, type KTeamPaths } from './paths';
import {
  TaskBoardError,
  isTaskBoardError,
  type TaskBoardBinding,
  type TaskBoardGrantRequest,
  type TaskBoardInvitation,
  type TaskBoardRole,
} from './task-boards-types';
import type { TaskBoardService, TaskBoardSessionDeps } from './task-boards';
import { legacyTaskBoardSessionIncarnation } from './task-boards-store';

export const TASK_BOARD_API_PREFIX = '/v1/task-board';
export const TASK_BOARD_CAPABILITY_HEADER = 'x-kteam-board-capability';
export const TASK_BOARD_ADMIN_CAPABILITY_HEADER = 'x-kteam-board-admin-capability';
export const TASK_BOARD_SESSION_CAPABILITY_HEADER = 'x-kteam-session-board-capability';

export interface TaskBoardApiActor {
  sessionId: string | null;
  humanAdmin: boolean;
}

export interface TaskBoardApiRequest {
  method: string;
  url: URL;
  body?: unknown;
  actor: TaskBoardApiActor;
  /** Secret transport credential. Never accepted from JSON or derived from the
   * caller-selected session id. For invitation acceptance this carries the
   * one-time invitee capability; every bound peer carries its binding secret. */
  boardCapability?: string;
  /** Distinct daemon-held human operator credential. Shared daemon bearer
   * authentication and an omitted/spoofed session header never imply this. */
  boardAdminCapability?: string;
  /** Pre-membership proof for an external invitee. It is bound to the exact
   * session incarnation/runtime and is never accepted as a board grant. */
  sessionCapability?: string;
  requestId?: string;
}

export interface TaskBoardApiResponse {
  status: number;
  body: unknown;
}

export interface TaskBoardMembershipView {
  sessionId: string;
  role: Exclude<TaskBoardRole, 'none'>;
  allowedActions: string[];
  boardEpoch: number;
  coordinatorEpoch: number;
  runtimeGeneration: number;
}

export type TaskBoardChildAccess = 'read' | 'worker' | 'coordinator';

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskBoardError('invalid', 'request body must be an object');
  }
  return value as Record<string, unknown>;
};

const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new TaskBoardError('invalid', `${field} is required`);
  return value.trim();
};

const optionalBoolean = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new TaskBoardError('invalid', `${field} must be true or false`);
  return value;
};

const membership = (binding: TaskBoardBinding): TaskBoardMembershipView => ({
  sessionId: binding.sessionId,
  role: binding.role,
  allowedActions: [...binding.allowedActions],
  boardEpoch: binding.boardEpoch,
  coordinatorEpoch: binding.coordinatorEpoch,
  runtimeGeneration: binding.runtimeGeneration,
});

const grantRequest = (request: TaskBoardGrantRequest) => ({
  requestId: request.requestId,
  status: request.status,
  targetSessionId: request.targetSessionId,
  requestedRole: request.requestedRole,
  createdAt: request.createdAt,
  expiresAt: request.expiresAt,
  ...(request.refusalReason ? { refusalReason: request.refusalReason } : {}),
});

const invitation = (value: TaskBoardInvitation) => ({
  requestId: value.requestId,
  status: value.status,
  sourceSessionId: value.sourceSessionId,
  targetSessionId: value.targetSessionId,
  createdAt: value.createdAt,
  expiresAt: value.expiresAt,
  ...(value.refusalReason ? { refusalReason: value.refusalReason } : {}),
});

export const isTaskBoardPath = (pathname: string): boolean =>
  pathname === TASK_BOARD_API_PREFIX || pathname.startsWith(`${TASK_BOARD_API_PREFIX}/`);

export function taskBoardWardenDenial(method: string, pathname: string): string | undefined {
  if (!isTaskBoardPath(pathname)) return undefined;
  return method === 'GET' ? 'read task-board membership administration' : 'change task-board membership';
}

export class TaskBoardApi {
  private readonly sessionCapabilityRequests = new Map<string, Promise<string>>();

  constructor(
    private readonly service: TaskBoardService,
    private readonly sessions: TaskBoardSessionDeps,
    private readonly adminCapability: string,
  ) {}

  /** Hydrate task authorization from daemon-owned session/binding state. The
   * request body cannot supply any of these fields. */
  async hydrateTaskActor(
    actor: ResolvedTaskActor,
    humanAdmin: boolean,
    boardCapability?: string,
    boardAdminCapability?: string,
  ): Promise<TaskActor> {
    if (humanAdmin && this.matchesAdminCapability(boardAdminCapability)) return { ...actor, humanAdmin: true };
    const { humanAdmin: _untrustedHumanFlag, ...unprivilegedActor } = actor;
    actor = unprivilegedActor as ResolvedTaskActor;
    const view = await this.sessions.get(actor.actor).catch(() => undefined);
    if (!view) return actor;
    const binding = await this.service.store.readBinding(view.config.id);
    if (!binding) {
      if (boardCapability?.trim()) {
        throw new TaskBoardError('forbidden', 'the supplied board capability does not belong to this session');
      }
      return actor;
    }
    const authenticated = await this.service.authenticateBoundSession(view.config.id, boardCapability ?? '');
    return {
      ...actor,
      actor: view.config.id,
      boardCapability: boardCapability!.trim(),
      runtimeGeneration: authenticated.runtimeGeneration,
    };
  }

  /** Fail before starting a child when the caller cannot originate the exact
   * board-access request. The eventual request is still a separate durable
   * coordinator-approved operation; this never auto-approves a grant. */
  async preflightChildStart(input: {
    actor: TaskBoardApiActor;
    boardCapability?: string;
    parentSessionId?: string;
    mode?: 'auto' | 'interactive';
    requestedRole: TaskBoardChildAccess;
  }): Promise<void> {
    if (!(['read', 'worker', 'coordinator'] as const).includes(input.requestedRole)) {
      throw new TaskBoardError('invalid', 'board access must be read, worker, or coordinator');
    }
    const source = await this.requireBoundSession(input.actor, input.boardCapability);
    if (input.mode !== undefined && input.mode !== 'auto') {
      throw new TaskBoardError('forbidden', 'board access may be requested only for an auto-mode child');
    }
    if (!input.parentSessionId || input.parentSessionId !== source.sessionId) {
      throw new TaskBoardError('forbidden', 'the authenticated interactive source must be the child parent');
    }
    await this.service.authorizeChildGrantSource(source.sessionId, input.boardCapability ?? '');
  }

  async requestStartedChildGrant(input: {
    actor: TaskBoardApiActor;
    boardCapability?: string;
    targetSessionId: string;
    requestedRole: TaskBoardChildAccess;
    requestId: string;
  }): Promise<TaskBoardGrantRequest> {
    const source = await this.requireBoundSession(input.actor, input.boardCapability);
    return await this.service.requestChildGrant({
      sourceCapability: input.boardCapability!,
      sourceRuntimeGeneration: source.runtimeGeneration,
      targetSessionId: input.targetSessionId,
      requestedRole: input.requestedRole,
      requestId: input.requestId,
    });
  }

  async handle(request: TaskBoardApiRequest): Promise<TaskBoardApiResponse | null> {
    if (!isTaskBoardPath(request.url.pathname)) return null;
    try {
      const path = request.url.pathname;
      if (request.method === 'GET' && path === `${TASK_BOARD_API_PREFIX}/membership`) {
        const member = await this.requireBoundSession(request.actor, request.boardCapability);
        return { status: 200, body: membership(member.binding) };
      }
      if (request.method !== 'POST') {
        throw new TaskBoardError('not-found', `no task-board route ${request.method} ${path}`);
      }
      const requestId = text(request.requestId, 'x-kteam-request-id');
      const body = record(request.body);

      if (path === `${TASK_BOARD_API_PREFIX}/create`) {
        this.requireHuman(request.actor, request.boardAdminCapability);
        const result = await this.service.createBoard({
          creatorSessionId: text(body['creatorSessionId'], 'creatorSessionId'),
          coordinatorSessionId: text(body['coordinatorSessionId'], 'coordinatorSessionId'),
          requestId,
          creatorMarkDone: optionalBoolean(body['creatorMarkDone'], 'creatorMarkDone'),
        });
        return {
          status: result.created ? 201 : 200,
          body: {
            created: result.created,
            creator: membership(result.creatorBinding),
            coordinator: membership(result.coordinatorBinding),
          },
        };
      }

      if (path === `${TASK_BOARD_API_PREFIX}/child-grants/request`) {
        const source = await this.requireBoundSession(request.actor, request.boardCapability);
        const requestedRole = text(body['role'], 'role');
        if (!['read', 'worker', 'coordinator'].includes(requestedRole)) {
          throw new TaskBoardError('invalid', 'role must be read, worker, or coordinator');
        }
        const result = await this.service.requestChildGrant({
          sourceCapability: source.binding.capability,
          sourceRuntimeGeneration: source.runtimeGeneration,
          targetSessionId: text(body['targetSessionId'], 'targetSessionId'),
          requestedRole: requestedRole as 'read' | 'worker' | 'coordinator',
          requestId,
        });
        return { status: result.status === 'pending' ? 202 : 200, body: grantRequest(result) };
      }

      if (path === `${TASK_BOARD_API_PREFIX}/child-grants/approve`) {
        const coordinator = await this.requireBoundSession(request.actor, request.boardCapability);
        const binding = await this.service.approveChildGrant({
          coordinatorCapability: coordinator.binding.capability,
          coordinatorRuntimeGeneration: coordinator.runtimeGeneration,
          grantRequestId: text(body['grantRequestId'], 'grantRequestId'),
          requestId,
        });
        return { status: 200, body: membership(binding) };
      }

      if (path === `${TASK_BOARD_API_PREFIX}/invitations/request`) {
        const source = await this.requireBoundSession(request.actor, request.boardCapability);
        const result = await this.service.requestExternalInvitation({
          sourceCapability: source.binding.capability,
          sourceRuntimeGeneration: source.runtimeGeneration,
          targetSessionId: text(body['targetSessionId'], 'targetSessionId'),
          requestId,
        });
        await this.ensureSessionCapability(result.targetSessionId);
        return { status: result.status === 'pending' ? 202 : 200, body: invitation(result) };
      }

      if (path === `${TASK_BOARD_API_PREFIX}/invitations/approve`) {
        const coordinator = await this.requireBoundSession(request.actor, request.boardCapability);
        const result = await this.service.approveExternalInvitation({
          coordinatorCapability: coordinator.binding.capability,
          coordinatorRuntimeGeneration: coordinator.runtimeGeneration,
          invitationRequestId: text(body['invitationRequestId'], 'invitationRequestId'),
          requestId,
        });
        await this.publishInvitationCapability(result.invitation, result.acceptanceCapability);
        return { status: 200, body: invitation(result.invitation) };
      }

      if (path === `${TASK_BOARD_API_PREFIX}/invitations/accept`) {
        const sessionId = this.requireSession(request.actor);
        const view = await this.sessions.get(sessionId);
        await this.verifySessionCapability(view, request.sessionCapability);
        const binding = await this.service.acceptExternalInvitation({
          targetSessionId: view.config.id,
          targetRuntimeGeneration: view.config.runtimeGeneration ?? 1,
          acceptanceCapability: text(request.boardCapability, TASK_BOARD_CAPABILITY_HEADER),
          requestId,
        });
        return { status: 200, body: membership(binding) };
      }

      if (path === `${TASK_BOARD_API_PREFIX}/membership/relinquish`) {
        const member = await this.requireBoundSession(request.actor, request.boardCapability);
        await this.service.relinquishMembership({
          capability: member.binding.capability,
          runtimeGeneration: member.runtimeGeneration,
          requestId,
        });
        return { status: 200, body: { relinquished: true, sessionId: member.sessionId, sessionStopped: false } };
      }

      if (path === `${TASK_BOARD_API_PREFIX}/mark-done`) {
        this.requireHuman(request.actor, request.boardAdminCapability);
        const binding = await this.service.setTopAgentMarkDone({
          sessionId: text(body['sessionId'], 'sessionId'),
          requestId,
          enabled: optionalBoolean(body['enabled'], 'enabled') ?? false,
        });
        return { status: 200, body: membership(binding) };
      }

      if (path === `${TASK_BOARD_API_PREFIX}/coordinator/replace`) {
        this.requireHuman(request.actor, request.boardAdminCapability);
        const binding = await this.service.replaceCoordinator({
          sessionId: text(body['sessionId'], 'sessionId'),
          replacementSessionId: text(body['replacementSessionId'], 'replacementSessionId'),
          requestId,
        });
        return { status: 200, body: membership(binding) };
      }

      if (path === `${TASK_BOARD_API_PREFIX}/grants/revoke`) {
        this.requireHuman(request.actor, request.boardAdminCapability);
        const sessionId = text(body['sessionId'], 'sessionId');
        const targetSessionId = text(body['targetSessionId'], 'targetSessionId');
        const binding = await this.service.store.readBinding(sessionId);
        if (!binding) throw new TaskBoardError('not-found', `session ${sessionId} has no task board`);
        const file = await this.service.store.require(binding.boardId);
        const grants = file.grants.filter(grant => grant.active && grant.sessionId === targetSessionId);
        if (grants.length !== 1) {
          throw new TaskBoardError('conflict', `target ${targetSessionId} does not resolve one active board grant`);
        }
        await this.service.revokeGrant({
          sessionId,
          grantId: grants[0]!.grantId,
          reason: text(body['reason'], 'reason'),
          requestId,
        });
        return { status: 200, body: { revoked: true, targetSessionId } };
      }

      throw new TaskBoardError('not-found', `no task-board route ${request.method} ${path}`);
    } catch (error) {
      if (!isTaskBoardError(error)) throw error;
      return {
        status: taskBoardErrorStatus(error),
        body: { error: error.message, code: error.code },
      };
    }
  }

  private requireHuman(actor: TaskBoardApiActor, capability: string | undefined): void {
    if (!actor.humanAdmin || !this.matchesAdminCapability(capability)) {
      throw new TaskBoardError('forbidden', 'this task-board operation requires the distinct human-admin capability');
    }
  }

  private matchesAdminCapability(capability: string | undefined): boolean {
    const supplied = Buffer.from(capability?.trim() ?? '');
    const expected = Buffer.from(this.adminCapability);
    return supplied.length === expected.length && supplied.length > 0 && timingSafeEqual(supplied, expected);
  }

  private async ensureSessionCapability(sessionId: string): Promise<string> {
    const pending = this.sessionCapabilityRequests.get(sessionId);
    if (pending) return await pending;
    const request = this.ensureSessionCapabilityOnce(sessionId);
    this.sessionCapabilityRequests.set(sessionId, request);
    try {
      return await request;
    } finally {
      if (this.sessionCapabilityRequests.get(sessionId) === request) {
        this.sessionCapabilityRequests.delete(sessionId);
      }
    }
  }

  private async ensureSessionCapabilityOnce(sessionId: string): Promise<string> {
    const view = await this.sessions.get(sessionId);
    const incarnation =
      view.config.incarnation ?? legacyTaskBoardSessionIncarnation(view.config.id, view.config.createdAt);
    const runtimeGeneration = view.config.runtimeGeneration ?? 1;
    const filename = taskBoardSessionCapabilityFile(this.service.paths, view.config.id);
    const read = async (): Promise<Record<string, unknown> | undefined> => {
      const raw = await readFile(filename, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (raw === undefined) return undefined;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        return parsed as Record<string, unknown>;
      } catch {
        throw new TaskBoardError('unavailable', `session ${view.config.id} has a corrupt acceptance capability`);
      }
    };
    const validate = (record: Record<string, unknown>): string | undefined => {
      if (
        record['v'] !== 1 ||
        record['sessionId'] !== view.config.id ||
        typeof record['capability'] !== 'string' ||
        record['capability'].length < 32
      ) {
        throw new TaskBoardError('unavailable', `session ${view.config.id} acceptance capability is invalid`);
      }
      if (record['sessionIncarnation'] !== incarnation || record['runtimeGeneration'] !== runtimeGeneration) {
        return undefined;
      }
      return record['capability'];
    };
    const existing = await read();
    if (existing) {
      const current = validate(existing);
      if (current) return current;
    }
    const capability = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}`;
    const record = {
      v: 1,
      sessionId: view.config.id,
      sessionIncarnation: incarnation,
      runtimeGeneration,
      capability,
    };
    if (existing) {
      await atomicJson(filename, record);
      return capability;
    }
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    try {
      await writeFile(filename, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
      return capability;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = await read();
      if (!raced) throw new TaskBoardError('unavailable', 'acceptance capability creation raced without a result');
      const current = validate(raced);
      if (current) return current;
      await atomicJson(filename, record);
      return capability;
    }
  }

  /** Deliver the coordinator-approved one-time proof only through daemon-owned
   * 0600 session state. It never enters an API response or a CLI argument. */
  private async publishInvitationCapability(
    invitationRecord: TaskBoardInvitation,
    invitationCapability: string,
  ): Promise<void> {
    const sessionCapability = await this.ensureSessionCapability(invitationRecord.targetSessionId);
    const view = await this.sessions.get(invitationRecord.targetSessionId);
    const incarnation =
      view.config.incarnation ?? legacyTaskBoardSessionIncarnation(view.config.id, view.config.createdAt);
    const runtimeGeneration = view.config.runtimeGeneration ?? 1;
    if (
      incarnation !== invitationRecord.targetSessionIncarnation ||
      runtimeGeneration !== invitationRecord.targetRuntimeGeneration
    ) {
      throw new TaskBoardError('stale-generation', 'external invitee changed before capability delivery');
    }
    const filename = taskBoardSessionCapabilityFile(this.service.paths, view.config.id);
    const raw = await readFile(filename, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    let existing: Record<string, unknown>;
    try {
      const parsed = raw === undefined ? undefined : (JSON.parse(raw) as unknown);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      existing = parsed as Record<string, unknown>;
    } catch {
      throw new TaskBoardError('unavailable', `session ${view.config.id} has a corrupt acceptance capability`);
    }
    if (
      existing['v'] !== 1 ||
      existing['sessionId'] !== view.config.id ||
      existing['sessionIncarnation'] !== incarnation ||
      existing['runtimeGeneration'] !== runtimeGeneration ||
      existing['capability'] !== sessionCapability ||
      typeof invitationCapability !== 'string' ||
      invitationCapability.length < 32
    ) {
      throw new TaskBoardError('unavailable', `session ${view.config.id} acceptance capability is invalid`);
    }
    await atomicJson(filename, {
      ...existing,
      invitationRequestId: invitationRecord.requestId,
      invitationCapability,
    });
  }

  private async verifySessionCapability(
    view: Awaited<ReturnType<TaskBoardSessionDeps['get']>>,
    suppliedCapability: string | undefined,
  ): Promise<void> {
    const expected = await this.ensureSessionCapability(view.config.id);
    const supplied = Buffer.from(suppliedCapability?.trim() ?? '');
    const expectedBytes = Buffer.from(expected);
    if (
      supplied.length !== expectedBytes.length ||
      supplied.length === 0 ||
      !timingSafeEqual(supplied, expectedBytes)
    ) {
      throw new TaskBoardError('forbidden', 'external invitation acceptance requires the invitee session capability');
    }
    if (['completed', 'failed', 'stalled', 'stopped'].includes(view.state.status)) {
      throw new TaskBoardError('stale-generation', 'external invitee session is no longer live');
    }
  }

  private requireSession(actor: TaskBoardApiActor): string {
    if (!actor.sessionId)
      throw new TaskBoardError('forbidden', 'this task-board operation requires a live session actor');
    return actor.sessionId;
  }

  private async requireBoundSession(
    actor: TaskBoardApiActor,
    capability: string | undefined,
  ): Promise<{
    sessionId: string;
    runtimeGeneration: number;
    binding: TaskBoardBinding;
  }> {
    const sessionId = this.requireSession(actor);
    const view = await this.sessions.get(sessionId).catch(() => undefined);
    if (!view) throw new TaskBoardError('not-found', `unknown session ${sessionId}`);
    const authenticated = await this.service.authenticateBoundSession(view.config.id, capability ?? '');
    return {
      sessionId: view.config.id,
      runtimeGeneration: authenticated.runtimeGeneration,
      binding: authenticated.binding,
    };
  }
}

/** Create/read the daemon's narrow board-admin secret. This is deliberately a
 * separate file from the shared API bearer and is never exported into session
 * environments. A concurrent daemon bootstrap converges through `wx`. */
export async function ensureTaskBoardAdminCapability(paths: KTeamPaths): Promise<string> {
  await mkdir(dirname(paths.taskBoardAdminToken), { recursive: true, mode: 0o700 });
  const read = async (): Promise<string | undefined> => {
    const value = await readFile(paths.taskBoardAdminToken, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    const normalized = value?.trim() ?? '';
    if (normalized && normalized.length < 32) {
      throw new Error('task-board admin capability is malformed');
    }
    return normalized || undefined;
  };
  const existing = await read();
  if (existing) return existing;
  const minted = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}`;
  try {
    await writeFile(paths.taskBoardAdminToken, `${minted}\n`, { flag: 'wx', mode: 0o600 });
    return minted;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const raced = await read();
    if (!raced) throw new Error('task-board admin capability creation raced without a readable result');
    return raced;
  }
}

export function taskBoardErrorStatus(error: TaskBoardError): number {
  switch (error.code) {
    case 'invalid':
      return 400;
    case 'not-found':
      return 404;
    case 'forbidden':
    case 'stale-epoch':
    case 'stale-generation':
    case 'read-only':
      return 403;
    case 'conflict':
      return 409;
    case 'unavailable':
      return 503;
  }
}
