import { now } from './io';
import type { KTeamPaths } from './paths';
import type { StoredSessionTask } from './session-tasks-store';
import { SerialQueue } from './tasks-store';
import {
  appendTaskBoardAppliedRequest,
  compactTaskBoardGrantRequests,
  hashTaskBoardPayload,
  hashTaskBoardSecret,
  legacyTaskBoardSessionIncarnation,
  mintTaskBoardCapability,
  mintTaskBoardId,
  mintTaskBoardGrantId,
  emptyTaskBoardFile,
  TaskBoardStore,
} from './task-boards-store';
import {
  TASK_BOARD_BINDING_VERSION,
  TASK_BOARD_CURRENT_COORDINATOR_ACTIONS,
  TASK_BOARD_ROLE_ACTIONS,
  TaskBoardError,
  taskBoardActionsForRole,
  taskBoardActionsForCurrentCoordinator,
  type TaskBoardAction,
  type TaskBoardAppliedRequest,
  type TaskBoardAuditRecord,
  type TaskBoardAuthorization,
  type TaskBoardBinding,
  type TaskBoardFile,
  type TaskBoardGrant,
  type TaskBoardGrantRequest,
  type TaskBoardInvitation,
  type TaskBoardProvenance,
  type TaskBoardRole,
} from './task-boards-types';
import type { Task, TaskActor } from './tasks-types';

const TERMINAL_SESSION_STATUSES = new Set(['completed', 'failed', 'stalled', 'stopped']);
const GRANT_REQUEST_TTL_MS = 24 * 60 * 60 * 1_000;

export interface TaskBoardSessionView {
  config: {
    id: string;
    incarnation?: string;
    runtimeGeneration?: number;
    teammate?: string;
    name?: string;
    parent?: string;
    mode: 'auto' | 'interactive';
    createdAt: string;
  };
  state: { status: string };
}

export interface TaskBoardSessionDeps {
  get(ref: string): Promise<TaskBoardSessionView>;
  list(): Promise<TaskBoardSessionView[]>;
}

export interface TaskBoardServiceOptions {
  /** Administrative fail-closed cap. Injectable only so the cap/replay edge
   * can be exercised without manufacturing tens of thousands of sessions. */
  maxGrantRequests?: number;
}

export interface LegacyTaskScope {
  kind: 'legacy';
  sessionId: string;
}

export interface CentralTaskScope {
  kind: 'board';
  sessionId: string;
  board: TaskBoardFile;
  authorization: TaskBoardAuthorization;
}

export type ResolvedTaskScope = LegacyTaskScope | CentralTaskScope;

export interface ResolveTaskScopeOptions {
  assignedSessionId?: string | null;
}

export interface RequestChildGrantInput {
  sourceCapability: string;
  sourceRuntimeGeneration: number;
  targetSessionId: string;
  requestedRole: Exclude<TaskBoardRole, 'none' | 'top_agent'>;
  requestId: string;
}

export interface CreateTaskBoardInput {
  creatorSessionId: string;
  coordinatorSessionId: string;
  requestId: string;
  creatorMarkDone?: boolean;
}

export interface CreateTaskBoardResult {
  created: boolean;
  creatorBinding: TaskBoardBinding;
  coordinatorBinding: TaskBoardBinding;
}

export interface RequestExternalInvitationInput {
  sourceCapability: string;
  sourceRuntimeGeneration: number;
  targetSessionId: string;
  requestId: string;
}

export interface ApproveExternalInvitationInput {
  coordinatorCapability: string;
  coordinatorRuntimeGeneration: number;
  invitationRequestId: string;
  requestId: string;
}

export interface ApprovedExternalInvitation {
  invitation: TaskBoardInvitation;
  acceptanceCapability: string;
}

export interface AcceptExternalInvitationInput {
  targetSessionId: string;
  targetRuntimeGeneration: number;
  acceptanceCapability: string;
  requestId: string;
}

export interface RelinquishMembershipInput {
  capability: string;
  runtimeGeneration: number;
  requestId: string;
}

export interface ApproveChildGrantInput {
  coordinatorCapability: string;
  coordinatorRuntimeGeneration: number;
  grantRequestId: string;
  requestId: string;
}

export interface BoardAdminMutationInput {
  sessionId: string;
  requestId: string;
}

export interface ReplaceCoordinatorInput extends BoardAdminMutationInput {
  replacementSessionId: string;
}

interface SessionIdentity {
  id: string;
  incarnation: string;
  runtimeGeneration: number;
  name: string | null;
  parent: string | null;
  mode: 'auto' | 'interactive';
  live: boolean;
}

interface CurrentGrantState {
  grant: TaskBoardGrant;
  binding: TaskBoardBinding;
  identity: SessionIdentity;
  lineage: string[];
}

const allAdminActions: TaskBoardAction[] = [
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
  'acl_admin',
];
const daemonTaskActions: TaskBoardAction[] = ['read', 'status'];
const daemonReconcilerActions: TaskBoardAction[] = ['reconcile'];

export class TaskBoardService {
  /** Board IDs are independently random, so idempotent creation needs a
   * daemon-global serialization point rather than a per-board file queue. */
  private readonly boardCreationQueue = new SerialQueue();
  /** A session may have only one board binding. Operations on different board
   * files therefore also serialize the central-commit -> binding bridge by
   * target session, or two boards could both observe an unbound target. */
  private readonly bindingQueue = new SerialQueue();

  constructor(
    readonly paths: KTeamPaths,
    readonly store: TaskBoardStore,
    private readonly sessions: TaskBoardSessionDeps,
    private readonly options: TaskBoardServiceOptions = {},
  ) {}

  async initialize(): Promise<void> {
    await this.reconcilePendingBindings();
  }

  async createBoard(input: CreateTaskBoardInput): Promise<CreateTaskBoardResult> {
    return await this.boardCreationQueue.run('create', async () => {
      // Repair any earlier central-commit -> binding crash before taking new
      // binding locks. Reconciliation acquires those same locks and must never
      // be invoked re-entrantly from the create critical section.
      await this.reconcilePendingBindings();
      return await this.createBoardSerialized(input);
    });
  }

  private async createBoardSerialized(input: CreateTaskBoardInput): Promise<CreateTaskBoardResult> {
    const requestId = cleanRequestId(input.requestId, 'acl_admin');
    const initialCreator = await this.identity(input.creatorSessionId);
    const initialCoordinator = await this.identity(input.coordinatorSessionId);
    return await this.withBindingLocks([initialCreator.id, initialCoordinator.id], async () => {
      const creator = await this.identity(input.creatorSessionId);
      const coordinator = await this.identity(input.coordinatorSessionId);
      if (creator.id !== initialCreator.id || coordinator.id !== initialCoordinator.id) {
        throw new TaskBoardError('stale-generation', 'board creation identities changed while awaiting binding locks');
      }
      if (!creator.live || creator.mode !== 'interactive' || creator.parent !== null) {
        throw new TaskBoardError('forbidden', 'a board creator must be a live interactive top-level session');
      }
      const coordinatorLineage = await this.lineage(coordinator.id);
      if (!coordinator.live || coordinator.id === creator.id || !coordinatorLineage.slice(1).includes(creator.id)) {
        throw new TaskBoardError('forbidden', 'the initial coordinator must be a live descendant of the creator');
      }
      const payloadHash = hashTaskBoardPayload({
        operation: 'board.create',
        creatorSessionId: creator.id,
        creatorIncarnation: creator.incarnation,
        creatorRuntimeGeneration: creator.runtimeGeneration,
        coordinatorSessionId: coordinator.id,
        coordinatorIncarnation: coordinator.incarnation,
        coordinatorRuntimeGeneration: coordinator.runtimeGeneration,
        creatorMarkDone: input.creatorMarkDone === true,
      });

      for (const existingBoardId of await this.store.listBoardIds()) {
        const existing = await this.store.require(existingBoardId);
        const creationAudit = existing.audit.find(
          entry => entry.requestId === requestId && entry.event === 'board.created',
        );
        if (!creationAudit) continue;
        if (creationAudit.payloadHash !== payloadHash || creationAudit.outcome !== 'applied') {
          throw new TaskBoardError('conflict', `board creation request id ${requestId} was reused`);
        }
        const creatorBinding = await this.store.readBinding(creator.id);
        const coordinatorBinding = await this.store.readBinding(coordinator.id);
        if (
          !creatorBinding ||
          !coordinatorBinding ||
          creatorBinding.boardId !== existing.boardId ||
          coordinatorBinding.boardId !== existing.boardId
        ) {
          throw new TaskBoardError('unavailable', 'board creation is awaiting binding reconciliation');
        }
        return { created: false, creatorBinding, coordinatorBinding };
      }

      if (
        (await this.store.readBinding(creator.id)) !== null ||
        (await this.store.readBinding(coordinator.id)) !== null
      ) {
        throw new TaskBoardError('conflict', 'the creator or coordinator is already a task-board member');
      }

      const boardId = mintTaskBoardId();
      const topCapability = mintTaskBoardCapability();
      const coordinatorCapability = mintTaskBoardCapability();
      const topGrant = initialGrant({
        grantId: mintTaskBoardGrantId(),
        capability: topCapability,
        identity: creator,
        role: 'top_agent',
        allowedActions: [
          ...taskBoardActionsForRole('top_agent'),
          ...(input.creatorMarkDone === true ? (['mark_done'] as const) : []),
        ],
        parentSessionId: null,
        interactiveSourceSessionId: creator.id,
        coordinatorSessionId: coordinator.id,
        membershipRootSessionId: creator.id,
      });
      const coordinatorGrant = initialGrant({
        grantId: mintTaskBoardGrantId(),
        capability: coordinatorCapability,
        identity: coordinator,
        role: 'coordinator',
        allowedActions: taskBoardActionsForCurrentCoordinator(),
        parentSessionId: coordinator.parent,
        interactiveSourceSessionId: creator.id,
        coordinatorSessionId: coordinator.id,
        membershipRootSessionId: creator.id,
      });
      const authorization: TaskBoardAuthorization = {
        boardId,
        grantId: 'human-admin',
        actorSessionId: null,
        actorName: 'user',
        role: 'human_admin',
        allowedActions: [...allAdminActions],
        boardEpoch: 1,
        coordinatorEpoch: 1,
        runtimeGeneration: null,
        capabilityId: 'daemon-admin-token',
        requestId,
      };
      const at = now();
      const pending = (grant: TaskBoardGrant, capability: string): TaskBoardAppliedRequest => ({
        ...appliedRequest(authorization, 'acl_admin', payloadHash, {
          resultGrantId: grant.grantId,
          resultSessionId: grant.sessionId,
          pendingCapability: capability,
        }),
        requestId: `${requestId}:bind:${grant.grantId}`,
      });
      let board = emptyTaskBoardFile({
        boardId,
        creator: creator.id,
        canonicalSessionId: creator.id,
        coordinatorSessionId: coordinator.id,
        at,
      });
      board = appendAudit(
        {
          ...board,
          grants: [topGrant, coordinatorGrant],
          appliedRequests: [
            appliedRequest(authorization, 'acl_admin', payloadHash),
            pending(topGrant, topCapability),
            pending(coordinatorGrant, coordinatorCapability),
          ],
        },
        authorization,
        'board.created',
        'acl_admin',
        payloadHash,
        'applied',
        { creatorSessionId: creator.id, coordinatorSessionId: coordinator.id },
      );
      board = await this.store.createBoard(board);
      await this.store.writeBinding(bindingFor(board, topGrant, topCapability));
      await this.clearPendingAppliedCapability(board.boardId, `${requestId}:bind:${topGrant.grantId}`, topCapability);
      await this.store.writeBinding(bindingFor(board, coordinatorGrant, coordinatorCapability));
      await this.clearPendingAppliedCapability(
        board.boardId,
        `${requestId}:bind:${coordinatorGrant.grantId}`,
        coordinatorCapability,
      );
      return {
        created: true,
        creatorBinding: (await this.store.readBinding(creator.id))!,
        coordinatorBinding: (await this.store.readBinding(coordinator.id))!,
      };
    });
  }

