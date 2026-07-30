import { existsSync, type Dirent } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { atomicJson, now } from './io';
import { taskBoardBindingFile, taskBoardFile, type KTeamPaths } from './paths';
import {
  SESSION_TASK_FILE_VERSION,
  emptySessionTaskFile,
  parseSessionTaskFile,
  serializeSessionTaskFile,
  validateStoredSessionTask,
  type SessionTaskRead,
  type StoredSessionTask,
} from './session-tasks-store';
import { SerialQueue, matchesTaskFilter, normalizeTaskId, type TaskFilter } from './tasks-store';
import type { TaskKind } from './tasks-types';
import {
  TASK_BOARD_BINDING_VERSION,
  TASK_BOARD_CURRENT_COORDINATOR_ACTIONS,
  TASK_BOARD_ROLE_ACTIONS,
  TASK_BOARD_SCHEMA_VERSION,
  TaskBoardError,
  type TaskBoardAction,
  type TaskBoardAppliedRequest,
  type TaskBoardAuditRecord,
  type TaskBoardAuthorization,
  type TaskBoardBinding,
  type TaskBoardFile,
  type TaskBoardGrant,
  type TaskBoardGrantRequest,
  type TaskBoardInvitation,
  type TaskBoardRole,
} from './task-boards-types';

const BOARD_ID = /^tb_[A-Za-z0-9_-]{20,120}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_GRANT_REQUESTS = 65_536;
const BOARD_ROLES = new Set<TaskBoardRole>(['none', 'read', 'worker', 'coordinator', 'top_agent']);
const BOARD_ACTIONS = new Set<TaskBoardAction>([
  'read',
  'create',
  'status',
  'note',
  'feedback',
  'clarify',
  'dependency',
  'file',
  'link',
  'assign',
  'order',
  'mark_done',
  'grant_request',
  'grant_approve',
  'invite_request',
  'invite_approve',
  'invite_accept',
  'membership_relinquish',
  'acl_admin',
  'reconcile',
]);
const AUDIT_EVENTS = new Set<TaskBoardAuditRecord['event']>([
  'task.mutation',
  'grant.requested',
  'grant.approved',
  'grant.expired',
  'grant.refused',
  'grant.updated',
  'grant.revoked',
  'coordinator.replaced',
  'binding.reconciled',
  'board.created',
  'invitation.requested',
  'invitation.approved',
  'invitation.accepted',
  'invitation.expired',
  'invitation.refused',
  'member.relinquished',
]);
const AUDIT_OUTCOMES = new Set<TaskBoardAuditRecord['outcome']>(['applied', 'replayed', 'denied', 'failed']);
const GRANT_REQUEST_STATUSES = new Set<TaskBoardGrantRequest['status']>(['pending', 'approved', 'refused', 'expired']);
const INVITATION_STATUSES = new Set<TaskBoardInvitation['status']>([
  'pending',
  'approved',
  'accepted',
  'refused',
  'expired',
]);

export type TaskBoardStoreRole = 'daemon' | 'reader';

export interface TaskBoardStoreOptions {
  role?: TaskBoardStoreRole;
  allocateId?: (kind: TaskKind) => Promise<string>;
  /** Daemon-owned live identity resolver, invoked inside the board write queue
   * for worker mutations so a reassignment/rename race cannot use stale scope. */
  resolveAssignedSessionId?: (task: StoredSessionTask['task']) => Promise<string | null>;
  /** Current daemon session identity, re-read inside the board queue to fence
   * a runtime before its central grant/binding transition has caught up. */
  resolveSessionIdentity?: (
    sessionId: string,
  ) => Promise<{ sessionIncarnation: string; runtimeGeneration: number } | null>;
}

export interface TaskBoardRead {
  exists: boolean;
  file: TaskBoardFile | null;
  fatal: boolean;
  parseErrors: string[];
}

export interface TaskBoardMutationContext {
  authorization: TaskBoardAuthorization;
  action: TaskBoardAction;
  payloadHash: string;
  event?: TaskBoardAuditRecord['event'];
  detail?: Record<string, unknown>;
  /** Set only by transactTask after canonicalizing the target. */
  workerTaskId?: string;
}

export interface TaskBoardTaskWrite {
  value: StoredSessionTask;
  file: TaskBoardFile;
  replayed: boolean;
}

export const hashTaskBoardSecret = (value: string): string => createHash('sha256').update(value).digest('hex');
export const hashTaskBoardPayload = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export const legacyTaskBoardSessionIncarnation = (id: string, createdAt: string): string =>
  `legacy-${hashTaskBoardPayload({ id, createdAt }).slice(0, 32)}`;
export const mintTaskBoardCapability = (): string => randomBytes(32).toString('base64url');
export const mintTaskBoardId = (): string => `tb_${randomBytes(24).toString('base64url')}`;
export const mintTaskBoardGrantId = (): string => `tg_${randomBytes(18).toString('base64url')}`;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const cloneGrant = (grant: TaskBoardGrant): TaskBoardGrant => ({ ...grant, allowedActions: [...grant.allowedActions] });
const cloneGrantRequest = (request: TaskBoardGrantRequest): TaskBoardGrantRequest => ({
  ...request,
  parentLineage: [...request.parentLineage],
  coordinatorLineage: [...request.coordinatorLineage],
  allowedActions: [...request.allowedActions],
});

export function serializeTaskBoardFile(file: TaskBoardFile): TaskBoardFile {
  return {
    ...file,
    v: TASK_BOARD_SCHEMA_VERSION,
    taskState: serializeSessionTaskFile({ ...file.taskState, sessionId: file.boardId }),
    grants: file.grants.map(cloneGrant),
    grantRequests: file.grantRequests.map(cloneGrantRequest),
    invitations: file.invitations.map(invitation => ({ ...invitation })),
    appliedRequests: file.appliedRequests.map(entry => ({ ...entry })),
    audit: file.audit.map(entry => ({ ...entry, ...(entry.detail ? { detail: { ...entry.detail } } : {}) })),
  };
}

