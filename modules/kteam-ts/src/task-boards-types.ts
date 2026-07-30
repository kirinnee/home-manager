import type { SessionTaskFile } from './session-tasks-store';
import type { TaskActionName } from './tasks-types';

export const TASK_BOARD_SCHEMA_VERSION = 1;
export const TASK_BOARD_BINDING_VERSION = 1;

export type TaskBoardRole = 'none' | 'read' | 'worker' | 'coordinator' | 'top_agent';

export const TASK_BOARD_CHILD_ROLES: readonly Exclude<TaskBoardRole, 'top_agent'>[] = [
  'none',
  'read',
  'worker',
  'coordinator',
];

/** Capabilities are deliberately action-shaped rather than inferred ad hoc
 * from a role at each call site. A grant persists the exact derived set, so a
 * later software upgrade cannot silently enlarge an old grant. */
export type TaskBoardAction =
  | 'read'
  | 'create'
  | 'status'
  | 'note'
  | 'feedback'
  | 'clarify'
  | 'dependency'
  | 'file'
  | 'link'
  | 'assign'
  | 'order'
  | 'mark_done'
  | 'grant_request'
  | 'grant_approve'
  | 'invite_request'
  | 'invite_approve'
  | 'invite_accept'
  | 'membership_relinquish'
  | 'acl_admin'
  /** Daemon-internal crash reconciliation provenance. No public role owns it. */
  | 'reconcile';

const READ_ACTIONS: readonly TaskBoardAction[] = ['read'];
const WORKER_ACTIONS: readonly TaskBoardAction[] = ['read', 'status', 'note', 'feedback', 'file', 'link'];
const OPERATIONAL_ACTIONS: readonly TaskBoardAction[] = [
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
];

export const TASK_BOARD_ROLE_ACTIONS: Readonly<Record<TaskBoardRole, readonly TaskBoardAction[]>> = {
  none: [],
  read: READ_ACTIONS,
  worker: WORKER_ACTIONS,
  coordinator: OPERATIONAL_ACTIONS,
  top_agent: [...OPERATIONAL_ACTIONS, 'grant_request', 'invite_request', 'membership_relinquish'],
};

/** The approval key is not the propagated coordinator role. Exactly one
 * board-designated current coordinator receives this non-propagating set. */
export const TASK_BOARD_CURRENT_COORDINATOR_ACTIONS: readonly TaskBoardAction[] = [
  ...OPERATIONAL_ACTIONS,
  'grant_approve',
  'invite_approve',
];

export function taskBoardActionsForRole(role: TaskBoardRole): TaskBoardAction[] {
  return [...TASK_BOARD_ROLE_ACTIONS[role]];
}

export function taskBoardActionsForCurrentCoordinator(): TaskBoardAction[] {
  return [...TASK_BOARD_CURRENT_COORDINATOR_ACTIONS];
}

export function taskBoardActionForTaskAction(action: TaskActionName): TaskBoardAction {
  return action === 'phase' || action === 'reopen' ? 'status' : action;
}

export type TaskBoardAuditOutcome = 'applied' | 'replayed' | 'denied' | 'failed';
export type TaskBoardPrincipalRole = Exclude<TaskBoardRole, 'none'> | 'human_admin' | 'daemon' | 'invitee';

/** Required provenance for every central-board mutation and administration
 * event. No field here is accepted from a task request body. */
export interface TaskBoardAuditRecord {
  seq: number;
  time: string;
  event:
    | 'task.mutation'
    | 'grant.requested'
    | 'grant.approved'
    | 'grant.expired'
    | 'grant.refused'
    | 'grant.updated'
    | 'grant.revoked'
    | 'coordinator.replaced'
    | 'binding.reconciled'
    | 'board.created'
    | 'invitation.requested'
    | 'invitation.approved'
    | 'invitation.accepted'
    | 'invitation.expired'
    | 'invitation.refused'
    | 'member.relinquished';
  actorSessionId: string | null;
  actorName: string | null;
  role: TaskBoardPrincipalRole;
  boardEpoch: number;
  coordinatorEpoch: number;
  runtimeGeneration: number | null;
  action: TaskBoardAction;
  capabilityId: string;
  requestId: string;
  payloadHash: string;
  outcome: TaskBoardAuditOutcome;
  detail?: Record<string, unknown>;
}

export interface TaskBoardGrant {
  grantId: string;
  capabilityHash: string;
  sessionId: string;
  sessionIncarnation: string;
  runtimeGeneration: number;
  role: Exclude<TaskBoardRole, 'none'>;
  allowedActions: TaskBoardAction[];
  parentSessionId: string | null;
  interactiveSourceSessionId: string;
  coordinatorSessionId: string;
  /** Root whose explicit membership authorizes this grant's lineage. Children
   * never inherit access; this only proves which invited/creator root they
   * descend from when a top-level member requests an exact child grant. */
  membershipRootSessionId: string;
  boardEpoch: number;
  coordinatorEpoch: number;
  grantedAt: string;
  grantedBySessionId: string | null;
  active: boolean;
  revokedAt?: string;
  revokedBySessionId?: string | null;
  revokeReason?: string;
}

export type TaskBoardGrantRequestStatus = 'pending' | 'approved' | 'refused' | 'expired';