  async resolveTaskScope(
    sessionId: string,
    actor: TaskActor,
    action: TaskBoardAction,
    options: ResolveTaskScopeOptions = {},
  ): Promise<ResolvedTaskScope> {
    const targetBinding = await this.store.readBinding(sessionId);
    if (targetBinding === null) {
      if (typeof actor.boardCapability === 'string' && actor.boardCapability.trim()) {
        throw new TaskBoardError('forbidden', `session ${sessionId} is not bound to the caller's task board`);
      }
      return { kind: 'legacy', sessionId };
    }

    const board = await this.store.require(targetBinding.boardId);
    const requestId = cleanRequestId(actor.requestId, action);
    let authorization: TaskBoardAuthorization;
    if (actor.humanAdmin === true || actor.daemonAdmin === true) {
      const daemonActor = actor.daemonAdmin === true && actor.humanAdmin !== true;
      authorization = {
        boardId: board.boardId,
        grantId: daemonActor ? 'daemon' : 'human-admin',
        actorSessionId: null,
        actorName: daemonActor ? 'daemon' : 'user',
        role: daemonActor ? 'daemon' : 'human_admin',
        allowedActions: [...(daemonActor ? daemonTaskActions : allAdminActions)],
        boardEpoch: board.boardEpoch,
        coordinatorEpoch: board.coordinatorEpoch,
        runtimeGeneration: null,
        capabilityId: daemonActor ? 'daemon-internal-token' : 'daemon-admin-token',
        requestId,
      };
    } else {
      const capability = typeof actor.boardCapability === 'string' ? actor.boardCapability.trim() : '';
      if (!capability)
        throw new TaskBoardError('forbidden', 'this central task board requires a board grant capability');
      const resolved = await this.store.findByCapability(capability);
      if (!resolved || resolved.file.boardId !== board.boardId) {
        throw new TaskBoardError('forbidden', 'the board grant capability does not authorize this task board');
      }
      const grant = resolved.grant;
      const claimedActorSessionId = typeof actor.actor === 'string' ? actor.actor.trim() : '';
      if (claimedActorSessionId && claimedActorSessionId !== grant.sessionId) {
        throw new TaskBoardError(
          'forbidden',
          'the board grant capability does not belong to the claimed session actor',
        );
      }
      if (!grant.active) throw new TaskBoardError('forbidden', 'the task board grant has been revoked');
      const identity = await this.identity(grant.sessionId);
      const suppliedGeneration = actor.runtimeGeneration;
      if (!Number.isSafeInteger(suppliedGeneration) || (suppliedGeneration as number) < 1) {
        throw new TaskBoardError(
          'stale-generation',
          'a board write/read requires its authenticated runtime generation',
        );
      }
      if (
        identity.incarnation !== grant.sessionIncarnation ||
        identity.runtimeGeneration !== grant.runtimeGeneration ||
        suppliedGeneration !== grant.runtimeGeneration
      ) {
        throw new TaskBoardError(
          'stale-generation',
          `runtime generation ${String(suppliedGeneration)} is fenced; current generation is ${grant.runtimeGeneration}`,
        );
      }
      const actorBinding = await this.store.readBinding(grant.sessionId);
      if (
        actorBinding === null ||
        actorBinding.boardId !== board.boardId ||
        actorBinding.grantId !== grant.grantId ||
        actorBinding.sessionIncarnation !== grant.sessionIncarnation ||
        actorBinding.runtimeGeneration !== grant.runtimeGeneration ||
        actorBinding.role !== grant.role ||
        !sameActions(actorBinding.allowedActions, grant.allowedActions) ||
        actorBinding.boardEpoch !== board.boardEpoch ||
        actorBinding.coordinatorEpoch !== board.coordinatorEpoch ||
        grant.boardEpoch !== board.boardEpoch ||
        grant.coordinatorEpoch !== board.coordinatorEpoch ||
        hashTaskBoardSecret(actorBinding.capability) !== grant.capabilityHash ||
        hashTaskBoardSecret(capability) !== grant.capabilityHash
      ) {
        throw new TaskBoardError('forbidden', 'the task board binding and central grant do not match');
      }
      authorization = {
        boardId: board.boardId,
        grantId: grant.grantId,
        actorSessionId: grant.sessionId,
        actorName: identity.name,
        role: grant.role,
        allowedActions: [...grant.allowedActions],
        boardEpoch: board.boardEpoch,
        coordinatorEpoch: board.coordinatorEpoch,
        runtimeGeneration: grant.runtimeGeneration,
        capabilityId: grant.grantId,
        capabilityHash: grant.capabilityHash,
        requestId,
      };
    }

    try {
      this.assertAction(authorization, action, options.assignedSessionId);
    } catch (error) {
      const payloadHash = hashTaskBoardPayload({ action, assignedSessionId: options.assignedSessionId ?? null });
      await this.store
        .recordDenied(
          board.boardId,
          { authorization, action, payloadHash },
          error instanceof Error ? error.message : String(error),
        )
        .catch(() => undefined);
      throw error;
    }
    return { kind: 'board', sessionId, board, authorization };
  }

  /** Authenticate an HTTP peer against its own daemon-owned board binding.
   * `x-kteam-session-id` is attribution only: the separately presented secret
   * must resolve the exact same live session, incarnation, runtime generation,
   * grant, action set, and board/coordinator epochs before transport may use it.
   */
  async authenticateBoundSession(
    sessionId: string,
    capability: string,
  ): Promise<{ binding: TaskBoardBinding; runtimeGeneration: number }> {
    const identity = await this.identity(sessionId);
    if (!identity.live) throw new TaskBoardError('forbidden', `session ${identity.id} is not live`);
    const secret = capability.trim();
    if (!secret) throw new TaskBoardError('forbidden', 'a board-bound peer must present its binding capability');
    const resolved = await this.store.findByCapability(secret);
    if (!resolved || resolved.grant.sessionId !== identity.id) {
      throw new TaskBoardError('forbidden', 'the board binding capability does not belong to the claimed session');
    }
    const scope = await this.resolveTaskScope(
      identity.id,
      {
        actor: identity.id,
        actorName: identity.name,
        boardCapability: secret,
        runtimeGeneration: identity.runtimeGeneration,
        requestId: `transport-auth:${identity.id}`,
      },
      'read',
    );
    if (scope.kind !== 'board' || scope.authorization.actorSessionId !== identity.id) {
      throw new TaskBoardError('forbidden', 'the claimed session does not resolve its exact board authorization');
    }
    const binding = await this.store.readBinding(identity.id);
    if (!binding) throw new TaskBoardError('forbidden', `session ${identity.id} has no board membership`);
    return { binding, runtimeGeneration: identity.runtimeGeneration };
  }

  /** Preflight used by `kteam start --board-access`: prove the caller is the
   * live interactive membership root that may originate grants, and that one
   * current live coordinator exists, before the child process is created. */
  async authorizeChildGrantSource(
    sessionId: string,
    capability: string,
  ): Promise<{ binding: TaskBoardBinding; runtimeGeneration: number }> {
    const authenticated = await this.authenticateBoundSession(sessionId, capability);
    const file = await this.store.require(authenticated.binding.boardId);
    const grant = file.grants.find(candidate => candidate.grantId === authenticated.binding.grantId);
    const identity = await this.identity(sessionId);
    if (
      !grant ||
      !grant.active ||
      grant.sessionId !== identity.id ||
      grant.role !== 'top_agent' ||
      grant.membershipRootSessionId !== identity.id ||
      !grant.allowedActions.includes('grant_request') ||
      identity.mode !== 'interactive' ||
      identity.parent !== null ||
      !identity.live
    ) {
      throw new TaskBoardError('forbidden', 'child board access requires a live interactive membership-root grant');
    }
    await this.requireSingleCoordinator(file);
    return authenticated;
  }

  provenance(authorization: TaskBoardAuthorization, action: TaskBoardAction, diagnostic = false): TaskBoardProvenance {
    if (authorization.role === 'invitee') {
      throw new TaskBoardError('forbidden', 'an unaccepted invitation has no task-operation provenance');
    }
    return {
      role: authorization.role,
      boardEpoch: authorization.boardEpoch,
      coordinatorEpoch: authorization.coordinatorEpoch,
      runtimeGeneration: authorization.runtimeGeneration,
      action,
      requestId: authorization.requestId,
      ...(diagnostic ? { boardId: authorization.boardId } : {}),
    };
  }

  async requestChildGrant(input: RequestChildGrantInput): Promise<TaskBoardGrantRequest> {
    const resolved = await this.store.findByCapability(input.sourceCapability);
    if (!resolved) throw new TaskBoardError('forbidden', 'unknown board grant capability');
    const sourceGrant = resolved.grant;
    const source = await this.identity(sourceGrant.sessionId);
    const sourceScope = await this.resolveTaskScope(
      sourceGrant.sessionId,
      {
        boardCapability: input.sourceCapability,
        runtimeGeneration: input.sourceRuntimeGeneration,
        requestId: input.requestId,
      },
      'grant_request',
    );
    if (sourceScope.kind !== 'board') throw new TaskBoardError('forbidden', 'grant source is not board-bound');
    if (sourceScope.authorization.role !== 'top_agent') {
      throw new TaskBoardError('forbidden', 'only the authenticated top-agent grant may originate child access');
    }
    if (sourceGrant.membershipRootSessionId !== source.id) {
      throw new TaskBoardError('forbidden', 'only a membership-root top agent may originate child access');
    }
    if (source.mode !== 'interactive' || !source.live) {
      throw new TaskBoardError('forbidden', 'a child grant must originate from a live interactive source session');
    }
    const requestedRole = input.requestedRole as TaskBoardRole;
    if (!(['read', 'worker', 'coordinator'] as const).includes(requestedRole as 'read' | 'worker' | 'coordinator')) {
      throw new TaskBoardError('forbidden', `role ${String(requestedRole)} cannot be propagated to a child`);
    }
    const previous = resolved.file.grantRequests.find(candidate => candidate.requestId === input.requestId);
    if (previous) {
      const applied = resolved.file.appliedRequests.find(candidate => candidate.requestId === input.requestId);
      if (
        previous.targetSessionId !== input.targetSessionId ||
        previous.requestedRole !== requestedRole ||
        previous.sourceGrantId !== sourceGrant.grantId ||
        previous.interactiveSourceSessionId !== source.id ||
        previous.interactiveSourceIncarnation !== source.incarnation ||
        previous.interactiveSourceRuntimeGeneration !== input.sourceRuntimeGeneration ||
        !sameActions(previous.allowedActions, taskBoardActionsForRole(requestedRole)) ||
        !applied ||
        applied.action !== 'grant_request' ||
        applied.payloadHash !== previous.payloadHash ||
        applied.actorSessionId !== previous.interactiveSourceSessionId ||
        applied.grantId !== previous.sourceGrantId ||
        applied.capabilityId !== previous.sourceGrantId ||
        applied.boardEpoch !== previous.boardEpoch ||
        applied.coordinatorEpoch !== previous.coordinatorEpoch ||
        applied.runtimeGeneration !== previous.interactiveSourceRuntimeGeneration ||
        applied.grantRequestId !== previous.requestId
      ) {
        throw new TaskBoardError('conflict', `grant request id ${input.requestId} was reused with a different payload`);
      }
      return previous;
    }
    const target = await this.identity(input.targetSessionId);
    if (!target.live) throw new TaskBoardError('forbidden', 'the target child session is no longer live');
    const parentLineage = await this.lineage(target.id);
    if (target.parent === null || !parentLineage.slice(1).includes(source.id)) {
      throw new TaskBoardError('forbidden', 'the target child is not descended from the interactive source');
    }
    const coordinator = await this.requireSingleCoordinator(resolved.file);
    const allowedActions = taskBoardActionsForRole(requestedRole);
    const at = now();
    const request: TaskBoardGrantRequest = {
      requestId: input.requestId,
      payloadHash: hashTaskBoardPayload({
        boardId: resolved.file.boardId,
        boardEpoch: resolved.file.boardEpoch,
        sourceGrantId: sourceGrant.grantId,
        sourceSessionId: source.id,
        sourceIncarnation: source.incarnation,
        sourceRuntimeGeneration: source.runtimeGeneration,
        parentLineage,
        targetSessionId: target.id,
        targetIncarnation: target.incarnation,
        targetRuntimeGeneration: target.runtimeGeneration,
        targetParentSessionId: target.parent,
        role: requestedRole,
        allowedActions,
        coordinatorGrantId: coordinator.grant.grantId,
        coordinatorSessionId: coordinator.identity.id,
        coordinatorSessionIncarnation: coordinator.identity.incarnation,
        coordinatorRuntimeGeneration: coordinator.identity.runtimeGeneration,
        coordinatorLineage: coordinator.lineage,
        coordinatorEpoch: resolved.file.coordinatorEpoch,
      }),
      boardId: resolved.file.boardId,
      boardEpoch: resolved.file.boardEpoch,
      sourceGrantId: sourceGrant.grantId,
      interactiveSourceSessionId: source.id,
      interactiveSourceIncarnation: source.incarnation,
      interactiveSourceRuntimeGeneration: source.runtimeGeneration,
      parentLineage,
      targetSessionId: target.id,
      targetSessionIncarnation: target.incarnation,
      targetRuntimeGeneration: target.runtimeGeneration,
      targetParentSessionId: target.parent,
      requestedRole: requestedRole as Exclude<TaskBoardRole, 'none' | 'top_agent'>,
      allowedActions,
      coordinatorGrantId: coordinator.grant.grantId,
      coordinatorSessionId: coordinator.identity.id,
      coordinatorSessionIncarnation: coordinator.identity.incarnation,
      coordinatorRuntimeGeneration: coordinator.identity.runtimeGeneration,
      coordinatorLineage: coordinator.lineage,
      coordinatorEpoch: resolved.file.coordinatorEpoch,
      createdAt: at,
      expiresAt: new Date(Date.parse(at) + GRANT_REQUEST_TTL_MS).toISOString(),
      status: 'pending',
    };

    const file = await this.store.transact(resolved.file.boardId, async current => {
      const currentSource = await this.requireCurrentAuthorization(
        current,
        sourceScope.authorization,
        'grant_request',
        'top_agent',
      );
      if (
        currentSource.identity.mode !== 'interactive' ||
        !currentSource.identity.live ||
        currentSource.identity.id !== request.interactiveSourceSessionId ||
        currentSource.identity.incarnation !== request.interactiveSourceIncarnation ||
        currentSource.identity.runtimeGeneration !== request.interactiveSourceRuntimeGeneration ||
        currentSource.grant.grantId !== request.sourceGrantId ||
        currentSource.grant.membershipRootSessionId !== currentSource.identity.id
      ) {
        throw new TaskBoardError('forbidden', 'interactive grant source changed before the serialized request write');
      }
      const currentCoordinator = await this.requireSingleCoordinator(current);
      if (!sameCoordinatorRequestIdentity(request, currentCoordinator)) {
        throw new TaskBoardError('stale-epoch', 'the current coordinator changed before the grant request committed');
      }
      const currentTarget = await this.identity(request.targetSessionId);
      const currentLineage = await this.lineage(currentTarget.id);
      if (
        !currentTarget.live ||
        currentTarget.incarnation !== request.targetSessionIncarnation ||
        currentTarget.runtimeGeneration !== request.targetRuntimeGeneration ||
        currentTarget.parent !== request.targetParentSessionId ||
        !sameStrings(currentLineage, request.parentLineage) ||
        !currentLineage.slice(1).includes(currentSource.identity.id)
      ) {
        throw new TaskBoardError(
          'forbidden',
          'target incarnation, runtime, or ancestor lineage changed before request write',
        );
      }
      if (
        request.boardId !== current.boardId ||
        request.boardEpoch !== current.boardEpoch ||
        request.coordinatorEpoch !== current.coordinatorEpoch ||
        !sameActions(request.allowedActions, taskBoardActionsForRole(request.requestedRole))
      ) {
        throw new TaskBoardError('stale-epoch', 'grant request authority changed before the serialized write');
      }
      const replay = checkedAppliedRequest(current, sourceScope.authorization, 'grant_request', request.payloadHash);
      const previous = current.grantRequests.find(candidate => candidate.requestId === request.requestId);
      if (previous) {
        if (!sameGrantRequest(previous, request)) {
          throw new TaskBoardError(
            'conflict',
            `grant request id ${request.requestId} was reused with a different payload`,
          );
        }
        if (!replay) throw new TaskBoardError('conflict', `grant request ${request.requestId} has no replay identity`);
        const targetBinding = await this.store.readBinding(currentTarget.id);
        if (previous.status === 'pending' && targetBinding !== null) {
          throw new TaskBoardError('conflict', `pending target session ${currentTarget.id} is already board-bound`);
        }
        if (previous.status === 'approved') {
          const approvedGrant = current.grants.find(candidate => candidate.grantId === previous.grantId);
          if (
            !approvedGrant ||
            (targetBinding !== null && !bindingMatchesGrant(targetBinding, current, approvedGrant))
          ) {
            throw new TaskBoardError(
              'conflict',
              `approved grant request ${request.requestId} no longer resolves its binding`,
            );
          }
        }
        return appendAudit(
          current,
          sourceScope.authorization,
          'grant.requested',
          'grant_request',
          request.payloadHash,
          'replayed',
          {
            grantRequestId: request.requestId,
          },
        );
      }
      if (replay) throw new TaskBoardError('conflict', `grant request ${request.requestId} lost its durable intent`);
      if ((await this.store.readBinding(currentTarget.id)) !== null) {
        throw new TaskBoardError('conflict', `target session ${currentTarget.id} already has a task-board binding`);
      }
      const applied = appliedRequest(sourceScope.authorization, 'grant_request', request.payloadHash, {
        grantRequestId: request.requestId,
      });
      return appendAudit(
        {
          ...current,
          grantRequests: compactTaskBoardGrantRequests(
            [...current.grantRequests, request],
            this.options.maxGrantRequests,
          ),
          appliedRequests: appendTaskBoardAppliedRequest(current.appliedRequests, applied),
        },
        sourceScope.authorization,
        'grant.requested',
        'grant_request',
        request.payloadHash,
        'applied',
        { grantRequestId: request.requestId, targetSessionId: target.id, requestedRole },
      );
    });
    const stored = file.grantRequests.find(candidate => candidate.requestId === request.requestId)!;
    return stored;
  }