const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const nonnegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const safeSession = (value: unknown): value is string => typeof value === 'string' && SESSION_ID.test(value);
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isoTime = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
const nullableSession = (value: unknown): value is string | null => value === null || safeSession(value);
const nullableGeneration = (value: unknown): value is number | null => value === null || positiveInteger(value);
const boardRole = (value: unknown): value is TaskBoardRole =>
  typeof value === 'string' && BOARD_ROLES.has(value as TaskBoardRole);
const boardAction = (value: unknown): value is TaskBoardAction =>
  typeof value === 'string' && BOARD_ACTIONS.has(value as TaskBoardAction);

function validGrantActions(
  role: Exclude<TaskBoardRole, 'none'>,
  value: unknown,
  allowCurrentCoordinator = false,
): value is TaskBoardAction[] {
  if (!Array.isArray(value) || value.some(action => !boardAction(action))) return false;
  const actions = value as TaskBoardAction[];
  if (new Set(actions).size !== actions.length) return false;
  const allowed = new Set<TaskBoardAction>([
    ...TASK_BOARD_ROLE_ACTIONS[role],
    ...(role === 'top_agent' ? (['mark_done'] as const) : []),
    ...(role === 'coordinator' && allowCurrentCoordinator ? TASK_BOARD_CURRENT_COORDINATOR_ACTIONS : []),
  ]);
  return actions.every(action => allowed.has(action));
}

function sameActions(left: readonly TaskBoardAction[], right: readonly TaskBoardAction[]): boolean {
  return left.length === right.length && left.every(action => right.includes(action));
}