export interface TaskBoardGrantRequest {
  requestId: string;
  payloadHash: string;
  boardId: string;
  boardEpoch: number;
  sourceGrantId: string;
  interactiveSourceSessionId: string;
  interactiveSourceIncarnation: string;
  interactiveSourceRuntimeGeneration: number;
  /** Exact target-to-root lineage captured at request time. The interactive
   * source must be an ancestor, but need not be the target's direct parent. */
  parentLineage: string[];
  targetSessionId: string;
  targetSessionIncarnation: string;
  targetRuntimeGeneration: number;
  targetParentSessionId: string;
  requestedRole: Exclude<TaskBoardRole, 'none' | 'top_agent'>;
  allowedActions: TaskBoardAction[];
  coordinatorGrantId: string;
  coordinatorSessionId: string;
  coordinatorSessionIncarnation: string;
  coordinatorRuntimeGeneration: number;
  coordinatorLineage: string[];
  coordinatorEpoch: number;
  createdAt: string;
  expiresAt: string;
  status: TaskBoardGrantRequestStatus;
  approvedAt?: string;
  approvedBySessionId?: string;
  grantId?: string;
  /** Crash bridge: present only after the central grant commits and before the
   * target session binding commits. Restart reconciliation consumes+clears it. */
  pendingCapability?: string;
  refusalReason?: string;
}

/** Durable request identity. Results are intentionally small and reconstructive:
 * task responses are read from the authoritative snapshot on replay. */
export interface TaskBoardAppliedRequest {
  requestId: string;
  payloadHash: string;
  action: TaskBoardAction;
  actorSessionId: string | null;
  role: TaskBoardPrincipalRole;
  grantId: string;
  capabilityId: string;
  boardEpoch: number;
  coordinatorEpoch: number;
  /** Exact authorization epochs after an ACL mutation that changes its own
   * generation. A retry may match this pair as well as the originating pair;
   * any later generation remains a request-id conflict. */
  resultBoardEpoch?: number;
  resultCoordinatorEpoch?: number;
  runtimeGeneration: number | null;
  appliedAt: string;
  taskId?: string;
  resultGrantId?: string;
  resultSessionId?: string;
  grantRequestId?: string;
  /** Coordinator replacement crash bridge. Present only after the central
   * epoch/grant commit and before the replacement binding is durable. */
  pendingCapability?: string;
}

export type TaskBoardInvitationStatus = 'pending' | 'approved' | 'accepted' | 'refused' | 'expired';

/** Explicit exception to the creator-tree default. It names one exact live,
 * interactive external root. Approval grants nothing: only the invitee's
 * later acceptance with the one-time capability activates a top-agent grant. */
export interface TaskBoardInvitation {
  requestId: string;
  payloadHash: string;
  boardId: string;
  boardEpoch: number;
  sourceGrantId: string;
  sourceSessionId: string;
  sourceSessionIncarnation: string;
  sourceRuntimeGeneration: number;
  targetSessionId: string;
  targetSessionIncarnation: string;
  targetRuntimeGeneration: number;
  coordinatorGrantId: string;
  coordinatorSessionId: string;
  coordinatorSessionIncarnation: string;
  coordinatorRuntimeGeneration: number;
  coordinatorEpoch: number;
  createdAt: string;
  expiresAt: string;
  status: TaskBoardInvitationStatus;
  approvedAt?: string;
  approvedBySessionId?: string;
  acceptanceCapabilityHash?: string;
  /** Kept only until explicit acceptance so exact approval replay can return
   * the same one-time secret rather than minting conflicting authority. */
  pendingAcceptanceCapability?: string;
  acceptedAt?: string;
  grantId?: string;
  /** Crash bridge from accepted central grant to target binding. */
  pendingBoardCapability?: string;
  refusalReason?: string;
}

export interface TaskBoardFile {
  v: number;
  boardId: string;
  boardEpoch: number;
  /** Monotonic generation of product/security state. Task, ACL, grant, and
   * coordinator mutations advance it. */
  mutationGeneration: number;
  creator: string;
  canonicalSessionId: string;
  coordinatorSessionId: string;
  coordinatorEpoch: number;
  taskState: SessionTaskFile;
  grants: TaskBoardGrant[];
  grantRequests: TaskBoardGrantRequest[];
  invitations: TaskBoardInvitation[];
  appliedRequests: TaskBoardAppliedRequest[];
  audit: TaskBoardAuditRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoardBinding {
  v: number;
  sessionId: string;
  sessionIncarnation: string;
  runtimeGeneration: number;
  boardId: string;
  grantId: string;
  /** The unguessable credential. Central state stores only its SHA-256. */
  capability: string;
  role: Exclude<TaskBoardRole, 'none'>;
  allowedActions: TaskBoardAction[];
  boardEpoch: number;
  coordinatorEpoch: number;
  boundAt: string;
  updatedAt: string;
}

export interface TaskBoardAuthorization {
  boardId: string;
  grantId: string;
  actorSessionId: string | null;
  actorName: string | null;
  role: TaskBoardPrincipalRole;
  allowedActions: TaskBoardAction[];
  boardEpoch: number;
  coordinatorEpoch: number;
  runtimeGeneration: number | null;
  capabilityId: string;
  /** Internal proof captured from the authenticated credential. Never emitted
   * or accepted from a request body; the store rechecks it against the current
   * central grant inside the serialized mutation. */
  capabilityHash?: string;
  requestId: string;
}

export interface TaskBoardProvenance {
  role: Exclude<TaskBoardRole, 'none'> | 'human_admin' | 'daemon';
  boardEpoch: number;
  coordinatorEpoch: number;
  runtimeGeneration: number | null;
  action: TaskBoardAction;
  requestId: string;
  /** Authorized diagnostic only. Ordinary List/Kanban and text output omit it. */
  boardId?: string;
}

export class TaskBoardError extends Error {
  constructor(
    readonly code:
      | 'invalid'
      | 'not-found'
      | 'forbidden'
      | 'conflict'
      | 'stale-epoch'
      | 'stale-generation'
      | 'read-only'
      | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'TaskBoardError';
  }
}

export const isTaskBoardError = (error: unknown): error is TaskBoardError => error instanceof TaskBoardError;