  async requestExternalInvitation(input: RequestExternalInvitationInput): Promise<TaskBoardInvitation> {
    const resolved = await this.store.findByCapability(input.sourceCapability);
    if (!resolved) throw new TaskBoardError('forbidden', 'unknown board grant capability');
    const sourceScope = await this.resolveTaskScope(
      resolved.grant.sessionId,
      {
        boardCapability: input.sourceCapability,
        runtimeGeneration: input.sourceRuntimeGeneration,
        requestId: input.requestId,
      },
      'invite_request',
    );
    if (sourceScope.kind !== 'board' || sourceScope.authorization.role !== 'top_agent') {
      throw new TaskBoardError('forbidden', 'only an authenticated top-level member may invite an external root');
    }
    const source = await this.requireCurrentGrantState(resolved.file, resolved.grant.grantId, 'invite_request');
    if (
      source.grant.membershipRootSessionId !== source.identity.id ||
      source.identity.mode !== 'interactive' ||
      !source.identity.live
    ) {
      throw new TaskBoardError('forbidden', 'external invitation requires a live interactive membership root');
    }
    const target = await this.identity(input.targetSessionId);
    const targetLineage = await this.lineage(target.id);
    if (
      !target.live ||
      target.mode !== 'interactive' ||
      target.parent !== null ||
      targetLineage.length !== 1 ||
      target.id === source.identity.id
    ) {
      throw new TaskBoardError('forbidden', 'an external invitee must be one exact live interactive top-level session');
    }
    if ((await this.store.readBinding(target.id)) !== null) {
      throw new TaskBoardError('conflict', `external invitee ${target.id} is already board-bound`);
    }
    const coordinator = await this.requireSingleCoordinator(resolved.file);
    const at = now();
    const invitation: TaskBoardInvitation = {
      requestId: input.requestId,
      payloadHash: hashTaskBoardPayload({
        operation: 'external_root_invitation',
        boardId: resolved.file.boardId,
        boardEpoch: resolved.file.boardEpoch,
        sourceGrantId: source.grant.grantId,
        sourceSessionId: source.identity.id,
        sourceSessionIncarnation: source.identity.incarnation,
        sourceRuntimeGeneration: source.identity.runtimeGeneration,
        targetSessionId: target.id,
        targetSessionIncarnation: target.incarnation,
        targetRuntimeGeneration: target.runtimeGeneration,
        coordinatorGrantId: coordinator.grant.grantId,
        coordinatorSessionId: coordinator.identity.id,
        coordinatorSessionIncarnation: coordinator.identity.incarnation,
        coordinatorRuntimeGeneration: coordinator.identity.runtimeGeneration,
        coordinatorEpoch: resolved.file.coordinatorEpoch,
      }),
      boardId: resolved.file.boardId,
      boardEpoch: resolved.file.boardEpoch,
      sourceGrantId: source.grant.grantId,
      sourceSessionId: source.identity.id,
      sourceSessionIncarnation: source.identity.incarnation,
      sourceRuntimeGeneration: source.identity.runtimeGeneration,
      targetSessionId: target.id,
      targetSessionIncarnation: target.incarnation,
      targetRuntimeGeneration: target.runtimeGeneration,
      coordinatorGrantId: coordinator.grant.grantId,
      coordinatorSessionId: coordinator.identity.id,
      coordinatorSessionIncarnation: coordinator.identity.incarnation,
      coordinatorRuntimeGeneration: coordinator.identity.runtimeGeneration,
      coordinatorEpoch: resolved.file.coordinatorEpoch,
      createdAt: at,
      expiresAt: new Date(Date.parse(at) + GRANT_REQUEST_TTL_MS).toISOString(),
      status: 'pending',
    };
    const file = await this.store.transact(resolved.file.boardId, async current => {
      const currentSource = await this.requireCurrentAuthorization(
        current,
        sourceScope.authorization,
        'invite_request',
        'top_agent',
      );
      const activeRoots = current.grants.filter(grant => grant.active && grant.role === 'top_agent');
      const storedInvitation = current.invitations.find(candidate => candidate.requestId === invitation.requestId);
      if (
        !storedInvitation &&
        (activeRoots.length !== 1 ||
          activeRoots[0]!.grantId !== currentSource.grant.grantId ||
          currentSource.grant.membershipRootSessionId !== currentSource.identity.id ||
          currentSource.identity.mode !== 'interactive' ||
          !currentSource.identity.live)
      ) {
        throw new TaskBoardError('forbidden', 'only the sole current interactive root may open an external invitation');
      }
      if (
        current.invitations.some(
          candidate =>
            candidate.requestId !== invitation.requestId &&
            (candidate.status === 'pending' || candidate.status === 'approved'),
        )
      ) {
        throw new TaskBoardError('conflict', 'the board already has an outstanding external-root invitation');
      }
      const currentCoordinator = await this.requireSingleCoordinator(current);
      if (!sameCoordinatorInvitationIdentity(invitation, currentCoordinator)) {
        throw new TaskBoardError('stale-epoch', 'the current coordinator changed before invitation commit');
      }
      const currentTarget = await this.identity(invitation.targetSessionId);
      const currentTargetLineage = await this.lineage(currentTarget.id);
      if (
        !currentTarget.live ||
        currentTarget.mode !== 'interactive' ||
        currentTarget.parent !== null ||
        currentTargetLineage.length !== 1 ||
        currentTarget.incarnation !== invitation.targetSessionIncarnation ||
        currentTarget.runtimeGeneration !== invitation.targetRuntimeGeneration ||
        (await this.store.readBinding(currentTarget.id)) !== null
      ) {
        throw new TaskBoardError('forbidden', 'external invitee identity changed before invitation commit');
      }
      const replay = checkedAppliedRequest(
        current,
        sourceScope.authorization,
        'invite_request',
        invitation.payloadHash,
      );
      const previous = storedInvitation;
      if (previous) {
        if (!sameInvitation(previous, invitation) || !replay) {
          throw new TaskBoardError('conflict', `invitation request id ${invitation.requestId} was reused`);
        }
        return appendAudit(
          current,
          sourceScope.authorization,
          'invitation.requested',
          'invite_request',
          invitation.payloadHash,
          'replayed',
          { invitationRequestId: invitation.requestId, targetSessionId: invitation.targetSessionId },
        );
      }
      if (replay) throw new TaskBoardError('conflict', `invitation ${invitation.requestId} lost its durable intent`);
      return appendAudit(
        {
          ...current,
          invitations: [...current.invitations, invitation],
          appliedRequests: appendTaskBoardAppliedRequest(
            current.appliedRequests,
            appliedRequest(sourceScope.authorization, 'invite_request', invitation.payloadHash),
          ),
        },
        sourceScope.authorization,
        'invitation.requested',
        'invite_request',
        invitation.payloadHash,
        'applied',
        { invitationRequestId: invitation.requestId, targetSessionId: invitation.targetSessionId },
      );
    });
    return file.invitations.find(candidate => candidate.requestId === invitation.requestId)!;
  }

  async approveChildGrant(input: ApproveChildGrantInput): Promise<TaskBoardBinding> {
    const resolved = await this.store.findByCapability(input.coordinatorCapability);
    if (!resolved) throw new TaskBoardError('forbidden', 'unknown coordinator board capability');
    const coordinatorScope = await this.resolveTaskScope(
      resolved.grant.sessionId,
      {
        boardCapability: input.coordinatorCapability,
        runtimeGeneration: input.coordinatorRuntimeGeneration,
        requestId: input.requestId,
      },
      'grant_approve',
    );
    if (coordinatorScope.kind !== 'board') throw new TaskBoardError('forbidden', 'coordinator is not board-bound');
    const authorization = coordinatorScope.authorization;
    if (
      authorization.role !== 'coordinator' ||
      authorization.actorSessionId !== resolved.file.coordinatorSessionId ||
      resolved.grant.coordinatorEpoch !== resolved.file.coordinatorEpoch
    ) {
      throw new TaskBoardError('stale-epoch', 'grant approval requires the single current coordinator and epoch');
    }
    const initialRequest = resolved.file.grantRequests.find(candidate => candidate.requestId === input.grantRequestId);
    if (!initialRequest) throw new TaskBoardError('not-found', `unknown grant request ${input.grantRequestId}`);

    return await this.withBindingLocks([initialRequest.targetSessionId], async () => {
      let pendingCapability: string | undefined;
      let targetBinding: TaskBoardBinding | null = null;
      let expired = false;
      const payloadHash = hashTaskBoardPayload({
        boardId: resolved.file.boardId,
        grantRequestId: input.grantRequestId,
        coordinatorGrantId: authorization.grantId,
        coordinatorSessionId: authorization.actorSessionId,
        coordinatorRuntimeGeneration: authorization.runtimeGeneration,
        coordinatorEpoch: authorization.coordinatorEpoch,
      });
      const file = await this.store.transact(resolved.file.boardId, async current => {
        const approvingCoordinator = await this.requireCurrentAuthorization(
          current,
          authorization,
          'grant_approve',
          'coordinator',
        );
        const currentCoordinator = await this.requireSingleCoordinator(current);
        if (currentCoordinator.grant.grantId !== approvingCoordinator.grant.grantId) {
          throw new TaskBoardError('stale-epoch', 'grant approval requires the single current coordinator grant');
        }
        const request = current.grantRequests.find(candidate => candidate.requestId === input.grantRequestId);
        if (!request) throw new TaskBoardError('not-found', `unknown grant request ${input.grantRequestId}`);
        const replay = checkedAppliedRequest(current, authorization, 'grant_approve', payloadHash);
        if (
          request.boardId !== current.boardId ||
          request.boardEpoch !== current.boardEpoch ||
          request.coordinatorEpoch !== current.coordinatorEpoch ||
          !sameCoordinatorRequestIdentity(request, currentCoordinator)
        ) {
          throw new TaskBoardError('stale-epoch', 'grant request was created under a stale coordinator or board epoch');
        }
        const fixedActions = taskBoardActionsForRole(request.requestedRole);
        if (!sameActions(request.allowedActions, fixedActions)) {
          throw new TaskBoardError('forbidden', 'grant request actions do not exactly match its fixed role policy');
        }
        const source = await this.requireCurrentGrantState(current, request.sourceGrantId, 'grant_request');
        if (
          source.grant.role !== 'top_agent' ||
          source.grant.membershipRootSessionId !== source.identity.id ||
          source.identity.mode !== 'interactive' ||
          !source.identity.live ||
          source.identity.id !== request.interactiveSourceSessionId ||
          source.identity.incarnation !== request.interactiveSourceIncarnation ||
          source.identity.runtimeGeneration !== request.interactiveSourceRuntimeGeneration
        ) {
          throw new TaskBoardError('forbidden', 'interactive source grant is no longer active and current');
        }
        const target = await this.identity(request.targetSessionId);
        const targetLineage = await this.lineage(target.id);
        if (
          !target.live ||
          target.incarnation !== request.targetSessionIncarnation ||
          target.runtimeGeneration !== request.targetRuntimeGeneration ||
          target.parent !== request.targetParentSessionId ||
          !sameStrings(targetLineage, request.parentLineage) ||
          !targetLineage.slice(1).includes(source.identity.id)
        ) {
          throw new TaskBoardError(
            'forbidden',
            'target incarnation, runtime, or ancestor lineage changed before approval',
          );
        }
        const existingTargetBinding = await this.store.readBinding(target.id);
        if (replay && request.status === 'expired') {
          if (replay.resultGrantId !== undefined || replay.grantRequestId !== request.requestId) {
            throw new TaskBoardError('conflict', 'expired grant replay no longer resolves its terminal result');
          }
          expired = true;
          return appendAudit(current, authorization, 'grant.expired', 'grant_approve', payloadHash, 'replayed', {
            grantRequestId: request.requestId,
            expiredAt: request.expiresAt,
          });
        }
        if (replay) {
          const replayGrant = current.grants.find(candidate => candidate.grantId === request.grantId);
          if (
            request.status !== 'approved' ||
            !replayGrant ||
            replay.resultGrantId !== replayGrant.grantId ||
            replayGrant.sessionId !== target.id ||
            replayGrant.sessionIncarnation !== target.incarnation ||
            replayGrant.runtimeGeneration !== target.runtimeGeneration ||
            replayGrant.role !== request.requestedRole ||
            !sameActions(replayGrant.allowedActions, fixedActions) ||
            replayGrant.parentSessionId !== request.targetParentSessionId ||
            replayGrant.interactiveSourceSessionId !== request.interactiveSourceSessionId ||
            replayGrant.coordinatorSessionId !== current.coordinatorSessionId ||
            replayGrant.boardEpoch !== current.boardEpoch ||
            replayGrant.coordinatorEpoch !== current.coordinatorEpoch ||
            !replayGrant.active ||
            (request.pendingCapability !== undefined &&
              hashTaskBoardSecret(request.pendingCapability) !== replayGrant.capabilityHash) ||
            (existingTargetBinding !== null && !bindingMatchesGrant(existingTargetBinding, current, replayGrant))
          ) {
            throw new TaskBoardError('conflict', 'approved grant replay no longer resolves its exact recorded result');
          }
          pendingCapability = request.pendingCapability;
          return appendAudit(current, authorization, 'grant.approved', 'grant_approve', payloadHash, 'replayed', {
            grantRequestId: request.requestId,
          });
        }
        if (request.status !== 'pending') throw new TaskBoardError('conflict', `grant request is ${request.status}`);
        if (Date.parse(request.expiresAt) <= Date.now()) {
          expired = true;
          const applied = appliedRequest(authorization, 'grant_approve', payloadHash, {
            grantRequestId: request.requestId,
          });
          return appendAudit(
            {
              ...current,
              grantRequests: current.grantRequests.map(candidate =>
                candidate.requestId === request.requestId
                  ? { ...candidate, status: 'expired', refusalReason: 'grant request expired before approval' }
                  : candidate,
              ),
              appliedRequests: appendTaskBoardAppliedRequest(current.appliedRequests, applied),
            },
            authorization,
            'grant.expired',
            'grant_approve',
            payloadHash,
            'applied',
            { grantRequestId: request.requestId, expiredAt: request.expiresAt },
          );
        }
        if (existingTargetBinding !== null) {
          throw new TaskBoardError('conflict', `target session ${target.id} already has a task-board binding`);
        }
        const capability = mintTaskBoardCapability();
        const grantId = mintTaskBoardGrantId();
        const at = now();
        const grant: TaskBoardGrant = {
          grantId,
          capabilityHash: hashTaskBoardSecret(capability),
          sessionId: target.id,
          sessionIncarnation: target.incarnation,
          runtimeGeneration: target.runtimeGeneration,
          role: request.requestedRole,
          allowedActions: fixedActions,
          parentSessionId: request.targetParentSessionId,
          interactiveSourceSessionId: request.interactiveSourceSessionId,
          coordinatorSessionId: current.coordinatorSessionId,
          membershipRootSessionId: source.grant.membershipRootSessionId,
          boardEpoch: current.boardEpoch,
          coordinatorEpoch: current.coordinatorEpoch,
          grantedAt: at,
          grantedBySessionId: authorization.actorSessionId,
          active: true,
        };
        pendingCapability = capability;
        const nextRequest: TaskBoardGrantRequest = {
          ...request,
          status: 'approved',
          approvedAt: at,
          approvedBySessionId: authorization.actorSessionId!,
          grantId,
          pendingCapability: capability,
        };
        const applied = appliedRequest(authorization, 'grant_approve', payloadHash, {
          resultGrantId: grantId,
          grantRequestId: request.requestId,
        });
        return appendAudit(
          {
            ...current,
            grants: [...current.grants, grant],
            grantRequests: current.grantRequests.map(candidate =>
              candidate.requestId === request.requestId ? nextRequest : candidate,
            ),
            appliedRequests: appendTaskBoardAppliedRequest(current.appliedRequests, applied),
          },
          authorization,
          'grant.approved',
          'grant_approve',
          payloadHash,
          'applied',
          { grantRequestId: request.requestId, grantId, targetSessionId: target.id, role: request.requestedRole },
        );
      });

      if (expired) throw new TaskBoardError('forbidden', `grant request ${input.grantRequestId} has expired`);

      const request = file.grantRequests.find(candidate => candidate.requestId === input.grantRequestId)!;
      const grant = file.grants.find(candidate => candidate.grantId === request.grantId)!;
      if (pendingCapability) {
        targetBinding = bindingFor(file, grant, pendingCapability);
        await this.store.writeBinding(targetBinding);
        await this.clearPendingCapability(file.boardId, request.requestId, pendingCapability);
      } else {
        targetBinding = await this.store.readBinding(request.targetSessionId);
      }
      if (!targetBinding || targetBinding.grantId !== grant.grantId) {
        throw new TaskBoardError('unavailable', 'approved grant is awaiting binding reconciliation');
      }
      return targetBinding;
    });
  }