function parseBoardFile(rawText: string, expectedBoardId: string): { file: TaskBoardFile | null; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return { file: null, errors: ['board.json is not valid JSON'] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { file: null, errors: ['board.json is not an object'] };
  const value = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (value['v'] !== TASK_BOARD_SCHEMA_VERSION) errors.push('unsupported board schema version');
  if (value['boardId'] !== expectedBoardId) errors.push('board identity mismatch');
  if (!positiveInteger(value['boardEpoch'])) errors.push('invalid board epoch');
  if (!nonnegativeInteger(value['mutationGeneration'])) errors.push('invalid mutation generation');
  if (!positiveInteger(value['coordinatorEpoch'])) errors.push('invalid coordinator epoch');
  if (!safeSession(value['creator'])) errors.push('invalid creator');
  if (!safeSession(value['canonicalSessionId'])) errors.push('invalid canonical session');
  if (!safeSession(value['coordinatorSessionId'])) errors.push('invalid coordinator session');
  if (!Array.isArray(value['grants'])) errors.push('grants must be an array');
  if (!Array.isArray(value['grantRequests'])) errors.push('grantRequests must be an array');
  if (!Array.isArray(value['invitations'])) errors.push('invitations must be an array');
  if (!Array.isArray(value['appliedRequests'])) errors.push('appliedRequests must be an array');
  if (!Array.isArray(value['audit'])) errors.push('audit must be an array');
  if (!isoTime(value['createdAt']) || !isoTime(value['updatedAt'])) errors.push('invalid board timestamps');
  const taskState = parseSessionTaskFile(JSON.stringify(value['taskState'] ?? null), expectedBoardId);
  const activityErrors = [...taskState.activityParseErrors.values()].reduce((sum, count) => sum + count, 0);
  if (taskState.fatal || taskState.parseErrors > 0 || activityErrors > 0) {
    errors.push(
      `central task snapshot is unreadable (${taskState.parseErrors} task error(s), ${activityErrors} activity error(s))`,
    );
  }
  if (errors.length > 0) return { file: null, errors };

  // Security-bearing collections fail the whole file closed. Task parsing is
  // already field-by-field above; grants cannot safely degrade that way.
  const grants = value['grants'] as unknown[];
  const grantIds = new Set<string>();
  const capabilityHashes = new Set<string>();
  for (const [index, grant] of grants.entries()) {
    if (!record(grant)) {
      errors.push(`grant ${index} is invalid`);
      continue;
    }
    const item = grant;
    const role = item['role'];
    if (
      !text(item['grantId']) ||
      !sha256(item['capabilityHash']) ||
      !safeSession(item['sessionId']) ||
      !text(item['sessionIncarnation']) ||
      !positiveInteger(item['runtimeGeneration']) ||
      !boardRole(role) ||
      role === 'none' ||
      !validGrantActions(role, item['allowedActions'], true) ||
      !nullableSession(item['parentSessionId']) ||
      !safeSession(item['interactiveSourceSessionId']) ||
      !safeSession(item['coordinatorSessionId']) ||
      !safeSession(item['membershipRootSessionId']) ||
      !positiveInteger(item['boardEpoch']) ||
      !positiveInteger(item['coordinatorEpoch']) ||
      !isoTime(item['grantedAt']) ||
      !nullableSession(item['grantedBySessionId']) ||
      typeof item['active'] !== 'boolean' ||
      (item['revokedAt'] !== undefined && !isoTime(item['revokedAt'])) ||
      (item['revokedBySessionId'] !== undefined && !nullableSession(item['revokedBySessionId'])) ||
      (item['revokeReason'] !== undefined && !text(item['revokeReason'])) ||
      (role === 'top_agent' && item['membershipRootSessionId'] !== item['sessionId']) ||
      (role === 'coordinator' &&
        item['active'] === true &&
        item['allowedActions'] instanceof Array &&
        (item['sessionId'] === value['coordinatorSessionId'] &&
        item['boardEpoch'] === value['boardEpoch'] &&
        item['coordinatorEpoch'] === value['coordinatorEpoch']
          ? !sameActions(item['allowedActions'] as TaskBoardAction[], TASK_BOARD_CURRENT_COORDINATOR_ACTIONS)
          : !sameActions(item['allowedActions'] as TaskBoardAction[], TASK_BOARD_ROLE_ACTIONS.coordinator)))
    ) {
      errors.push(`grant ${index} is invalid`);
    } else {
      const grantId = item['grantId'] as string;
      const capabilityHash = item['capabilityHash'] as string;
      if (grantIds.has(grantId) || capabilityHashes.has(capabilityHash)) errors.push(`grant ${index} is duplicated`);
      grantIds.add(grantId);
      capabilityHashes.add(capabilityHash);
    }
  }
  const grantRequests = value['grantRequests'] as unknown[];
  const grantRequestIds = new Set<string>();
  for (const [index, request] of grantRequests.entries()) {
    if (!record(request)) {
      errors.push(`grant request ${index} is invalid`);
      continue;
    }
    const role = request['requestedRole'];
    const status = request['status'];
    if (
      !text(request['requestId']) ||
      !sha256(request['payloadHash']) ||
      request['boardId'] !== expectedBoardId ||
      !positiveInteger(request['boardEpoch']) ||
      !text(request['sourceGrantId']) ||
      !grantIds.has(request['sourceGrantId'] as string) ||
      !safeSession(request['interactiveSourceSessionId']) ||
      !text(request['interactiveSourceIncarnation']) ||
      !positiveInteger(request['interactiveSourceRuntimeGeneration']) ||
      !Array.isArray(request['parentLineage']) ||
      (request['parentLineage'] as unknown[]).some(item => !safeSession(item)) ||
      !safeSession(request['targetSessionId']) ||
      !text(request['targetSessionIncarnation']) ||
      !positiveInteger(request['targetRuntimeGeneration']) ||
      !safeSession(request['targetParentSessionId']) ||
      (request['parentLineage'] as unknown[])[0] !== request['targetSessionId'] ||
      (request['parentLineage'] as unknown[])[1] !== request['targetParentSessionId'] ||
      !(request['parentLineage'] as unknown[]).slice(1).includes(request['interactiveSourceSessionId']) ||
      !boardRole(role) ||
      role === 'none' ||
      role === 'top_agent' ||
      !validGrantActions(role, request['allowedActions']) ||
      !sameActions(request['allowedActions'] as TaskBoardAction[], TASK_BOARD_ROLE_ACTIONS[role]) ||
      !text(request['coordinatorGrantId']) ||
      !grantIds.has(request['coordinatorGrantId'] as string) ||
      !safeSession(request['coordinatorSessionId']) ||
      !text(request['coordinatorSessionIncarnation']) ||
      !positiveInteger(request['coordinatorRuntimeGeneration']) ||
      !Array.isArray(request['coordinatorLineage']) ||
      (request['coordinatorLineage'] as unknown[]).some(item => !safeSession(item)) ||
      (request['coordinatorLineage'] as unknown[])[0] !== request['coordinatorSessionId'] ||
      !positiveInteger(request['coordinatorEpoch']) ||
      !isoTime(request['createdAt']) ||
      !isoTime(request['expiresAt']) ||
      typeof status !== 'string' ||
      !GRANT_REQUEST_STATUSES.has(status as TaskBoardGrantRequest['status']) ||
      (request['approvedAt'] !== undefined && !isoTime(request['approvedAt'])) ||
      (request['approvedBySessionId'] !== undefined && !safeSession(request['approvedBySessionId'])) ||
      (request['grantId'] !== undefined && !text(request['grantId'])) ||
      (request['grantId'] !== undefined && !grantIds.has(request['grantId'] as string)) ||
      (request['pendingCapability'] !== undefined && !text(request['pendingCapability'])) ||
      (request['refusalReason'] !== undefined && !text(request['refusalReason'])) ||
      (status === 'approved' && (!text(request['grantId']) || !isoTime(request['approvedAt']))) ||
      (request['pendingCapability'] !== undefined && status !== 'approved')
    ) {
      errors.push(`grant request ${index} is invalid`);
    } else {
      const requestId = request['requestId'] as string;
      if (grantRequestIds.has(requestId)) errors.push(`grant request ${index} is duplicated`);
      grantRequestIds.add(requestId);
    }
  }
  const invitations = value['invitations'] as unknown[];
  const invitationIds = new Set<string>();
  for (const [index, invitation] of invitations.entries()) {
    if (!record(invitation)) {
      errors.push(`invitation ${index} is invalid`);
      continue;
    }
    const status = invitation['status'];
    const pendingAcceptance = invitation['pendingAcceptanceCapability'];
    const acceptanceHash = invitation['acceptanceCapabilityHash'];
    if (
      !text(invitation['requestId']) ||
      !sha256(invitation['payloadHash']) ||
      invitation['boardId'] !== expectedBoardId ||
      !positiveInteger(invitation['boardEpoch']) ||
      !text(invitation['sourceGrantId']) ||
      !grantIds.has(invitation['sourceGrantId'] as string) ||
      !safeSession(invitation['sourceSessionId']) ||
      !text(invitation['sourceSessionIncarnation']) ||
      !positiveInteger(invitation['sourceRuntimeGeneration']) ||
      !safeSession(invitation['targetSessionId']) ||
      !text(invitation['targetSessionIncarnation']) ||
      !positiveInteger(invitation['targetRuntimeGeneration']) ||
      !text(invitation['coordinatorGrantId']) ||
      !grantIds.has(invitation['coordinatorGrantId'] as string) ||
      !safeSession(invitation['coordinatorSessionId']) ||
      !text(invitation['coordinatorSessionIncarnation']) ||
      !positiveInteger(invitation['coordinatorRuntimeGeneration']) ||
      !positiveInteger(invitation['coordinatorEpoch']) ||
      !isoTime(invitation['createdAt']) ||
      !isoTime(invitation['expiresAt']) ||
      typeof status !== 'string' ||
      !INVITATION_STATUSES.has(status as TaskBoardInvitation['status']) ||
      (invitation['approvedAt'] !== undefined && !isoTime(invitation['approvedAt'])) ||
      (invitation['approvedBySessionId'] !== undefined && !safeSession(invitation['approvedBySessionId'])) ||
      (acceptanceHash !== undefined && !sha256(acceptanceHash)) ||
      (pendingAcceptance !== undefined && !text(pendingAcceptance)) ||
      (pendingAcceptance !== undefined && hashTaskBoardSecret(pendingAcceptance as string) !== acceptanceHash) ||
      (invitation['acceptedAt'] !== undefined && !isoTime(invitation['acceptedAt'])) ||
      (invitation['grantId'] !== undefined &&
        (!text(invitation['grantId']) || !grantIds.has(invitation['grantId'] as string))) ||
      (invitation['pendingBoardCapability'] !== undefined && !text(invitation['pendingBoardCapability'])) ||
      (invitation['refusalReason'] !== undefined && !text(invitation['refusalReason'])) ||
      (status === 'pending' &&
        (invitation['approvedAt'] !== undefined || acceptanceHash !== undefined || pendingAcceptance !== undefined)) ||
      (status === 'approved' &&
        (!isoTime(invitation['approvedAt']) ||
          !safeSession(invitation['approvedBySessionId']) ||
          !sha256(acceptanceHash) ||
          !text(pendingAcceptance))) ||
      (status === 'accepted' &&
        (!isoTime(invitation['acceptedAt']) || !text(invitation['grantId']) || !sha256(acceptanceHash))) ||
      (invitation['pendingBoardCapability'] !== undefined && status !== 'accepted')
    ) {
      errors.push(`invitation ${index} is invalid`);
    } else {
      const requestId = invitation['requestId'] as string;
      if (invitationIds.has(requestId)) errors.push(`invitation ${index} is duplicated`);
      invitationIds.add(requestId);
    }
  }
  const appliedRequests = value['appliedRequests'] as unknown[];
  const appliedRequestIds = new Set<string>();
  for (const [index, applied] of appliedRequests.entries()) {
    if (!record(applied)) {
      errors.push(`applied request ${index} is invalid`);
      continue;
    }
    const role = applied['role'];
    const hasResultBoardEpoch = applied['resultBoardEpoch'] !== undefined;
    const hasResultCoordinatorEpoch = applied['resultCoordinatorEpoch'] !== undefined;
    const resultBoardEpoch = applied['resultBoardEpoch'];
    const resultCoordinatorEpoch = applied['resultCoordinatorEpoch'];
    if (
      !text(applied['requestId']) ||
      !sha256(applied['payloadHash']) ||
      !boardAction(applied['action']) ||
      !nullableSession(applied['actorSessionId']) ||
      !(role === 'human_admin' || role === 'daemon' || role === 'invitee' || (boardRole(role) && role !== 'none')) ||
      !text(applied['grantId']) ||
      !text(applied['capabilityId']) ||
      !positiveInteger(applied['boardEpoch']) ||
      !positiveInteger(applied['coordinatorEpoch']) ||
      hasResultBoardEpoch !== hasResultCoordinatorEpoch ||
      (hasResultBoardEpoch &&
        (!positiveInteger(resultBoardEpoch) ||
          !positiveInteger(resultCoordinatorEpoch) ||
          (resultBoardEpoch as number) < (applied['boardEpoch'] as number) ||
          (resultCoordinatorEpoch as number) < (applied['coordinatorEpoch'] as number) ||
          (resultBoardEpoch === applied['boardEpoch'] && resultCoordinatorEpoch === applied['coordinatorEpoch']))) ||
      !nullableGeneration(applied['runtimeGeneration']) ||
      ((role === 'human_admin' || role === 'daemon') &&
        (applied['actorSessionId'] !== null || applied['runtimeGeneration'] !== null)) ||
      (role !== 'human_admin' &&
        role !== 'daemon' &&
        (!safeSession(applied['actorSessionId']) || !positiveInteger(applied['runtimeGeneration']))) ||
      !isoTime(applied['appliedAt']) ||
      (applied['taskId'] !== undefined && normalizeTaskId(applied['taskId']) === null) ||
      (applied['resultGrantId'] !== undefined &&
        (!text(applied['resultGrantId']) || !grantIds.has(applied['resultGrantId'] as string))) ||
      (applied['resultSessionId'] !== undefined && !safeSession(applied['resultSessionId'])) ||
      (applied['grantRequestId'] !== undefined && !text(applied['grantRequestId'])) ||
      (applied['pendingCapability'] !== undefined && !text(applied['pendingCapability'])) ||
      (applied['pendingCapability'] !== undefined &&
        (applied['action'] !== 'acl_admin' ||
          !text(applied['resultGrantId']) ||
          !safeSession(applied['resultSessionId'])))
    ) {
      errors.push(`applied request ${index} is invalid`);
    } else {
      const requestId = applied['requestId'] as string;
      if (appliedRequestIds.has(requestId)) errors.push(`applied request ${index} is duplicated`);
      appliedRequestIds.add(requestId);
    }
  }
  const audit = value['audit'] as unknown[];
  let previousAuditSeq = 0;
  for (const [index, rawAudit] of audit.entries()) {
    if (!record(rawAudit)) {
      errors.push(`audit ${index} is invalid`);
      continue;
    }
    const role = rawAudit['role'];
    const event = rawAudit['event'];
    const outcome = rawAudit['outcome'];
    if (
      !positiveInteger(rawAudit['seq']) ||
      (rawAudit['seq'] as number) <= previousAuditSeq ||
      !isoTime(rawAudit['time']) ||
      typeof event !== 'string' ||
      !AUDIT_EVENTS.has(event as TaskBoardAuditRecord['event']) ||
      !nullableSession(rawAudit['actorSessionId']) ||
      !(role === 'human_admin' || role === 'daemon' || role === 'invitee' || (boardRole(role) && role !== 'none')) ||
      !positiveInteger(rawAudit['boardEpoch']) ||
      !positiveInteger(rawAudit['coordinatorEpoch']) ||
      !nullableGeneration(rawAudit['runtimeGeneration']) ||
      (role === 'human_admin' && (rawAudit['actorSessionId'] !== null || rawAudit['runtimeGeneration'] !== null)) ||
      (role === 'daemon' && (rawAudit['actorSessionId'] !== null || rawAudit['runtimeGeneration'] !== null)) ||
      ((role === 'invitee' || boardRole(role)) &&
        (!safeSession(rawAudit['actorSessionId']) || !positiveInteger(rawAudit['runtimeGeneration']))) ||
      !boardAction(rawAudit['action']) ||
      !text(rawAudit['capabilityId']) ||
      !text(rawAudit['requestId']) ||
      !sha256(rawAudit['payloadHash']) ||
      typeof outcome !== 'string' ||
      !AUDIT_OUTCOMES.has(outcome as TaskBoardAuditRecord['outcome']) ||
      (rawAudit['detail'] !== undefined && !record(rawAudit['detail']))
    ) {
      errors.push(`audit ${index} is invalid`);
    }
    if (positiveInteger(rawAudit['seq'])) previousAuditSeq = rawAudit['seq'];
  }
  if (errors.length > 0) return { file: null, errors };
  return {
    file: serializeTaskBoardFile({
      ...(value as unknown as TaskBoardFile),
      taskState: taskState.file,
    }),
    errors: [],
  };
}

export function emptyTaskBoardFile(input: {
  boardId: string;
  creator: string;
  canonicalSessionId: string;
  coordinatorSessionId: string;
  at?: string;
}): TaskBoardFile {
  const at = input.at ?? now();
  return {
    v: TASK_BOARD_SCHEMA_VERSION,
    boardId: input.boardId,
    boardEpoch: 1,
    mutationGeneration: 0,
    creator: input.creator,
    canonicalSessionId: input.canonicalSessionId,
    coordinatorSessionId: input.coordinatorSessionId,
    coordinatorEpoch: 1,
    taskState: emptySessionTaskFile(input.boardId, at),
    grants: [],
    grantRequests: [],
    invitations: [],
    appliedRequests: [],
    audit: [],
    createdAt: at,
    updatedAt: at,
  };
}

export class TaskBoardStore {
  private readonly role: TaskBoardStoreRole;
  private readonly queue = new SerialQueue();
  private readonly allocateId?: (kind: TaskKind) => Promise<string>;
  private readonly resolveAssignedSessionId?: TaskBoardStoreOptions['resolveAssignedSessionId'];
  private readonly resolveSessionIdentity?: TaskBoardStoreOptions['resolveSessionIdentity'];

  constructor(
    private readonly paths: KTeamPaths,
    options: TaskBoardStoreOptions = {},
  ) {
    this.role = options.role ?? 'reader';
    this.allocateId = options.allocateId;
    this.resolveAssignedSessionId = options.resolveAssignedSessionId;
    this.resolveSessionIdentity = options.resolveSessionIdentity;
  }

  get writable(): boolean {
    return this.role === 'daemon';
  }

  file(boardId: string): string {
    this.assertBoardId(boardId);
    return taskBoardFile(this.paths, boardId);
  }

  private assertWritable(): void {
    if (!this.writable) throw new TaskBoardError('read-only', 'central task boards are daemon-owned');
  }

  private assertBoardId(boardId: string): void {
    if (!BOARD_ID.test(boardId)) throw new TaskBoardError('invalid', `invalid task board id ${String(boardId)}`);
  }

  private assertSessionId(sessionId: string): void {
    if (!SESSION_ID.test(sessionId)) throw new TaskBoardError('invalid', `invalid session id ${String(sessionId)}`);
  }

  async listBoardIds(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.paths.taskBoardsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
      else throw new TaskBoardError('invalid', `central task board directory is unreadable: ${String(error)}`);
    }
    return entries
      .filter(
        entry => entry.isDirectory() && BOARD_ID.test(entry.name) && existsSync(taskBoardFile(this.paths, entry.name)),
      )
      .map(entry => entry.name)
      .sort();
  }

  async read(boardId: string): Promise<TaskBoardRead> {
    this.assertBoardId(boardId);
    const filename = this.file(boardId);
    if (!existsSync(filename)) return { exists: false, file: null, fatal: false, parseErrors: [] };
    const body = await readFile(filename, 'utf8').catch(() => null);
    if (body === null) return { exists: true, file: null, fatal: true, parseErrors: ['board.json could not be read'] };
    const parsed = parseBoardFile(body, boardId);
    return { exists: true, file: parsed.file, fatal: parsed.file === null, parseErrors: parsed.errors };
  }

  async require(boardId: string): Promise<TaskBoardFile> {
    const read = await this.read(boardId);
    if (!read.exists) throw new TaskBoardError('not-found', `unknown task board ${boardId}`);
    if (read.file === null) {
      throw new TaskBoardError('invalid', `refusing unreadable task board ${boardId}: ${read.parseErrors.join('; ')}`);
    }
    return read.file;
  }

  async readBinding(sessionId: string): Promise<TaskBoardBinding | null> {
    this.assertSessionId(sessionId);
    const filename = taskBoardBindingFile(this.paths, sessionId);
    const body = await readFile(filename, 'utf8').catch(() => null);
    if (body === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new TaskBoardError('invalid', `unreadable board binding for ${sessionId}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TaskBoardError('invalid', `unreadable board binding for ${sessionId}`);
    }
    const binding = raw as TaskBoardBinding;
    const bindingRole = binding.role;
    if (
      binding.v !== TASK_BOARD_BINDING_VERSION ||
      binding.sessionId !== sessionId ||
      !BOARD_ID.test(binding.boardId) ||
      !text(binding.grantId) ||
      !text(binding.capability) ||
      !positiveInteger(binding.runtimeGeneration) ||
      !text(binding.sessionIncarnation) ||
      !boardRole(bindingRole) ||
      String(bindingRole) === 'none' ||
      !validGrantActions(bindingRole, binding.allowedActions, true) ||
      !positiveInteger(binding.boardEpoch) ||
      !positiveInteger(binding.coordinatorEpoch) ||
      !isoTime(binding.boundAt) ||
      !isoTime(binding.updatedAt)
    ) {
      throw new TaskBoardError('invalid', `unreadable board binding for ${sessionId}`);
    }
    return { ...binding, allowedActions: [...binding.allowedActions] };
  }

  async writeBinding(binding: TaskBoardBinding): Promise<void> {
    this.assertWritable();
    this.assertSessionId(binding.sessionId);
    this.assertBoardId(binding.boardId);
    await atomicJson(taskBoardBindingFile(this.paths, binding.sessionId), {
      ...binding,
      v: TASK_BOARD_BINDING_VERSION,
      allowedActions: [...binding.allowedActions],
      updatedAt: now(),
    });
  }

  async findByCapability(capability: string): Promise<{ file: TaskBoardFile; grant: TaskBoardGrant } | null> {
    if (!text(capability)) return null;
    const digest = hashTaskBoardSecret(capability);
    for (const boardId of await this.listBoardIds()) {
      const file = await this.require(boardId);
      const grant = file.grants.find(candidate => candidate.capabilityHash === digest);
      if (grant) return { file, grant };
    }
    return null;
  }

  async listTasks(boardId: string, filter: TaskFilter = {}): Promise<SessionTaskRead & { tasks: StoredSessionTask[] }> {
    const board = await this.require(boardId);
    return {
      exists: true,
      file: board.taskState,
      fatal: false,
      parseErrors: 0,
      parseErrorIds: [],
      activityParseErrors: new Map(),
      tasks: board.taskState.tasks.filter(entry => matchesTaskFilter(entry.task, filter)),
    };
  }

  async detailTask(boardId: string, id: string): Promise<StoredSessionTask | undefined> {
    const canonical = normalizeTaskId(id);
    if (canonical === null) throw new TaskBoardError('invalid', `not a task id: ${String(id)}`);
    return (await this.require(boardId)).taskState.tasks.find(entry => entry.task.id === canonical);
  }

  async createBoard(file: TaskBoardFile): Promise<TaskBoardFile> {
    this.assertWritable();
    this.assertBoardId(file.boardId);
    return this.queue.run(file.boardId, async () => {
      if ((await this.read(file.boardId)).exists)
        throw new TaskBoardError('conflict', `task board ${file.boardId} exists`);
      const serialized = serializeTaskBoardFile({ ...file, updatedAt: now() });
      await atomicJson(this.file(file.boardId), serialized);
      return serialized;
    });
  }

  async replaceBoard(file: TaskBoardFile): Promise<TaskBoardFile> {
    this.assertWritable();
    this.assertBoardId(file.boardId);
    return this.queue.run(file.boardId, async () => {
      const current = await this.require(file.boardId);
      if (current.boardId !== file.boardId) throw new TaskBoardError('conflict', 'board identity cannot change');
      const serialized = this.serializeProductTransaction(current, file, true);
      await atomicJson(this.file(file.boardId), serialized);
      return serialized;
    });
  }

  async transact(
    boardId: string,
    transform: (current: TaskBoardFile) => TaskBoardFile | Promise<TaskBoardFile>,
  ): Promise<TaskBoardFile> {
    this.assertWritable();
    this.assertBoardId(boardId);
    return this.queue.run(boardId, async () => {
      const current = await this.require(boardId);
      const next = await transform(current);
      if (next.boardId !== boardId) throw new TaskBoardError('conflict', 'board transaction cannot change identity');
      const serialized = this.serializeProductTransaction(current, next, true);
      await atomicJson(this.file(boardId), serialized);
      return serialized;
    });
  }

  async createTask(
    boardId: string,
    kind: TaskKind,
    context: TaskBoardMutationContext,
    build: (id: string) => StoredSessionTask | Promise<StoredSessionTask>,
  ): Promise<TaskBoardTaskWrite> {
    if (!this.allocateId) throw new TaskBoardError('unavailable', 'global task allocator is not configured');
    return this.mutateTaskFile(boardId, context, async current => {
      const id = await this.allocateId!(kind);
      if (current.taskState.tasks.some(entry => entry.task.id === id)) {
        throw new TaskBoardError('conflict', `global task id ${id} already exists on ${boardId}`);
      }
      const entry = validateStoredSessionTask(await build(id), id);
      return {
        value: entry,
        taskId: id,
        taskState: { ...current.taskState, tasks: [...current.taskState.tasks, entry], updatedAt: now() },
      };
    });
  }

  async transactTask(
    boardId: string,
    id: string,
    context: TaskBoardMutationContext,
    transform: (current: StoredSessionTask) => StoredSessionTask | Promise<StoredSessionTask>,
  ): Promise<TaskBoardTaskWrite> {
    const canonical = normalizeTaskId(id);
    if (canonical === null) throw new TaskBoardError('invalid', `not a task id: ${String(id)}`);
    return this.mutateTaskFile(boardId, { ...context, workerTaskId: canonical }, async current => {
      const index = current.taskState.tasks.findIndex(entry => entry.task.id === canonical);
      if (index < 0) throw new TaskBoardError('not-found', `unknown task ${canonical} on ${boardId}`);
      const entry = validateStoredSessionTask(await transform(current.taskState.tasks[index]!), canonical);
      const tasks = [...current.taskState.tasks];
      tasks[index] = entry;
      return {
        value: entry,
        taskId: canonical,
        taskState: { ...current.taskState, tasks, updatedAt: now() },
      };
    });
  }

  private async mutateTaskFile(
    boardId: string,
    context: TaskBoardMutationContext,
    transform: (
      current: TaskBoardFile,
    ) => Promise<{ value: StoredSessionTask; taskId: string; taskState: TaskBoardFile['taskState'] }>,
  ): Promise<TaskBoardTaskWrite> {
    this.assertWritable();
    return this.queue.run(boardId, async () => {
      const current = await this.require(boardId);
      await this.assertCurrentAuthorization(current, context);
      const replay = this.appliedRequest(current, context);
      if (replay) {
        const task = replay.taskId ? current.taskState.tasks.find(entry => entry.task.id === replay.taskId) : undefined;
        if (!task) throw new TaskBoardError('conflict', 'applied request no longer resolves its task result');
        const file = await this.writeWithAudit(current, context, 'replayed', { taskId: task.task.id });
        return { value: task, file, replayed: true };
      }
      try {
        const changed = await transform(current);
        const applied: TaskBoardAppliedRequest = {
          requestId: context.authorization.requestId,
          payloadHash: context.payloadHash,
          action: context.action,
          actorSessionId: context.authorization.actorSessionId,
          role: context.authorization.role,
          grantId: context.authorization.grantId,
          capabilityId: context.authorization.capabilityId,
          boardEpoch: context.authorization.boardEpoch,
          coordinatorEpoch: context.authorization.coordinatorEpoch,
          runtimeGeneration: context.authorization.runtimeGeneration,
          appliedAt: now(),
          taskId: changed.taskId,
        };
        const next: TaskBoardFile = {
          ...current,
          mutationGeneration: current.mutationGeneration + 1,
          taskState: changed.taskState,
          appliedRequests: appendTaskBoardAppliedRequest(current.appliedRequests, applied),
        };
        const file = await this.writeWithAudit(next, context, 'applied', { taskId: changed.taskId });
        return { value: changed.value, file, replayed: false };
      } catch (error) {
        await this.writeWithAudit(current, context, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  async recordDenied(boardId: string, context: TaskBoardMutationContext, reason: string): Promise<void> {
    if (!this.writable) return;
    await this.queue.run(boardId, async () => {
      const current = await this.require(boardId);
      await this.writeWithAudit(current, context, 'denied', { reason });
    });
  }

  private async assertCurrentAuthorization(file: TaskBoardFile, context: TaskBoardMutationContext): Promise<void> {
    const authorization = context.authorization;
    if (authorization.boardId !== file.boardId) {
      throw new TaskBoardError('forbidden', 'authorization belongs to another task board');
    }
    if (authorization.boardEpoch !== file.boardEpoch || authorization.coordinatorEpoch !== file.coordinatorEpoch) {
      throw new TaskBoardError('stale-epoch', 'task-board authorization epoch changed before the serialized write');
    }
    if (authorization.role === 'human_admin' || authorization.role === 'daemon') {
      const human = authorization.role === 'human_admin';
      if (
        authorization.actorSessionId !== null ||
        authorization.runtimeGeneration !== null ||
        authorization.grantId !== (human ? 'human-admin' : 'daemon') ||
        authorization.capabilityId !== (human ? 'daemon-admin-token' : 'daemon-internal-token') ||
        !authorization.allowedActions.includes(context.action)
      ) {
        throw new TaskBoardError('forbidden', `invalid ${authorization.role} task-board authorization`);
      }
      return;
    }
    const grant = file.grants.find(candidate => candidate.grantId === authorization.grantId);
    const binding = grant ? await this.readBinding(grant.sessionId) : null;
    const identity = grant && this.resolveSessionIdentity ? await this.resolveSessionIdentity(grant.sessionId) : null;
    if (
      !grant ||
      !grant.active ||
      grant.sessionId !== authorization.actorSessionId ||
      grant.role !== authorization.role ||
      !sameActions(grant.allowedActions, authorization.allowedActions) ||
      grant.boardEpoch !== file.boardEpoch ||
      grant.coordinatorEpoch !== file.coordinatorEpoch ||
      grant.runtimeGeneration !== authorization.runtimeGeneration ||
      authorization.capabilityId !== grant.grantId ||
      authorization.capabilityHash !== grant.capabilityHash ||
      !grant.allowedActions.includes(context.action) ||
      !binding ||
      binding.boardId !== file.boardId ||
      binding.grantId !== grant.grantId ||
      binding.sessionIncarnation !== grant.sessionIncarnation ||
      binding.runtimeGeneration !== grant.runtimeGeneration ||
      binding.role !== grant.role ||
      !sameActions(binding.allowedActions, grant.allowedActions) ||
      binding.boardEpoch !== file.boardEpoch ||
      binding.coordinatorEpoch !== file.coordinatorEpoch ||
      hashTaskBoardSecret(binding.capability) !== grant.capabilityHash ||
      !identity ||
      identity.sessionIncarnation !== grant.sessionIncarnation ||
      identity.runtimeGeneration !== grant.runtimeGeneration
    ) {
      throw new TaskBoardError('forbidden', 'task-board grant changed before the serialized write');
    }
    if (grant.role === 'worker') {
      if (!context.workerTaskId || !this.resolveAssignedSessionId) {
        throw new TaskBoardError('forbidden', 'worker mutation lacks an in-transaction assignment proof');
      }
      const entry = file.taskState.tasks.find(candidate => candidate.task.id === context.workerTaskId);
      if (!entry || (await this.resolveAssignedSessionId(entry.task)) !== grant.sessionId) {
        throw new TaskBoardError('forbidden', 'task assignment changed before the serialized worker write');
      }
    }
  }

  private appliedRequest(file: TaskBoardFile, context: TaskBoardMutationContext): TaskBoardAppliedRequest | null {
    const authorization = context.authorization;
    const previous = file.appliedRequests.find(entry => entry.requestId === authorization.requestId);
    if (!previous) return null;
    const matchesOriginGeneration =
      previous.boardEpoch === authorization.boardEpoch &&
      previous.coordinatorEpoch === authorization.coordinatorEpoch &&
      previous.runtimeGeneration === authorization.runtimeGeneration;
    const hasResultGeneration = previous.resultBoardEpoch !== undefined;
    const matchesResultGeneration =
      hasResultGeneration &&
      (previous.resultBoardEpoch ?? previous.boardEpoch) === authorization.boardEpoch &&
      (previous.resultCoordinatorEpoch ?? previous.coordinatorEpoch) === authorization.coordinatorEpoch &&
      previous.runtimeGeneration === authorization.runtimeGeneration;
    if (
      previous.payloadHash !== context.payloadHash ||
      previous.action !== context.action ||
      previous.actorSessionId !== authorization.actorSessionId ||
      previous.role !== authorization.role ||
      previous.grantId !== authorization.grantId ||
      previous.capabilityId !== authorization.capabilityId ||
      (!matchesOriginGeneration && !matchesResultGeneration)
    ) {
      throw new TaskBoardError(
        'conflict',
        `request id ${authorization.requestId} was already used under a different payload or authorization generation`,
      );
    }
    return previous;
  }

  /** Excludes provenance-only bytes. Every product/security field remains in
   * this projection so a normal transaction advances exactly once when it
   * changes authoritative behavior; exact replay leaves the generation unchanged. */
  private productMutationHash(file: TaskBoardFile): string {
    return hashTaskBoardPayload({
      boardEpoch: file.boardEpoch,
      creator: file.creator,
      canonicalSessionId: file.canonicalSessionId,
      coordinatorSessionId: file.coordinatorSessionId,
      coordinatorEpoch: file.coordinatorEpoch,
      taskState: file.taskState,
      grants: file.grants,
      grantRequests: file.grantRequests,
      invitations: file.invitations,
      appliedRequests: file.appliedRequests,
    });
  }

  private serializeProductTransaction(
    current: TaskBoardFile,
    next: TaskBoardFile,
    refreshTimestamp: boolean,
  ): TaskBoardFile {
    const changed = this.productMutationHash(current) !== this.productMutationHash(next);
    return serializeTaskBoardFile({
      ...next,
      mutationGeneration: changed ? current.mutationGeneration + 1 : current.mutationGeneration,
      ...(refreshTimestamp ? { updatedAt: now() } : {}),
    });
  }

  private async writeWithAudit(
    file: TaskBoardFile,
    context: TaskBoardMutationContext,
    outcome: TaskBoardAuditRecord['outcome'],
    detail: Record<string, unknown>,
  ): Promise<TaskBoardFile> {
    const record: TaskBoardAuditRecord = {
      seq: (file.audit.at(-1)?.seq ?? 0) + 1,
      time: now(),
      event: context.event ?? 'task.mutation',
      actorSessionId: context.authorization.actorSessionId,
      actorName: context.authorization.actorName,
      role: context.authorization.role,
      boardEpoch: file.boardEpoch,
      coordinatorEpoch: file.coordinatorEpoch,
      runtimeGeneration: context.authorization.runtimeGeneration,
      action: context.action,
      capabilityId: context.authorization.capabilityId,
      requestId: context.authorization.requestId,
      payloadHash: context.payloadHash,
      outcome,
      detail: { ...(context.detail ?? {}), ...detail },
    };
    const next = serializeTaskBoardFile({
      ...file,
      audit: [...file.audit, record],
      grantRequests: compactTaskBoardGrantRequests(file.grantRequests, MAX_GRANT_REQUESTS),
      updatedAt: now(),
    });
    await atomicJson(this.file(file.boardId), next);
    return next;
  }
}

/** Grant requests remain the durable replay/tombstone ledger even after they
 * reach a terminal state. Refuse new intent at the cap; never evict an old id
 * that would then become reusable with a different payload. */
export function compactTaskBoardGrantRequests(
  values: readonly TaskBoardGrantRequest[],
  limit = MAX_GRANT_REQUESTS,
): TaskBoardGrantRequest[] {
  if (values.length > limit) {
    throw new TaskBoardError(
      'unavailable',
      `task-board grant request ledger reached its fail-closed capacity of ${limit}`,
    );
  }
  return [...values];
}

/** Applied request identities are authorization records, not cache entries.
 * They are intentionally retained without eviction; dropping one would make
 * an old request id reusable or turn its exact retry into a second mutation. */
export function appendTaskBoardAppliedRequest(
  values: readonly TaskBoardAppliedRequest[],
  entry: TaskBoardAppliedRequest,
): TaskBoardAppliedRequest[] {
  return [...values, entry];
}