  async approveExternalInvitation(input: ApproveExternalInvitationInput): Promise<ApprovedExternalInvitation> {
    const resolved = await this.store.findByCapability(input.coordinatorCapability);
    if (!resolved) throw new TaskBoardError('forbidden', 'unknown coordinator board capability');
    const coordinatorScope = await this.resolveTaskScope(
      resolved.grant.sessionId,
      {
        boardCapability: input.coordinatorCapability,
        runtimeGeneration: input.coordinatorRuntimeGeneration,
        requestId: input.requestId,
      },
      'invite_approve',
    );
    if (coordinatorScope.kind !== 'board' || coordinatorScope.authorization.role !== 'coordinator') {
      throw new TaskBoardError('forbidden', 'external invitation approval requires the current coordinator');
    }
    const authorization = coordinatorScope.authorization;
    const payloadHash = hashTaskBoardPayload({
      operation: 'external_root_invitation_approval',
      boardId: resolved.file.boardId,
      invitationRequestId: input.invitationRequestId,
      coordinatorGrantId: authorization.grantId,
      coordinatorSessionId: authorization.actorSessionId,
      coordinatorRuntimeGeneration: authorization.runtimeGeneration,
      coordinatorEpoch: authorization.coordinatorEpoch,
    });
    let acceptanceCapability = '';
    let expired = false;
    const file = await this.store.transact(resolved.file.boardId, async current => {
      const approving = await this.requireCurrentAuthorization(current, authorization, 'invite_approve', 'coordinator');
      const currentCoordinator = await this.requireSingleCoordinator(current);
      if (currentCoordinator.grant.grantId !== approving.grant.grantId) {
        throw new TaskBoardError('stale-epoch', 'external invitation approval requires the current coordinator key');
      }
      const invitation = current.invitations.find(candidate => candidate.requestId === input.invitationRequestId);
      if (!invitation) throw new TaskBoardError('not-found', `unknown invitation ${input.invitationRequestId}`);
      const replay = checkedAppliedRequest(current, authorization, 'invite_approve', payloadHash);
      if (
        invitation.boardId !== current.boardId ||
        invitation.boardEpoch !== current.boardEpoch ||
        invitation.coordinatorEpoch !== current.coordinatorEpoch ||
        !sameCoordinatorInvitationIdentity(invitation, currentCoordinator)
      ) {
        throw new TaskBoardError('stale-epoch', 'invitation belongs to a stale board or coordinator epoch');
      }
      const source = await this.requireCurrentGrantState(current, invitation.sourceGrantId, 'invite_request');
      if (
        source.grant.role !== 'top_agent' ||
        source.grant.membershipRootSessionId !== source.identity.id ||
        source.identity.id !== invitation.sourceSessionId ||
        source.identity.incarnation !== invitation.sourceSessionIncarnation ||
        source.identity.runtimeGeneration !== invitation.sourceRuntimeGeneration ||
        source.identity.mode !== 'interactive' ||
        !source.identity.live
      ) {
        throw new TaskBoardError('forbidden', 'invitation source is no longer a live top-level member');
      }
      const target = await this.identity(invitation.targetSessionId);
      const targetLineage = await this.lineage(target.id);
      const targetBinding = await this.store.readBinding(target.id);
      if (
        !target.live ||
        target.mode !== 'interactive' ||
        target.parent !== null ||
        targetLineage.length !== 1 ||
        target.incarnation !== invitation.targetSessionIncarnation ||
        target.runtimeGeneration !== invitation.targetRuntimeGeneration ||
        (targetBinding !== null && !(replay && invitation.status === 'accepted'))
      ) {
        throw new TaskBoardError('forbidden', 'external invitee changed before coordinator approval');
      }
      if (replay && invitation.status === 'expired') {
        expired = true;
        return appendAudit(current, authorization, 'invitation.expired', 'invite_approve', payloadHash, 'replayed', {
          invitationRequestId: invitation.requestId,
          expiredAt: invitation.expiresAt,
        });
      }
      if (replay) {
        if (
          (invitation.status !== 'approved' && invitation.status !== 'accepted') ||
          !invitation.pendingAcceptanceCapability ||
          hashTaskBoardSecret(invitation.pendingAcceptanceCapability) !== invitation.acceptanceCapabilityHash
        ) {
          throw new TaskBoardError('conflict', 'invitation approval replay no longer resolves its exact capability');
        }
        acceptanceCapability = invitation.pendingAcceptanceCapability;
        return appendAudit(current, authorization, 'invitation.approved', 'invite_approve', payloadHash, 'replayed', {
          invitationRequestId: invitation.requestId,
          targetSessionId: invitation.targetSessionId,
        });
      }
      if (invitation.status !== 'pending') {
        throw new TaskBoardError('conflict', `external invitation is ${invitation.status}`);
      }
      if (Date.parse(invitation.expiresAt) <= Date.now()) {
        expired = true;
        return appendAudit(
          {
            ...current,
            invitations: current.invitations.map(candidate =>
              candidate.requestId === invitation.requestId
                ? { ...candidate, status: 'expired', refusalReason: 'invitation expired before approval' }
                : candidate,
            ),
            appliedRequests: appendTaskBoardAppliedRequest(
              current.appliedRequests,
              appliedRequest(authorization, 'invite_approve', payloadHash),
            ),
          },
          authorization,
          'invitation.expired',
          'invite_approve',
          payloadHash,
          'applied',
          { invitationRequestId: invitation.requestId, expiredAt: invitation.expiresAt },
        );
      }
      acceptanceCapability = mintTaskBoardCapability();
      const approvedAt = now();
      return appendAudit(
        {
          ...current,
          invitations: current.invitations.map(candidate =>
            candidate.requestId === invitation.requestId
              ? {
                  ...candidate,
                  status: 'approved',
                  approvedAt,
                  approvedBySessionId: authorization.actorSessionId!,
                  acceptanceCapabilityHash: hashTaskBoardSecret(acceptanceCapability),
                  pendingAcceptanceCapability: acceptanceCapability,
                }
              : candidate,
          ),
          appliedRequests: appendTaskBoardAppliedRequest(
            current.appliedRequests,
            appliedRequest(authorization, 'invite_approve', payloadHash),
          ),
        },
        authorization,
        'invitation.approved',
        'invite_approve',
        payloadHash,
        'applied',
        { invitationRequestId: invitation.requestId, targetSessionId: invitation.targetSessionId },
      );
    });
    if (expired) throw new TaskBoardError('forbidden', `external invitation ${input.invitationRequestId} has expired`);
    const invitation = file.invitations.find(candidate => candidate.requestId === input.invitationRequestId)!;
    if (!acceptanceCapability) {
      throw new TaskBoardError('unavailable', 'approved invitation lost its acceptance capability');
    }
    return { invitation, acceptanceCapability };
  }

  async acceptExternalInvitation(input: AcceptExternalInvitationInput): Promise<TaskBoardBinding> {
    const capabilityHash = hashTaskBoardSecret(input.acceptanceCapability);
    let resolved: { file: TaskBoardFile; invitation: TaskBoardInvitation } | null = null;
    for (const boardId of await this.store.listBoardIds()) {
      const file = await this.store.require(boardId);
      const invitation = file.invitations.find(candidate => candidate.acceptanceCapabilityHash === capabilityHash);
      if (!invitation) continue;
      if (resolved) throw new TaskBoardError('conflict', 'acceptance capability resolves more than one invitation');
      resolved = { file, invitation };
    }
    if (!resolved) throw new TaskBoardError('forbidden', 'unknown external invitation capability');
    const initialTarget = await this.identity(input.targetSessionId);
    const accepted = await this.withBindingLocks([initialTarget.id], async () => {
      const target = await this.identity(input.targetSessionId);
      if (
        target.id !== initialTarget.id ||
        target.id !== resolved.invitation.targetSessionId ||
        target.incarnation !== resolved.invitation.targetSessionIncarnation ||
        target.runtimeGeneration !== input.targetRuntimeGeneration ||
        target.runtimeGeneration !== resolved.invitation.targetRuntimeGeneration ||
        target.mode !== 'interactive' ||
        target.parent !== null ||
        !target.live
      ) {
        throw new TaskBoardError(
          'stale-generation',
          'invitation acceptance does not match the live invitee generation',
        );
      }
      const authorization: TaskBoardAuthorization = {
        boardId: resolved.file.boardId,
        grantId: `invitation:${resolved.invitation.requestId}`,
        actorSessionId: target.id,
        actorName: target.name,
        role: 'invitee',
        allowedActions: ['invite_accept'],
        boardEpoch: resolved.file.boardEpoch,
        coordinatorEpoch: resolved.file.coordinatorEpoch,
        runtimeGeneration: target.runtimeGeneration,
        capabilityId: `invitation:${capabilityHash.slice(0, 24)}`,
        capabilityHash,
        requestId: input.requestId,
      };
      const payloadHash = hashTaskBoardPayload({
        operation: 'external_root_invitation_acceptance',
        invitationRequestId: resolved.invitation.requestId,
        targetSessionId: target.id,
        targetIncarnation: target.incarnation,
        targetRuntimeGeneration: target.runtimeGeneration,
        acceptanceCapabilityHash: capabilityHash,
      });
      let boardCapability = '';
      let grantId = '';
      let expired = false;
      const file = await this.store.transact(resolved.file.boardId, async current => {
        const invitation = current.invitations.find(
          candidate => candidate.requestId === resolved!.invitation.requestId,
        );
        if (!invitation || invitation.acceptanceCapabilityHash !== capabilityHash) {
          throw new TaskBoardError('forbidden', 'external invitation capability is no longer current');
        }
        const replay = checkedAppliedRequest(current, authorization, 'invite_accept', payloadHash);
        if (!replay && invitation.boardEpoch !== current.boardEpoch) {
          throw new TaskBoardError('stale-epoch', 'external invitation was approved under a stale board epoch');
        }
        const currentTarget = await this.identity(invitation.targetSessionId);
        const targetLineage = await this.lineage(currentTarget.id);
        if (
          !currentTarget.live ||
          currentTarget.mode !== 'interactive' ||
          currentTarget.parent !== null ||
          targetLineage.length !== 1 ||
          currentTarget.incarnation !== invitation.targetSessionIncarnation ||
          currentTarget.runtimeGeneration !== invitation.targetRuntimeGeneration
        ) {
          throw new TaskBoardError('stale-generation', 'external invitee changed before acceptance commit');
        }
        if (replay && invitation.status === 'expired') {
          expired = true;
          return appendAudit(current, authorization, 'invitation.expired', 'invite_accept', payloadHash, 'replayed', {
            invitationRequestId: invitation.requestId,
            expiredAt: invitation.expiresAt,
          });
        }
        if (replay) {
          const grant = current.grants.find(candidate => candidate.grantId === invitation.grantId);
          if (
            invitation.status !== 'accepted' ||
            !grant ||
            !grant.active ||
            grant.sessionId !== currentTarget.id ||
            grant.role !== 'top_agent' ||
            grant.membershipRootSessionId !== currentTarget.id ||
            replay.resultGrantId !== grant.grantId
          ) {
            throw new TaskBoardError('conflict', 'invitation acceptance replay no longer resolves its membership');
          }
          grantId = grant.grantId;
          boardCapability =
            invitation.pendingBoardCapability ?? (await this.store.readBinding(currentTarget.id))?.capability ?? '';
          return appendAudit(current, authorization, 'invitation.accepted', 'invite_accept', payloadHash, 'replayed', {
            invitationRequestId: invitation.requestId,
            grantId: grant.grantId,
          });
        }
        if (invitation.status !== 'approved') {
          throw new TaskBoardError('conflict', `external invitation is ${invitation.status}`);
        }
        if (Date.parse(invitation.expiresAt) <= Date.now()) {
          expired = true;
          return appendAudit(
            {
              ...current,
              invitations: current.invitations.map(candidate =>
                candidate.requestId === invitation.requestId
                  ? { ...candidate, status: 'expired', refusalReason: 'invitation expired before acceptance' }
                  : candidate,
              ),
              appliedRequests: appendTaskBoardAppliedRequest(
                current.appliedRequests,
                appliedRequest(authorization, 'invite_accept', payloadHash),
              ),
            },
            authorization,
            'invitation.expired',
            'invite_accept',
            payloadHash,
            'applied',
            { invitationRequestId: invitation.requestId, expiredAt: invitation.expiresAt },
          );
        }
        const source = await this.requireCurrentGrantState(current, invitation.sourceGrantId, 'invite_request');
        if (source.grant.role !== 'top_agent' || source.grant.membershipRootSessionId !== source.identity.id) {
          throw new TaskBoardError('forbidden', 'invitation source is no longer an active membership root');
        }
        await this.requireSingleCoordinator(current);
        if ((await this.store.readBinding(currentTarget.id)) !== null) {
          throw new TaskBoardError('conflict', 'external invitee acquired another board binding');
        }
        const boardEpoch = current.boardEpoch + 1;
        boardCapability = mintTaskBoardCapability();
        grantId = mintTaskBoardGrantId();
        const grant: TaskBoardGrant = {
          grantId,
          capabilityHash: hashTaskBoardSecret(boardCapability),
          sessionId: currentTarget.id,
          sessionIncarnation: currentTarget.incarnation,
          runtimeGeneration: currentTarget.runtimeGeneration,
          role: 'top_agent',
          allowedActions: taskBoardActionsForRole('top_agent'),
          parentSessionId: null,
          interactiveSourceSessionId: source.identity.id,
          coordinatorSessionId: current.coordinatorSessionId,
          membershipRootSessionId: currentTarget.id,
          boardEpoch,
          coordinatorEpoch: current.coordinatorEpoch,
          grantedAt: now(),
          grantedBySessionId: current.coordinatorSessionId,
          active: true,
        };
        const applied = appliedRequest(authorization, 'invite_accept', payloadHash, {
          resultGrantId: grantId,
          resultBoardEpoch: boardEpoch,
          resultCoordinatorEpoch: current.coordinatorEpoch,
        });
        const refused = refuseOpenEpochIntents(
          {
            ...current,
            boardEpoch,
            grants: [
              ...current.grants.map(candidate => (candidate.active ? { ...candidate, boardEpoch } : candidate)),
              grant,
            ],
            invitations: current.invitations.map(candidate =>
              candidate.requestId === invitation.requestId
                ? {
                    ...candidate,
                    status: 'accepted',
                    acceptedAt: now(),
                    grantId,
                    pendingBoardCapability: boardCapability,
                  }
                : candidate,
            ),
            appliedRequests: appendTaskBoardAppliedRequest(current.appliedRequests, applied),
          },
          authorization,
          'invite_accept',
          payloadHash,
          'board epoch advanced when an external membership root was accepted',
          { excludeInvitationRequestId: invitation.requestId },
        );
        return appendAudit(
          refused.file,
          authorization,
          'invitation.accepted',
          'invite_accept',
          payloadHash,
          'applied',
          {
            invitationRequestId: invitation.requestId,
            grantId,
            targetSessionId: currentTarget.id,
            refusedGrantRequestIds: refused.grantRequestIds,
            refusedInvitationRequestIds: refused.invitationRequestIds,
          },
        );
      });
      if (expired) throw new TaskBoardError('forbidden', 'external invitation expired before acceptance');
      const grant = file.grants.find(candidate => candidate.grantId === grantId);
      if (!grant) throw new TaskBoardError('unavailable', 'accepted invitation lost its membership grant');
      let binding = await this.store.readBinding(target.id);
      if (!binding) {
        if (!boardCapability)
          throw new TaskBoardError('unavailable', 'accepted invitation awaits binding reconciliation');
        binding = bindingFor(file, grant, boardCapability);
        await this.store.writeBinding(binding);
      }
      await this.clearPendingInvitationCapability(file.boardId, resolved.invitation.requestId, boardCapability);
      return { binding, file, target };
    });
    await this.refreshActiveBindings(accepted.file);
    const proof = await this.resolveTaskScope(
      accepted.target.id,
      {
        actor: accepted.target.id,
        actorName: accepted.target.name,
        boardCapability: accepted.binding.capability,
        runtimeGeneration: accepted.target.runtimeGeneration,
        requestId: `${input.requestId}:proof`,
      },
      'read',
    );
    if (proof.kind !== 'board')
      throw new TaskBoardError('unavailable', 'accepted invitation did not prove board access');
    return accepted.binding;
  }

  async relinquishMembership(input: RelinquishMembershipInput): Promise<TaskBoardFile> {
    const resolved = await this.store.findByCapability(input.capability);
    if (!resolved) throw new TaskBoardError('forbidden', 'unknown board membership capability');
    const payloadHash = hashTaskBoardPayload({
      operation: 'membership_relinquish',
      grantId: resolved.grant.grantId,
      sessionId: resolved.grant.sessionId,
    });
    if (!resolved.grant.active) {
      const replay = resolved.file.appliedRequests.find(request => request.requestId === input.requestId);
      if (
        replay?.action !== 'membership_relinquish' ||
        replay.payloadHash !== payloadHash ||
        replay.grantId !== resolved.grant.grantId ||
        replay.actorSessionId !== resolved.grant.sessionId ||
        replay.runtimeGeneration !== input.runtimeGeneration ||
        replay.resultBoardEpoch !== resolved.file.boardEpoch
      ) {
        throw new TaskBoardError('forbidden', 'revoked membership cannot authorize a new relinquish request');
      }
      return resolved.file;
    }
    const scope = await this.resolveTaskScope(
      resolved.grant.sessionId,
      {
        boardCapability: input.capability,
        runtimeGeneration: input.runtimeGeneration,
        requestId: input.requestId,
      },
      'membership_relinquish',
    );
    if (scope.kind !== 'board' || scope.authorization.role !== 'top_agent') {
      throw new TaskBoardError('forbidden', 'only a top-level member may relinquish its own membership');
    }
    const file = await this.store.transact(scope.board.boardId, async current => {
      const member = await this.requireCurrentAuthorization(
        current,
        scope.authorization,
        'membership_relinquish',
        'top_agent',
      );
      if (member.grant.membershipRootSessionId !== member.identity.id) {
        throw new TaskBoardError('forbidden', 'only a membership root may relinquish top-level membership');
      }
      const replay = checkedAppliedRequest(current, scope.authorization, 'membership_relinquish', payloadHash);
      if (replay) return current;
      const otherRoots = current.grants.filter(
        candidate => candidate.active && candidate.role === 'top_agent' && candidate.grantId !== member.grant.grantId,
      );
      if (otherRoots.length !== 1) {
        throw new TaskBoardError(
          'forbidden',
          'membership may be relinquished only after one accepted replacement root exists',
        );
      }
      await this.requireCurrentGrantState(current, otherRoots[0]!.grantId, 'membership_relinquish');
      const boardEpoch = current.boardEpoch + 1;
      const applied = appliedRequest(scope.authorization, 'membership_relinquish', payloadHash, {
        resultGrantId: member.grant.grantId,
        resultBoardEpoch: boardEpoch,
        resultCoordinatorEpoch: current.coordinatorEpoch,
      });
      const refused = refuseOpenEpochIntents(
        {
          ...current,
          boardEpoch,
          grants: current.grants.map(candidate =>
            candidate.grantId === member.grant.grantId
              ? {
                  ...candidate,
                  active: false,
                  revokedAt: now(),
                  revokedBySessionId: member.identity.id,
                  revokeReason: 'member voluntarily relinquished board membership',
                }
              : candidate.active
                ? { ...candidate, boardEpoch }
                : candidate,
          ),
          appliedRequests: appendTaskBoardAppliedRequest(current.appliedRequests, applied),
        },
        scope.authorization,
        'membership_relinquish',
        payloadHash,
        'board epoch advanced when a membership root relinquished access',
      );
      return appendAudit(
        refused.file,
        scope.authorization,
        'member.relinquished',
        'membership_relinquish',
        payloadHash,
        'applied',
        {
          grantId: member.grant.grantId,
          sessionId: member.identity.id,
          sessionStopped: false,
          refusedGrantRequestIds: refused.grantRequestIds,
          refusedInvitationRequestIds: refused.invitationRequestIds,
        },
      );
    });
    await this.refreshActiveBindings(file);
    return file;
  }

  async setTopAgentMarkDone(input: BoardAdminMutationInput & { enabled: boolean }): Promise<TaskBoardBinding> {
    const scope = await this.resolveTaskScope(
      input.sessionId,
      { humanAdmin: true, requestId: input.requestId },
      'acl_admin',
    );
    if (scope.kind !== 'board' || scope.authorization.role !== 'human_admin') {
      throw new TaskBoardError('forbidden', 'mark_done administration requires the human admin actor');
    }
    const payloadHash = hashTaskBoardPayload({
      operation: 'mark_done',
      sessionId: input.sessionId,
      enabled: input.enabled,
    });
    let topGrantId = '';
    const file = await this.store.transact(scope.board.boardId, current => {
      const replay = checkedAppliedRequest(current, scope.authorization, 'acl_admin', payloadHash);
      const top = current.grants.find(
        grant => grant.active && grant.role === 'top_agent' && grant.sessionId === current.creator,
      );
      if (!top) throw new TaskBoardError('not-found', 'the board creator no longer has an active top-agent grant');
      topGrantId = top.grantId;
      if (replay) return current;
      const boardEpoch = current.boardEpoch + 1;
      const grants = current.grants.map(grant => {
        if (!grant.active) return grant;
        const allowedActions =
          grant.grantId === top.grantId
            ? input.enabled
              ? [...new Set<TaskBoardAction>([...grant.allowedActions, 'mark_done'])]
              : grant.allowedActions.filter(action => action !== 'mark_done')
            : grant.allowedActions;
        return { ...grant, boardEpoch, allowedActions };
      });
      const applied = appliedRequest(scope.authorization, 'acl_admin', payloadHash, {
        resultGrantId: top.grantId,
        resultBoardEpoch: boardEpoch,
        resultCoordinatorEpoch: current.coordinatorEpoch,
      });
      const refused = refuseOpenEpochIntents(
        {
          ...current,
          boardEpoch,
          grants,
          appliedRequests: appendTaskBoardAppliedRequest(current.appliedRequests, applied),
        },
        scope.authorization,
        'acl_admin',
        payloadHash,
        'board epoch advanced when creator mark_done authority changed',
      );
      return appendAudit(refused.file, scope.authorization, 'grant.updated', 'acl_admin', payloadHash, 'applied', {
        grantId: top.grantId,
        markDone: input.enabled,
        refusedGrantRequestIds: refused.grantRequestIds,
        refusedInvitationRequestIds: refused.invitationRequestIds,
      });
    });
    await this.refreshActiveBindings(file);
    const binding = await this.store.readBinding(file.grants.find(grant => grant.grantId === topGrantId)!.sessionId);
    if (!binding) throw new TaskBoardError('unavailable', 'top-agent binding refresh did not complete');
    return binding;
  }

  async replaceCoordinator(input: ReplaceCoordinatorInput): Promise<TaskBoardBinding> {
    const scope = await this.resolveTaskScope(
      input.sessionId,
      { humanAdmin: true, requestId: input.requestId },
      'acl_admin',
    );
    if (scope.kind !== 'board' || scope.authorization.role !== 'human_admin') {
      throw new TaskBoardError('forbidden', 'coordinator replacement requires the human admin actor');
    }
    const initialReplacement = await this.identity(input.replacementSessionId);
    const replaced = await this.withBindingLocks([initialReplacement.id], async () => {
      const replacement = await this.identity(input.replacementSessionId);
      if (replacement.id !== initialReplacement.id) {
        throw new TaskBoardError(
          'stale-generation',
          'replacement coordinator identity changed while awaiting its binding lock',
        );
      }
      const replacementLineage = await this.lineage(replacement.id);
      if (!replacement.live || replacement.parent === null) {
        throw new TaskBoardError('forbidden', 'replacement coordinator must be a live child session');
      }
      const payloadHash = hashTaskBoardPayload({
        operation: 'replace_coordinator',
        boardId: scope.board.boardId,
        replacementSessionId: replacement.id,
        replacementSessionIncarnation: replacement.incarnation,
        replacementRuntimeGeneration: replacement.runtimeGeneration,
        replacementParentSessionId: replacement.parent,
        replacementLineage,
      });
      let replacementGrantId = '';
      let pendingCapability: string | undefined;
      const file = await this.store.transact(scope.board.boardId, async current => {
        const replay = checkedAppliedRequest(current, scope.authorization, 'acl_admin', payloadHash);
        if (replay) {
          const grant = current.grants.find(candidate => candidate.grantId === replay.resultGrantId);
          if (
            !grant ||
            !grant.active ||
            grant.role !== 'coordinator' ||
            grant.sessionId !== replacement.id ||
            grant.sessionIncarnation !== replacement.incarnation ||
            grant.runtimeGeneration !== replacement.runtimeGeneration ||
            grant.parentSessionId !== replacement.parent ||
            current.coordinatorSessionId !== replacement.id ||
            grant.boardEpoch !== current.boardEpoch ||
            grant.coordinatorEpoch !== current.coordinatorEpoch ||
            !sameActions(grant.allowedActions, TASK_BOARD_CURRENT_COORDINATOR_ACTIONS) ||
            replay.resultSessionId !== replacement.id ||
            (replay.pendingCapability !== undefined &&
              hashTaskBoardSecret(replay.pendingCapability) !== grant.capabilityHash)
          ) {
            throw new TaskBoardError('conflict', 'coordinator replacement replay no longer resolves its exact result');
          }
          replacementGrantId = grant.grantId;
          pendingCapability = replay.pendingCapability;
          return appendAudit(
            current,
            scope.authorization,
            'coordinator.replaced',
            'acl_admin',
            payloadHash,
            'replayed',
            { coordinatorSessionId: replacement.id, grantId: grant.grantId },
          );
        }

        const currentReplacement = await this.identity(replacement.id);
        const currentLineage = await this.lineage(currentReplacement.id);
        const activeTopAgents = current.grants.filter(candidate => candidate.active && candidate.role === 'top_agent');
        const lineageRoots = activeTopAgents.filter(candidate => currentLineage.slice(1).includes(candidate.sessionId));
        if (
          !currentReplacement.live ||
          currentReplacement.incarnation !== replacement.incarnation ||
          currentReplacement.runtimeGeneration !== replacement.runtimeGeneration ||
          currentReplacement.parent !== replacement.parent ||
          !sameStrings(currentLineage, replacementLineage) ||
          lineageRoots.length !== 1
        ) {
          throw new TaskBoardError(
            'forbidden',
            'replacement coordinator identity or tree lineage changed before commit',
          );
        }
        if ((await this.store.readBinding(replacement.id)) !== null) {
          throw new TaskBoardError(
            'conflict',
            `replacement session ${replacement.id} already has a task-board binding`,
          );
        }
        const previousCoordinatorGrants = current.grants.filter(
          candidate =>
            candidate.active &&
            candidate.role === 'coordinator' &&
            candidate.sessionId === current.coordinatorSessionId,
        );
        if (previousCoordinatorGrants.length > 1) {
          throw new TaskBoardError('invalid', 'multiple active grants name the current coordinator');
        }

        const capability = mintTaskBoardCapability();
        const grantId = mintTaskBoardGrantId();
        const at = now();
        const boardEpoch = current.boardEpoch + 1;
        const coordinatorEpoch = current.coordinatorEpoch + 1;
        const grant: TaskBoardGrant = {
          grantId,
          capabilityHash: hashTaskBoardSecret(capability),
          sessionId: replacement.id,
          sessionIncarnation: replacement.incarnation,
          runtimeGeneration: replacement.runtimeGeneration,
          role: 'coordinator',
          allowedActions: taskBoardActionsForCurrentCoordinator(),
          parentSessionId: replacement.parent,
          interactiveSourceSessionId: lineageRoots[0]!.sessionId,
          coordinatorSessionId: replacement.id,
          membershipRootSessionId: lineageRoots[0]!.membershipRootSessionId,
          boardEpoch,
          coordinatorEpoch,
          grantedAt: at,
          grantedBySessionId: null,
          active: true,
        };
        replacementGrantId = grantId;
        pendingCapability = capability;
        const applied = appliedRequest(scope.authorization, 'acl_admin', payloadHash, {
          resultGrantId: grantId,
          resultSessionId: replacement.id,
          resultBoardEpoch: boardEpoch,
          resultCoordinatorEpoch: coordinatorEpoch,
          pendingCapability: capability,
        });
        const revokedGrantIds = previousCoordinatorGrants.map(candidate => candidate.grantId);
        const previousIds = new Set(revokedGrantIds);
        const grants = current.grants.map(candidate =>
          previousIds.has(candidate.grantId)
            ? {
                ...candidate,
                active: false,
                revokedAt: at,
                revokedBySessionId: null,
                revokeReason: `coordinator replaced by ${replacement.id}`,
              }
            : candidate.active
              ? { ...candidate, boardEpoch, coordinatorEpoch, coordinatorSessionId: replacement.id }
              : candidate,
        );
        const refused = refuseOpenEpochIntents(
          {
            ...current,
            boardEpoch,
            coordinatorEpoch,
            coordinatorSessionId: replacement.id,
            grants: [...grants, grant],
            appliedRequests: appendTaskBoardAppliedRequest(current.appliedRequests, applied),
          },
          scope.authorization,
          'acl_admin',
          payloadHash,
          'coordinator replaced before approval',
        );
        let audited = refused.file;
        for (const revoked of previousCoordinatorGrants) {
          audited = appendAudit(
            audited,
            scope.authorization,
            'grant.revoked',
            'acl_admin',
            hashTaskBoardPayload({
              operation: 'automatic_coordinator_revocation',
              triggerPayloadHash: payloadHash,
              grantId: revoked.grantId,
              replacementSessionId: replacement.id,
            }),
            'applied',
            {
              grantId: revoked.grantId,
              sessionId: revoked.sessionId,
              reason: `coordinator replaced by ${replacement.id}`,
              automatic: true,
              triggerRequestId: scope.authorization.requestId,
            },
          );
        }
        return appendAudit(audited, scope.authorization, 'coordinator.replaced', 'acl_admin', payloadHash, 'applied', {
          previousCoordinatorSessionId: current.coordinatorSessionId,
          coordinatorSessionId: replacement.id,
          grantId,
          revokedGrantIds,
          refusedGrantRequestIds: refused.grantRequestIds,
          refusedInvitationRequestIds: refused.invitationRequestIds,
          boardEpoch,
          coordinatorEpoch,
        });
      });

      const grant = file.grants.find(candidate => candidate.grantId === replacementGrantId);
      if (!grant) throw new TaskBoardError('unavailable', 'replacement coordinator grant disappeared after commit');
      let binding = await this.store.readBinding(replacement.id);
      if (pendingCapability) {
        if (binding !== null && !bindingMatchesGrant(binding, file, grant)) {
          throw new TaskBoardError('conflict', 'replacement coordinator acquired another binding during commit');
        }
        if (binding === null) {
          binding = bindingFor(file, grant, pendingCapability);
          await this.store.writeBinding(binding);
        }
        await this.clearPendingAppliedCapability(file.boardId, input.requestId, pendingCapability);
      }
      binding = await this.store.readBinding(replacement.id);
      if (!binding || !bindingMatchesGrant(binding, file, grant)) {
        throw new TaskBoardError('unavailable', 'replacement coordinator binding is awaiting reconciliation');
      }
      return { binding, file };
    });
    await this.refreshActiveBindings(replaced.file);
    return replaced.binding;
  }

  async revokeGrant(input: BoardAdminMutationInput & { grantId: string; reason: string }): Promise<TaskBoardFile> {
    const scope = await this.resolveTaskScope(
      input.sessionId,
      { humanAdmin: true, requestId: input.requestId },
      'acl_admin',
    );
    if (scope.kind !== 'board' || scope.authorization.role !== 'human_admin') {
      throw new TaskBoardError('forbidden', 'grant revocation requires the human admin actor');
    }
    const reason = input.reason.trim();
    if (!reason) throw new TaskBoardError('invalid', 'grant revocation requires a reason');
    const payloadHash = hashTaskBoardPayload({ operation: 'revoke', grantId: input.grantId, reason });
    const file = await this.store.transact(scope.board.boardId, current => {
      const replay = checkedAppliedRequest(current, scope.authorization, 'acl_admin', payloadHash);
      if (replay) return current;
      const target = current.grants.find(grant => grant.grantId === input.grantId);
      if (!target) throw new TaskBoardError('not-found', `unknown task-board grant ${input.grantId}`);
      if (!target.active) throw new TaskBoardError('conflict', `task-board grant ${input.grantId} is already revoked`);
      if (target.role === 'top_agent')
        throw new TaskBoardError('forbidden', 'replace the top-agent before revoking it');
      const boardEpoch = current.boardEpoch + 1;
      const grants = current.grants.map(grant =>
        grant.grantId === target.grantId
          ? {
              ...grant,
              active: false,
              revokedAt: now(),
              revokedBySessionId: null,
              revokeReason: reason,
            }
          : grant.active
            ? { ...grant, boardEpoch }
            : grant,
      );
      const applied = appliedRequest(scope.authorization, 'acl_admin', payloadHash, {
        resultGrantId: target.grantId,
        resultBoardEpoch: boardEpoch,
        resultCoordinatorEpoch: current.coordinatorEpoch,
      });
      const refused = refuseOpenEpochIntents(
        {
          ...current,
          boardEpoch,
          grants,
          appliedRequests: appendTaskBoardAppliedRequest(current.appliedRequests, applied),
        },
        scope.authorization,
        'acl_admin',
        payloadHash,
        'board epoch advanced when a grant was revoked',
      );
      return appendAudit(refused.file, scope.authorization, 'grant.revoked', 'acl_admin', payloadHash, 'applied', {
        grantId: target.grantId,
        reason,
        refusedGrantRequestIds: refused.grantRequestIds,
        refusedInvitationRequestIds: refused.invitationRequestIds,
      });
    });
    await this.refreshActiveBindings(file);
    return file;
  }

  async reconcilePendingBindings(): Promise<void> {
    for (const boardId of await this.store.listBoardIds()) {
      let file = await this.store.require(boardId);
      for (const snapshot of [...file.appliedRequests]) {
        if (!snapshot.pendingCapability || !snapshot.resultGrantId || !snapshot.resultSessionId) continue;
        await this.withBindingLocks([snapshot.resultSessionId], async () => {
          await this.store.transact(boardId, async current => {
            const applied = current.appliedRequests.find(candidate => candidate.requestId === snapshot.requestId);
            if (!applied?.pendingCapability || !applied.resultGrantId || !applied.resultSessionId) return current;
            const capability = applied.pendingCapability;
            const grant = current.grants.find(candidate => candidate.grantId === applied.resultGrantId);
            if (
              applied.action !== 'acl_admin' ||
              !grant ||
              !grant.active ||
              grant.sessionId !== applied.resultSessionId ||
              grant.boardEpoch !== current.boardEpoch ||
              grant.coordinatorEpoch !== current.coordinatorEpoch ||
              hashTaskBoardSecret(capability) !== grant.capabilityHash
            ) {
              throw new TaskBoardError('invalid', `pending binding ${applied.requestId} has an invalid crash bridge`);
            }
            const identity = await this.identity(grant.sessionId);
            const lineage = await this.lineage(identity.id);
            const binding = await this.store.readBinding(identity.id);
            if (
              identity.incarnation !== grant.sessionIncarnation ||
              identity.runtimeGeneration !== grant.runtimeGeneration ||
              !grantLineageMatches(grant, identity, lineage) ||
              (binding !== null && !bindingMatchesGrant(binding, current, grant))
            ) {
              throw new TaskBoardError('invalid', `pending binding ${applied.requestId} target changed before binding`);
            }
            if (binding === null) await this.store.writeBinding(bindingFor(current, grant, capability));
            const payloadHash = hashTaskBoardPayload({
              operation: 'reconcile_binding',
              requestId: applied.requestId,
              grantId: grant.grantId,
              sessionId: grant.sessionId,
            });
            return appendAudit(
              {
                ...current,
                appliedRequests: current.appliedRequests.map(request =>
                  request.requestId === applied.requestId && request.pendingCapability === capability
                    ? { ...request, pendingCapability: undefined }
                    : request,
                ),
              },
              daemonAuthorization(current, `reconcile-binding:${applied.requestId}`),
              'binding.reconciled',
              'reconcile',
              payloadHash,
              'applied',
              { grantId: grant.grantId, sessionId: grant.sessionId },
            );
          });
        });
        file = await this.store.require(boardId);
      }
      for (const snapshot of [...file.grantRequests]) {
        if (snapshot.status !== 'approved' || !snapshot.grantId || !snapshot.pendingCapability) continue;
        let refused = false;
        const reconciled = await this.withBindingLocks(
          [snapshot.targetSessionId],
          async () =>
            await this.store.transact(boardId, async current => {
              const request = current.grantRequests.find(candidate => candidate.requestId === snapshot.requestId);
              if (request?.status !== 'approved' || !request.grantId || !request.pendingCapability) return current;
              const grant = current.grants.find(candidate => candidate.grantId === request.grantId);
              if (!grant || !grant.active || hashTaskBoardSecret(request.pendingCapability) !== grant.capabilityHash) {
                throw new TaskBoardError(
                  'invalid',
                  `approved grant request ${request.requestId} has invalid crash bridge`,
                );
              }
              const identity = await this.identity(grant.sessionId);
              const targetLineage = await this.lineage(identity.id);
              const targetBinding = await this.store.readBinding(identity.id);
              const invalidTarget =
                identity.id !== request.targetSessionId ||
                identity.incarnation !== request.targetSessionIncarnation ||
                identity.runtimeGeneration !== request.targetRuntimeGeneration ||
                identity.parent !== request.targetParentSessionId ||
                !sameStrings(targetLineage, request.parentLineage) ||
                grant.sessionId !== request.targetSessionId ||
                grant.sessionIncarnation !== request.targetSessionIncarnation ||
                grant.runtimeGeneration !== request.targetRuntimeGeneration ||
                grant.parentSessionId !== request.targetParentSessionId ||
                grant.role !== request.requestedRole ||
                !sameActions(grant.allowedActions, taskBoardActionsForRole(request.requestedRole)) ||
                grant.interactiveSourceSessionId !== request.interactiveSourceSessionId;
              if (invalidTarget || (targetBinding !== null && !bindingMatchesGrant(targetBinding, current, grant))) {
                refused = true;
                return this.refusedPendingBindingFile(
                  current,
                  request.requestId,
                  grant.grantId,
                  invalidTarget ? 'target identity or lineage changed' : 'target acquired another binding',
                );
              }
              if (targetBinding === null) {
                await this.store.writeBinding(bindingFor(current, grant, request.pendingCapability));
              }
              return {
                ...current,
                grantRequests: current.grantRequests.map(candidate =>
                  candidate.requestId === request.requestId && candidate.pendingCapability === request.pendingCapability
                    ? { ...candidate, pendingCapability: undefined }
                    : candidate,
                ),
              };
            }),
        );
        if (refused) await this.refreshActiveBindings(reconciled);
        file = await this.store.require(boardId);
      }
      for (const snapshot of [...file.invitations]) {
        if (snapshot.status !== 'accepted' || !snapshot.grantId || !snapshot.pendingBoardCapability) continue;
        await this.withBindingLocks([snapshot.targetSessionId], async () => {
          await this.store.transact(boardId, async current => {
            const invitation = current.invitations.find(candidate => candidate.requestId === snapshot.requestId);
            if (invitation?.status !== 'accepted' || !invitation.grantId || !invitation.pendingBoardCapability) {
              return current;
            }
            const grant = current.grants.find(candidate => candidate.grantId === invitation.grantId);
            const capability = invitation.pendingBoardCapability;
            if (
              !grant ||
              !grant.active ||
              grant.role !== 'top_agent' ||
              grant.sessionId !== invitation.targetSessionId ||
              grant.membershipRootSessionId !== invitation.targetSessionId ||
              hashTaskBoardSecret(capability) !== grant.capabilityHash
            ) {
              throw new TaskBoardError(
                'invalid',
                `accepted invitation ${invitation.requestId} has an invalid crash bridge`,
              );
            }
            const identity = await this.identity(grant.sessionId);
            const lineage = await this.lineage(identity.id);
            const binding = await this.store.readBinding(identity.id);
            if (
              !identity.live ||
              identity.mode !== 'interactive' ||
              identity.incarnation !== grant.sessionIncarnation ||
              identity.runtimeGeneration !== grant.runtimeGeneration ||
              !grantLineageMatches(grant, identity, lineage) ||
              (binding !== null && !bindingMatchesGrant(binding, current, grant))
            ) {
              throw new TaskBoardError(
                'invalid',
                `accepted invitation ${invitation.requestId} target changed before binding`,
              );
            }
            if (binding === null) await this.store.writeBinding(bindingFor(current, grant, capability));
            const payloadHash = hashTaskBoardPayload({
              operation: 'reconcile_invitation_binding',
              invitationRequestId: invitation.requestId,
              grantId: grant.grantId,
              sessionId: grant.sessionId,
            });
            return appendAudit(
              {
                ...current,
                invitations: current.invitations.map(candidate =>
                  candidate.requestId === invitation.requestId && candidate.pendingBoardCapability === capability
                    ? { ...candidate, pendingBoardCapability: undefined }
                    : candidate,
                ),
              },
              daemonAuthorization(current, `reconcile-invitation-binding:${invitation.requestId}`),
              'binding.reconciled',
              'reconcile',
              payloadHash,
              'applied',
              { invitationRequestId: invitation.requestId, grantId: grant.grantId, sessionId: grant.sessionId },
            );
          });
        });
        file = await this.store.require(boardId);
      }
      // Repair safe central->binding drift (runtime generation/permission
      // reductions). A privilege increase is still fenced until this atomic
      // binding replacement lands.
      for (const snapshot of file.grants.filter(candidate => candidate.active)) {
        await this.withBindingLocks([snapshot.sessionId], async () => {
          const current = await this.store.require(boardId);
          const grant = current.grants.find(candidate => candidate.grantId === snapshot.grantId);
          if (!grant?.active || grant.sessionId !== snapshot.sessionId) return;
          const identity = await this.identity(grant.sessionId);
          const lineage = await this.lineage(identity.id);
          const binding = await this.store.readBinding(grant.sessionId);
          if (
            identity.incarnation !== grant.sessionIncarnation ||
            identity.runtimeGeneration !== grant.runtimeGeneration ||
            !grantLineageMatches(grant, identity, lineage) ||
            !binding ||
            hashTaskBoardSecret(binding.capability) !== grant.capabilityHash
          ) {
            return;
          }
          if (
            binding.runtimeGeneration !== grant.runtimeGeneration ||
            binding.role !== grant.role ||
            !sameActions(binding.allowedActions, grant.allowedActions) ||
            binding.boardEpoch !== current.boardEpoch ||
            binding.coordinatorEpoch !== current.coordinatorEpoch
          ) {
            await this.store.writeBinding(bindingFor(current, grant, binding.capability));
          }
        });
      }
    }
  }

  private async refusePendingBinding(
    boardId: string,
    grantRequestId: string,
    grantId: string,
    reason: string,
  ): Promise<TaskBoardFile> {
    return this.store.transact(boardId, current =>
      this.refusedPendingBindingFile(current, grantRequestId, grantId, reason),
    );
  }

  private refusedPendingBindingFile(
    current: TaskBoardFile,
    grantRequestId: string,
    grantId: string,
    reason: string,
  ): TaskBoardFile {
    const request = current.grantRequests.find(candidate => candidate.requestId === grantRequestId);
    const grant = current.grants.find(candidate => candidate.grantId === grantId);
    if (!request?.pendingCapability || !grant?.active) return current;
    const boardEpoch = current.boardEpoch + 1;
    const payloadHash = hashTaskBoardPayload({ operation: 'refuse_pending_binding', grantRequestId, grantId, reason });
    const authorization = daemonAuthorization(current, `reconcile-pending-binding:${grantRequestId}`);
    const next: TaskBoardFile = {
      ...current,
      boardEpoch,
      grants: current.grants.map(candidate =>
        candidate.grantId === grantId
          ? { ...candidate, active: false, revokedAt: now(), revokeReason: reason }
          : candidate.active
            ? { ...candidate, boardEpoch }
            : candidate,
      ),
      grantRequests: current.grantRequests.map(candidate =>
        candidate.requestId === grantRequestId
          ? { ...candidate, status: 'refused', pendingCapability: undefined, refusalReason: reason }
          : candidate,
      ),
    };
    const refused = refuseOpenEpochIntents(
      next,
      authorization,
      'reconcile',
      payloadHash,
      'board epoch advanced when an invalid pending binding was refused',
    );
    return appendAudit(refused.file, authorization, 'grant.revoked', 'reconcile', payloadHash, 'applied', {
      grantRequestId,
      grantId,
      reason,
      automatic: true,
      refusedGrantRequestIds: refused.grantRequestIds,
      refusedInvitationRequestIds: refused.invitationRequestIds,
    });
  }

  private async requireCurrentGrantState(
    file: TaskBoardFile,
    grantId: string,
    action: TaskBoardAction,
  ): Promise<CurrentGrantState> {
    const grant = file.grants.find(candidate => candidate.grantId === grantId);
    if (!grant || !grant.active)
      throw new TaskBoardError('forbidden', `task-board grant ${grantId} is absent or revoked`);
    if (
      grant.boardEpoch !== file.boardEpoch ||
      grant.coordinatorEpoch !== file.coordinatorEpoch ||
      grant.coordinatorSessionId !== file.coordinatorSessionId
    ) {
      throw new TaskBoardError('stale-epoch', `task-board grant ${grantId} is not current`);
    }
    if (!grant.allowedActions.includes(action)) {
      throw new TaskBoardError('forbidden', `task-board grant ${grantId} is not allowed to ${action}`);
    }
    const binding = await this.store.readBinding(grant.sessionId);
    const identity = await this.identity(grant.sessionId);
    if (
      !binding ||
      binding.boardId !== file.boardId ||
      binding.grantId !== grant.grantId ||
      binding.sessionIncarnation !== grant.sessionIncarnation ||
      binding.runtimeGeneration !== grant.runtimeGeneration ||
      binding.role !== grant.role ||
      !sameActions(binding.allowedActions, grant.allowedActions) ||
      binding.boardEpoch !== file.boardEpoch ||
      binding.coordinatorEpoch !== file.coordinatorEpoch ||
      hashTaskBoardSecret(binding.capability) !== grant.capabilityHash
    ) {
      throw new TaskBoardError('forbidden', `task-board binding for grant ${grantId} is not current`);
    }
    if (
      identity.id !== grant.sessionId ||
      identity.incarnation !== grant.sessionIncarnation ||
      identity.runtimeGeneration !== grant.runtimeGeneration
    ) {
      throw new TaskBoardError(
        'stale-generation',
        `task-board grant ${grantId} belongs to a fenced session generation`,
      );
    }
    return { grant, binding, identity, lineage: await this.lineage(identity.id) };
  }

  private async requireCurrentAuthorization(
    file: TaskBoardFile,
    authorization: TaskBoardAuthorization,
    action: TaskBoardAction,
    role: TaskBoardRole,
  ): Promise<CurrentGrantState> {
    if (
      authorization.boardId !== file.boardId ||
      authorization.boardEpoch !== file.boardEpoch ||
      authorization.coordinatorEpoch !== file.coordinatorEpoch
    ) {
      throw new TaskBoardError('stale-epoch', 'task-board authorization changed before the serialized grant write');
    }
    const current = await this.requireCurrentGrantState(file, authorization.grantId, action);
    if (
      current.grant.role !== role ||
      authorization.role !== role ||
      authorization.actorSessionId !== current.grant.sessionId ||
      authorization.runtimeGeneration !== current.grant.runtimeGeneration ||
      authorization.capabilityId !== current.grant.grantId ||
      authorization.capabilityHash !== current.grant.capabilityHash ||
      !sameActions(authorization.allowedActions, current.grant.allowedActions)
    ) {
      throw new TaskBoardError('forbidden', 'authenticated grant changed before the serialized grant write');
    }
    return current;
  }

  private async requireSingleCoordinator(file: TaskBoardFile): Promise<CurrentGrantState> {
    const matches = file.grants.filter(
      candidate =>
        candidate.active && candidate.role === 'coordinator' && candidate.sessionId === file.coordinatorSessionId,
    );
    if (matches.length !== 1) {
      throw new TaskBoardError('unavailable', 'there is no single active current coordinator grant');
    }
    const current = await this.requireCurrentGrantState(file, matches[0]!.grantId, 'grant_approve');
    if (
      !current.identity.live ||
      current.identity.id !== file.coordinatorSessionId ||
      !sameActions(current.grant.allowedActions, TASK_BOARD_CURRENT_COORDINATOR_ACTIONS)
    ) {
      throw new TaskBoardError('unavailable', 'the single current coordinator is unavailable or not exact');
    }
    return current;
  }

  private assertAction(
    authorization: TaskBoardAuthorization,
    action: TaskBoardAction,
    assignedSessionId: string | null | undefined,
  ): void {
    if (!authorization.allowedActions.includes(action)) {
      throw new TaskBoardError('forbidden', `${authorization.role} is not allowed to ${action} on this task board`);
    }
    if (authorization.role === 'worker' && assignedSessionId !== undefined) {
      if (assignedSessionId !== authorization.actorSessionId) {
        throw new TaskBoardError(
          'forbidden',
          'worker edits are limited to tasks assigned to that exact worker session',
        );
      }
    }
  }

  private async identity(ref: string): Promise<SessionIdentity> {
    const view = await this.sessions.get(ref).catch(() => undefined);
    if (!view) throw new TaskBoardError('not-found', `no session resolves from ${ref}`);
    const config = view.config;
    const runtimeGeneration = config.runtimeGeneration ?? 1;
    if (!Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 1) {
      throw new TaskBoardError('invalid', `session ${config.id} has an invalid runtime generation`);
    }
    return {
      id: config.id,
      incarnation: config.incarnation ?? legacyTaskBoardSessionIncarnation(config.id, config.createdAt),
      runtimeGeneration,
      name: config.teammate?.trim() || config.name?.trim() || null,
      parent: config.parent ?? null,
      mode: config.mode,
      live: !TERMINAL_SESSION_STATUSES.has(view.state.status),
    };
  }

  private async lineage(sessionId: string): Promise<string[]> {
    const lineage: string[] = [];
    const seen = new Set<string>();
    let current: string | null = sessionId;
    while (current !== null) {
      if (seen.has(current)) throw new TaskBoardError('invalid', `session lineage cycle at ${current}`);
      seen.add(current);
      const identity = await this.identity(current);
      lineage.push(identity.id);
      current = identity.parent;
    }
    return lineage;
  }

  private async clearPendingCapability(boardId: string, requestId: string, capability: string): Promise<void> {
    await this.store.transact(boardId, current => ({
      ...current,
      grantRequests: current.grantRequests.map(request =>
        request.requestId === requestId && request.pendingCapability === capability
          ? { ...request, pendingCapability: undefined }
          : request,
      ),
    }));
  }

  private async clearPendingInvitationCapability(
    boardId: string,
    requestId: string,
    capability: string,
  ): Promise<void> {
    if (!capability) return;
    await this.store.transact(boardId, current => ({
      ...current,
      invitations: current.invitations.map(invitation =>
        invitation.requestId === requestId && invitation.pendingBoardCapability === capability
          ? { ...invitation, pendingBoardCapability: undefined }
          : invitation,
      ),
    }));
  }

  private async clearPendingAppliedCapability(boardId: string, requestId: string, capability: string): Promise<void> {
    await this.store.transact(boardId, current => ({
      ...current,
      appliedRequests: current.appliedRequests.map(request =>
        request.requestId === requestId && request.pendingCapability === capability
          ? { ...request, pendingCapability: undefined }
          : request,
      ),
    }));
  }

  private async refreshActiveBindings(file: TaskBoardFile): Promise<void> {
    for (const original of file.grants.filter(candidate => candidate.active)) {
      await this.withBindingLocks([original.sessionId], async () => {
        const current = await this.store.require(file.boardId);
        const grant = current.grants.find(candidate => candidate.grantId === original.grantId);
        if (!grant?.active) return;
        const binding = await this.store.readBinding(grant.sessionId);
        if (!binding || hashTaskBoardSecret(binding.capability) !== grant.capabilityHash) {
          throw new TaskBoardError('unavailable', `cannot refresh binding for active grant ${grant.grantId}`);
        }
        await this.store.writeBinding(bindingFor(current, grant, binding.capability));
      });
    }
  }

  private async withBindingLocks<T>(sessionIds: readonly string[], run: () => Promise<T>): Promise<T> {
    const ids = [...new Set(sessionIds)].sort();
    const acquire = async (index: number): Promise<T> => {
      const sessionId = ids[index];
      return sessionId === undefined
        ? await run()
        : await this.bindingQueue.run(sessionId, async () => await acquire(index + 1));
    };
    return await acquire(0);
  }
}

function cleanRequestId(value: unknown, action: TaskBoardAction): string {
  const requestId = typeof value === 'string' ? value.trim() : '';
  if (requestId) return requestId;
  if (action === 'read') return `read-${crypto.randomUUID()}`;
  throw new TaskBoardError('invalid', `board mutation ${action} requires a request id`);
}

function sameActions(left: readonly TaskBoardAction[], right: readonly TaskBoardAction[]): boolean {
  return left.length === right.length && left.every(action => right.includes(action));
}

function grantLineageMatches(grant: TaskBoardGrant, identity: SessionIdentity, lineage: readonly string[]): boolean {
  if (identity.id !== grant.sessionId) return false;
  if (grant.membershipRootSessionId === grant.sessionId) {
    return (
      grant.role === 'top_agent' &&
      grant.parentSessionId === null &&
      identity.parent === null &&
      lineage.length === 1 &&
      lineage[0] === identity.id
    );
  }
  return (
    identity.parent === grant.parentSessionId &&
    lineage.includes(grant.membershipRootSessionId) &&
    lineage.slice(1).includes(grant.interactiveSourceSessionId)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameGrantRequest(left: TaskBoardGrantRequest, right: TaskBoardGrantRequest): boolean {
  return (
    left.payloadHash === right.payloadHash &&
    left.boardId === right.boardId &&
    left.boardEpoch === right.boardEpoch &&
    left.sourceGrantId === right.sourceGrantId &&
    left.interactiveSourceSessionId === right.interactiveSourceSessionId &&
    left.interactiveSourceIncarnation === right.interactiveSourceIncarnation &&
    left.interactiveSourceRuntimeGeneration === right.interactiveSourceRuntimeGeneration &&
    left.targetSessionId === right.targetSessionId &&
    left.targetSessionIncarnation === right.targetSessionIncarnation &&
    left.targetRuntimeGeneration === right.targetRuntimeGeneration &&
    left.targetParentSessionId === right.targetParentSessionId &&
    left.requestedRole === right.requestedRole &&
    left.coordinatorGrantId === right.coordinatorGrantId &&
    left.coordinatorSessionId === right.coordinatorSessionId &&
    left.coordinatorSessionIncarnation === right.coordinatorSessionIncarnation &&
    left.coordinatorRuntimeGeneration === right.coordinatorRuntimeGeneration &&
    left.coordinatorEpoch === right.coordinatorEpoch &&
    sameStrings(left.parentLineage, right.parentLineage) &&
    sameStrings(left.coordinatorLineage, right.coordinatorLineage) &&
    sameActions(left.allowedActions, right.allowedActions)
  );
}

function sameInvitation(left: TaskBoardInvitation, right: TaskBoardInvitation): boolean {
  return (
    left.payloadHash === right.payloadHash &&
    left.boardId === right.boardId &&
    left.boardEpoch === right.boardEpoch &&
    left.sourceGrantId === right.sourceGrantId &&
    left.sourceSessionId === right.sourceSessionId &&
    left.sourceSessionIncarnation === right.sourceSessionIncarnation &&
    left.sourceRuntimeGeneration === right.sourceRuntimeGeneration &&
    left.targetSessionId === right.targetSessionId &&
    left.targetSessionIncarnation === right.targetSessionIncarnation &&
    left.targetRuntimeGeneration === right.targetRuntimeGeneration &&
    left.coordinatorGrantId === right.coordinatorGrantId &&
    left.coordinatorSessionId === right.coordinatorSessionId &&
    left.coordinatorSessionIncarnation === right.coordinatorSessionIncarnation &&
    left.coordinatorRuntimeGeneration === right.coordinatorRuntimeGeneration &&
    left.coordinatorEpoch === right.coordinatorEpoch
  );
}

function sameCoordinatorRequestIdentity(request: TaskBoardGrantRequest, coordinator: CurrentGrantState): boolean {
  return (
    request.coordinatorGrantId === coordinator.grant.grantId &&
    request.coordinatorSessionId === coordinator.identity.id &&
    request.coordinatorSessionIncarnation === coordinator.identity.incarnation &&
    request.coordinatorRuntimeGeneration === coordinator.identity.runtimeGeneration &&
    request.coordinatorEpoch === coordinator.grant.coordinatorEpoch &&
    sameStrings(request.coordinatorLineage, coordinator.lineage)
  );
}

function sameCoordinatorInvitationIdentity(invitation: TaskBoardInvitation, coordinator: CurrentGrantState): boolean {
  return (
    invitation.coordinatorGrantId === coordinator.grant.grantId &&
    invitation.coordinatorSessionId === coordinator.identity.id &&
    invitation.coordinatorSessionIncarnation === coordinator.identity.incarnation &&
    invitation.coordinatorRuntimeGeneration === coordinator.identity.runtimeGeneration &&
    invitation.coordinatorEpoch === coordinator.grant.coordinatorEpoch
  );
}

function bindingMatchesGrant(binding: TaskBoardBinding, file: TaskBoardFile, grant: TaskBoardGrant): boolean {
  return (
    binding.boardId === file.boardId &&
    binding.grantId === grant.grantId &&
    binding.sessionId === grant.sessionId &&
    binding.sessionIncarnation === grant.sessionIncarnation &&
    binding.runtimeGeneration === grant.runtimeGeneration &&
    binding.role === grant.role &&
    sameActions(binding.allowedActions, grant.allowedActions) &&
    binding.boardEpoch === file.boardEpoch &&
    binding.coordinatorEpoch === file.coordinatorEpoch &&
    hashTaskBoardSecret(binding.capability) === grant.capabilityHash
  );
}

function daemonAuthorization(file: TaskBoardFile, requestId: string): TaskBoardAuthorization {
  return {
    boardId: file.boardId,
    grantId: 'daemon',
    actorSessionId: null,
    actorName: 'daemon',
    role: 'daemon',
    allowedActions: [...daemonReconcilerActions],
    boardEpoch: file.boardEpoch,
    coordinatorEpoch: file.coordinatorEpoch,
    runtimeGeneration: null,
    capabilityId: 'daemon-internal-reconciler',
    requestId,
  };
}

function appliedRequest(
  authorization: TaskBoardAuthorization,
  action: TaskBoardAction,
  payloadHash: string,
  result: Pick<
    TaskBoardAppliedRequest,
    | 'taskId'
    | 'resultGrantId'
    | 'resultSessionId'
    | 'grantRequestId'
    | 'resultBoardEpoch'
    | 'resultCoordinatorEpoch'
    | 'pendingCapability'
  > = {},
): TaskBoardAppliedRequest {
  return {
    requestId: authorization.requestId,
    payloadHash,
    action,
    actorSessionId: authorization.actorSessionId,
    role: authorization.role,
    grantId: authorization.grantId,
    capabilityId: authorization.capabilityId,
    boardEpoch: authorization.boardEpoch,
    coordinatorEpoch: authorization.coordinatorEpoch,
    runtimeGeneration: authorization.runtimeGeneration,
    appliedAt: now(),
    ...result,
  };
}

function checkedAppliedRequest(
  file: TaskBoardFile,
  authorization: TaskBoardAuthorization,
  action: TaskBoardAction,
  payloadHash: string,
): TaskBoardAppliedRequest | null {
  const existing = file.appliedRequests.find(request => request.requestId === authorization.requestId);
  if (!existing) return null;
  const matchesOriginGeneration =
    existing.boardEpoch === authorization.boardEpoch &&
    existing.coordinatorEpoch === authorization.coordinatorEpoch &&
    existing.runtimeGeneration === authorization.runtimeGeneration;
  const hasResultGeneration = existing.resultBoardEpoch !== undefined;
  const matchesResultGeneration =
    hasResultGeneration &&
    (existing.resultBoardEpoch ?? existing.boardEpoch) === authorization.boardEpoch &&
    (existing.resultCoordinatorEpoch ?? existing.coordinatorEpoch) === authorization.coordinatorEpoch &&
    existing.runtimeGeneration === authorization.runtimeGeneration;
  if (
    existing.payloadHash !== payloadHash ||
    existing.action !== action ||
    existing.actorSessionId !== authorization.actorSessionId ||
    existing.role !== authorization.role ||
    existing.grantId !== authorization.grantId ||
    existing.capabilityId !== authorization.capabilityId ||
    (!matchesOriginGeneration && !matchesResultGeneration)
  ) {
    throw new TaskBoardError(
      'conflict',
      `request id ${authorization.requestId} belongs to another authorization generation`,
    );
  }
  return existing;
}

/** Any epoch bump fences open intents captured under the previous generation.
 * Persist the terminal refusal and one truthful audit row per intent so stale
 * approvals neither block later work nor disappear as an implicit side effect. */
function refuseOpenEpochIntents(
  file: TaskBoardFile,
  authorization: TaskBoardAuthorization,
  action: TaskBoardAction,
  triggerPayloadHash: string,
  reason: string,
  options: { excludeInvitationRequestId?: string } = {},
): { file: TaskBoardFile; grantRequestIds: string[]; invitationRequestIds: string[] } {
  const grantRequestIds = file.grantRequests
    .filter(request => request.status === 'pending')
    .map(request => request.requestId);
  const invitationRequestIds = file.invitations
    .filter(
      invitation =>
        invitation.requestId !== options.excludeInvitationRequestId &&
        (invitation.status === 'pending' || invitation.status === 'approved'),
    )
    .map(invitation => invitation.requestId);
  const grantSet = new Set(grantRequestIds);
  const invitationSet = new Set(invitationRequestIds);
  let next: TaskBoardFile = {
    ...file,
    grantRequests: file.grantRequests.map(request =>
      grantSet.has(request.requestId) ? { ...request, status: 'refused', refusalReason: reason } : request,
    ),
    invitations: file.invitations.map(invitation =>
      invitationSet.has(invitation.requestId)
        ? {
            ...invitation,
            status: 'refused',
            refusalReason: reason,
            acceptanceCapabilityHash: undefined,
            pendingAcceptanceCapability: undefined,
          }
        : invitation,
    ),
  };
  for (const grantRequestId of grantRequestIds) {
    next = appendAudit(
      next,
      authorization,
      'grant.refused',
      action,
      hashTaskBoardPayload({
        operation: 'automatic_epoch_refusal',
        kind: 'grant_request',
        triggerPayloadHash,
        grantRequestId,
        reason,
      }),
      'applied',
      { grantRequestId, reason, automatic: true, triggerRequestId: authorization.requestId },
    );
  }
  for (const invitationRequestId of invitationRequestIds) {
    next = appendAudit(
      next,
      authorization,
      'invitation.refused',
      action,
      hashTaskBoardPayload({
        operation: 'automatic_epoch_refusal',
        kind: 'invitation',
        triggerPayloadHash,
        invitationRequestId,
        reason,
      }),
      'applied',
      { invitationRequestId, reason, automatic: true, triggerRequestId: authorization.requestId },
    );
  }
  return { file: next, grantRequestIds, invitationRequestIds };
}

function appendAudit(
  file: TaskBoardFile,
  authorization: TaskBoardAuthorization,
  event: TaskBoardAuditRecord['event'],
  action: TaskBoardAction,
  payloadHash: string,
  outcome: TaskBoardAuditRecord['outcome'],
  detail: Record<string, unknown>,
): TaskBoardFile {
  const audit: TaskBoardAuditRecord = {
    seq: (file.audit.at(-1)?.seq ?? 0) + 1,
    time: now(),
    event,
    actorSessionId: authorization.actorSessionId,
    actorName: authorization.actorName,
    role: authorization.role,
    boardEpoch: file.boardEpoch,
    coordinatorEpoch: file.coordinatorEpoch,
    runtimeGeneration: authorization.runtimeGeneration,
    action,
    capabilityId: authorization.capabilityId,
    requestId: authorization.requestId,
    payloadHash,
    outcome,
    detail,
  };
  return { ...file, audit: [...file.audit, audit], updatedAt: now() };
}

function initialGrant(input: {
  grantId: string;
  capability: string;
  identity: SessionIdentity;
  role: 'top_agent' | 'coordinator';
  allowedActions: TaskBoardAction[];
  parentSessionId: string | null;
  interactiveSourceSessionId: string;
  coordinatorSessionId: string;
  membershipRootSessionId: string;
}): TaskBoardGrant {
  return {
    grantId: input.grantId,
    capabilityHash: hashTaskBoardSecret(input.capability),
    sessionId: input.identity.id,
    sessionIncarnation: input.identity.incarnation,
    runtimeGeneration: input.identity.runtimeGeneration,
    role: input.role,
    allowedActions: [...input.allowedActions],
    parentSessionId: input.parentSessionId,
    interactiveSourceSessionId: input.interactiveSourceSessionId,
    coordinatorSessionId: input.coordinatorSessionId,
    membershipRootSessionId: input.membershipRootSessionId,
    boardEpoch: 1,
    coordinatorEpoch: 1,
    grantedAt: now(),
    grantedBySessionId: null,
    active: true,
  };
}

function bindingFor(file: TaskBoardFile, grant: TaskBoardGrant, capability: string): TaskBoardBinding {
  const at = now();
  return {
    v: TASK_BOARD_BINDING_VERSION,
    sessionId: grant.sessionId,
    sessionIncarnation: grant.sessionIncarnation,
    runtimeGeneration: grant.runtimeGeneration,
    boardId: file.boardId,
    grantId: grant.grantId,
    capability,
    role: grant.role,
    allowedActions: [...grant.allowedActions],
    boardEpoch: file.boardEpoch,
    coordinatorEpoch: file.coordinatorEpoch,
    boundAt: at,
    updatedAt: at,
  };
}

export function exactWorkerAssignee(task: Task, sessions: readonly TaskBoardSessionView[]): string | null {
  if (!task.assignee) return null;
  const direct = sessions.find(view => view.config.id === task.assignee);
  if (direct) return direct.config.id;
  const byName = sessions.filter(
    view => view.config.teammate === task.assignee || (!view.config.teammate && view.config.name === task.assignee),
  );
  return byName.length === 1 ? byName[0]!.config.id : null;
}

export type { StoredSessionTask };
