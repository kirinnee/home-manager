// Source adapter for the four durable attention classes. It listens to the
// existing session/task streams and calls AttentionService; it never presents an
// OS notification. Question/permission notifications continue through the
// canonical session-status path (see notification-policy.ts).

import type { SessionView } from './service';
import type { KTeamEvent, PendingQuestion } from './types';
import type { ScopedTaskSummary, SessionTaskListResponse, TaskActivity, TaskWorkflow } from './tasks-types';
import { isValidShippedReopenActivity } from './session-tasks-store';
import type { AddAttentionInput, AttentionService } from './attention-service';
import {
  TASK_REOPENED_ATTENTION_SOURCE_REF_PREFIX,
  type AttentionActor,
  type AttentionSnapshot,
} from './attention-types';
import type { WardenAnomaly } from './warden-detect';
import { parseWardenAnomalyKind, wardenVerdictSourceRef } from './warden-verdicts';

export interface AttentionSessionSource {
  list(): Promise<SessionView[]>;
  get(sessionId: string): Promise<SessionView>;
  subscribe(listener: (event: KTeamEvent) => void): () => void;
  /** Lightweight durable anomaly snapshot; unlike full wardenStatus this does
   *  not refresh account usage during daemon bootstrap. */
  wardenAnomalies?(): Promise<WardenAnomaly[]>;
}

export interface AttentionTaskSource {
  sessionTaskList(sessionId: string): Promise<SessionTaskListResponse>;
  /** One bounded read of the per-session task file. Optional for compatibility
   *  with narrow test/read adapters; TaskService supplies it in the daemon so
   *  startup can recover a reopen committed just before event delivery. */
  sessionTaskActivityBaselines?(sessionId: string): Promise<{
    tasks: Array<{
      id: string;
      workflow: TaskWorkflow;
      reopenAckSeq: number;
      activity: readonly TaskActivity[];
      activityParseErrors: number;
    }>;
    parseErrors: number;
  }>;
  acknowledgeReopen?(sessionId: string, taskId: string, seq: number, actor: AttentionActor): Promise<void>;
  subscribe(listener: (event: KTeamEvent) => void): () => void;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function eventActor(event: KTeamEvent): AttentionActor {
  if (event.source.startsWith('peer:')) return { actor: event.source.slice('peer:'.length) };
  if (event.source.startsWith('warden:')) return { actor: event.source.slice('warden:'.length) };
  if (event.source === 'client' || event.source === 'admin-cli' || event.source === 'admin-ui') {
    return { actor: 'user' };
  }
  return { actor: 'daemon' };
}

interface TaskAttentionState {
  needsHuman: boolean;
  reason: string;
  since: string;
}

/** Task v2 keeps workflow phase separate from derived blocking. A task blocked
 * only by other tasks does not itself ask the human for attention; the
 * dependency task owns any request. The legacy status fallback keeps this
 * adapter compatible while Task v2 rolls through the shared tree. */
function taskAttentionState(task: ScopedTaskSummary): TaskAttentionState {
  const raw = task as unknown as Record<string, unknown>;
  if (typeof raw['blocked'] === 'boolean') {
    const blockedBy = Array.isArray(raw['blockedBy']) ? raw['blockedBy'] : [];
    const blockedReason =
      typeof raw['blockedReason'] === 'string' && raw['blockedReason'].trim()
        ? raw['blockedReason']
        : 'This task is blocked on a human decision or input.';
    const blockedSince =
      typeof raw['blockedSince'] === 'string' && Number.isFinite(Date.parse(raw['blockedSince']))
        ? raw['blockedSince']
        : task.updatedAt;
    return { needsHuman: raw['blocked'] && blockedBy.length === 0, reason: blockedReason, since: blockedSince };
  }
  const statusReason =
    typeof raw['statusReason'] === 'string' && raw['statusReason'].trim()
      ? raw['statusReason']
      : 'This task is blocked on a human decision or input.';
  return { needsHuman: raw['status'] === 'blocked', reason: statusReason, since: task.updatedAt };
}

function taskInput(task: ScopedTaskSummary, state: TaskAttentionState): AddAttentionInput {
  return {
    source: 'task',
    sourceRef: task.id,
    subject: `#${task.id}: ${task.title}`,
    why: state.reason,
    waitingSince: state.since,
    howToResolve: `Resolve the blocking condition for #${task.id}.`,
  };
}

/** A shipped rewind is important but does not block the agent doing the repair,
 * so it is a durable explicit Attention item rather than a derived task blocker.
 * One stable item per task refreshes on repeated unacknowledged reopens; the
 * append-only task activity retains every individual round trip. */
function reopenedTaskInputFrom(raw: Record<string, unknown>, waitingSince: string): AddAttentionInput | null {
  const id = textFrom(raw, ['id']);
  const from = textFrom(raw, ['phaseFrom', 'from']);
  const to = textFrom(raw, ['phaseTo', 'to']);
  const reason = textFrom(raw, ['reason']);
  const sourceSeq = raw['seq'];
  if (
    id === null ||
    (from !== 'live' && from !== 'done') ||
    to === null ||
    reason === null ||
    !Number.isSafeInteger(sourceSeq) ||
    (sourceSeq as number) < 1
  ) {
    return null;
  }
  return {
    source: 'agent-raised',
    sourceRef: `${TASK_REOPENED_ATTENTION_SOURCE_REF_PREFIX}${id}`,
    sourceSeq: sourceSeq as number,
    subject: `#${id}: shipped work reopened from ${from}`,
    why: reason,
    waitingSince,
    howToResolve: `Review #${id}'s reopened ask, then explicitly resolve this item. After the repair returns to live, only the human should move it to done after verification.`,
  };
}

function reopenedTaskInput(event: KTeamEvent): AddAttentionInput | null {
  return reopenedTaskInputFrom(record(event.data), event.time);
}

/** The activity log is the durable side of task.reopened. Recover only the
 * latest valid shipped rewind for a task; an unreadable activity stream is
 * handled by the caller as untrusted rather than replaying stale evidence. */
function latestReopenedTaskInput(
  id: string,
  workflow: TaskWorkflow,
  activity: readonly TaskActivity[],
): AddAttentionInput | null {
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const entry = activity[index]!;
    if (!isValidShippedReopenActivity(workflow, entry)) continue;
    const input = reopenedTaskInputFrom({ ...entry.data, id, seq: entry.seq }, entry.time);
    if (input !== null) return input;
  }
  return null;
}

function questionInput(question: PendingQuestion, waitingSince: string): AddAttentionInput {
  const first = question.questions[0]?.question?.trim();
  return {
    source: 'question',
    sourceRef: question.toolUseId,
    subject: first || 'A session question is waiting',
    why: 'This session cannot continue until the pending question is answered.',
    waitingSince,
    howToResolve: 'Answer or explicitly abandon the pending question in this session.',
  };
}

const refFrom = (raw: Record<string, unknown>): string | null => {
  for (const key of ['toolUseId', 'requestId', 'permissionId']) {
    const value = raw[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
};

const textFrom = (raw: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
};

// UNIMPLEMENTED PRODUCER: the current daemon emits none of these permission
// events. This allowlist is only the receiving contract, covered by synthetic
// tests; permission attention will not appear until a producer is wired. Keep
// it explicit so an unrelated regex-matching event cannot add or clear an item.
const PERMISSION_OPEN_EVENTS = new Set([
  'interaction.permission_requested',
  'interaction.permission_prompted',
  'interaction.permission_awaiting',
]);

const PERMISSION_RESOLVED_EVENTS = new Set([
  'interaction.permission_granted',
  'interaction.permission_denied',
  'interaction.permission_answered',
  'interaction.permission_resolved',
  'interaction.permission_cancelled',
]);

const PROVIDER_ATTENTION_PREFIX = 'provider-unavailable:';

async function forEachConcurrent<T>(
  values: readonly T[],
  limit: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await visit(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
}

/** Coordinates durable sources. Startup baselines create missing records and
 * reconcile explicit task/question actions that happened while kteamd was
 * down. Live explicit actions (task moved out of blocked, question
 * answered/abandoned, permission granted/denied) record a resolver; generic
 * status drift never clears the board. */
export class AttentionSources {
  private readonly blocked = new Map<string, Set<string>>();
  /** Stable provider source-ref → per-session board anchor. */
  private readonly providerAnchors = new Map<string, string>();
  /** Per-session task snapshots must reconcile in event order. File-backed
   *  Attention mutations are async; without this chain, a fast unblock can
   *  inspect the old empty blocker set while the preceding add is still in
   *  flight, then leave that stale add active forever. */
  private readonly taskReconciliations = new Map<string, Promise<void>>();
  private readonly queued: KTeamEvent[] = [];
  private unsubSessions: (() => void) | undefined;
  private unsubTasks: (() => void) | undefined;
  private seeding = false;
  private closed = false;

  constructor(
    private readonly attention: AttentionService,
    private readonly sessions: AttentionSessionSource,
    private readonly tasks: AttentionTaskSource,
    private readonly log: (message: string) => void = message => console.error(message),
  ) {}

  async start(): Promise<void> {
    if (this.unsubSessions || this.unsubTasks) return;
    this.seeding = true;
    const listener = (event: KTeamEvent): void => {
      if (this.closed) return;
      if (this.seeding) this.queued.push(event);
      else this.dispatch(event);
    };
    this.unsubSessions = this.sessions.subscribe(listener);
    this.unsubTasks = this.tasks.subscribe(listener);
    const views = await this.sessions.list().catch(error => {
      this.report('<fleet>', 'startup list', error);
      return [] as SessionView[];
    });
    // Avoid a fleet-sized burst of simultaneous task/file reads at daemon boot.
    await forEachConcurrent(views, 16, view => this.seedSession(view));
    if (this.sessions.wardenAnomalies) {
      const anomalies = await this.sessions.wardenAnomalies().catch(error => {
        this.report('<fleet>', 'provider anomaly baseline', error);
        return [] as WardenAnomaly[];
      });
      await this.applyProviderAnomalies(anomalies);
    }
    this.seeding = false;
    for (const event of this.queued.splice(0)) this.dispatch(event);
  }

  close(): void {
    this.closed = true;
    this.unsubSessions?.();
    this.unsubTasks?.();
    this.unsubSessions = undefined;
    this.unsubTasks = undefined;
  }

  private async seedSession(view: SessionView): Promise<void> {
    const id = view.config.id;
    const persisted = await this.attention.list(id).catch(error => {
      this.report(id, 'startup board read', error);
      return null;
    });
    const canReconcile = persisted !== null && persisted.parseErrors === 0;

    if (canReconcile) {
      for (const item of persisted.items) {
        if (item.source !== 'agent-raised' || !item.sourceRef?.startsWith(PROVIDER_ATTENTION_PREFIX)) continue;
        if (!this.providerAnchors.has(item.sourceRef)) this.providerAnchors.set(item.sourceRef, id);
      }
    }

    // These are explicit actions that may have completed while kteamd was
    // stopped. Reconcile only against a fully parsed board and retain the
    // daemon-stamped audit; generic status drift still never clears anything.
    if (canReconcile) {
      const pendingRef = view.state.pendingQuestion?.toolUseId ?? null;
      for (const item of persisted.items) {
        if (item.source !== 'question' || item.sourceRef === null || item.sourceRef === pendingRef) continue;
        await this.attention
          .resolveFromSource(
            id,
            'question',
            item.sourceRef,
            'Question was no longer pending when the daemon reconciled this session at startup.',
            { actor: 'daemon' },
          )
          .catch(error => this.report(id, 'question startup reconciliation', error));
      }
      this.blocked.set(
        id,
        new Set(
          persisted.items
            .filter(item => item.source === 'task' && item.sourceRef !== null)
            .map(item => item.sourceRef!),
        ),
      );
    }

    if (view.state.pendingQuestion) {
      await this.attention
        .addFromSource(
          id,
          questionInput(view.state.pendingQuestion, view.state.lastActivityAt ?? view.config.updatedAt),
        )
        .catch(error => this.report(id, 'question baseline', error));
    }
    const wardenRequests = [...(view.state.needsHumanRequests ?? [])];
    if (view.state.needsHuman) {
      const legacy = {
        reason: view.state.needsHuman,
        anomalyKind: view.state.needsHumanKind,
        reportPath: view.state.needsHumanReportPath,
        at: view.state.lastActivityAt ?? view.config.updatedAt,
      };
      const legacyRef = wardenVerdictSourceRef(legacy.reportPath, parseWardenAnomalyKind(legacy.anomalyKind));
      if (
        !wardenRequests.some(
          request =>
            wardenVerdictSourceRef(request.reportPath, parseWardenAnomalyKind(request.anomalyKind)) === legacyRef,
        )
      )
        wardenRequests.push(legacy as NonNullable<typeof view.state.needsHumanRequests>[number]);
    }
    for (const request of wardenRequests) {
      await this.attention
        .addFromSource(id, {
          source: 'agent-raised',
          sourceRef: wardenVerdictSourceRef(request.reportPath, parseWardenAnomalyKind(request.anomalyKind)),
          subject: 'A warden requested human attention',
          why: request.reason,
          waitingSince: request.at ?? view.state.lastActivityAt ?? view.config.updatedAt,
          howToResolve: 'Inspect the session and explicitly resolve this attention item after acting.',
        })
        .catch(error => this.report(id, 'warden baseline', error));
    }
    const snapshot = await this.tasks.sessionTaskList(id).catch(() => null);
    if (snapshot) {
      await this.reconcileTaskSnapshot(id, snapshot, { actor: 'daemon' }, canReconcile).catch(error =>
        this.report(id, 'task baseline', error),
      );
      if (canReconcile && snapshot.parseErrors === 0 && persisted !== null) {
        await this.reconcileShippedReopens(id, persisted).catch(error =>
          this.report(id, 'task reopen baseline', error),
        );
      }
    }
  }

  /** Reconcile the durable task activity with the durable Attention board.
   * This closes the commit→event-delivery crash window without resurrecting a
   * reopen that was explicitly resolved after its latest activity entry. */
  private async reconcileShippedReopens(sessionId: string, persisted: AttentionSnapshot): Promise<void> {
    if (!this.tasks.sessionTaskActivityBaselines) return;
    const baseline = await this.tasks.sessionTaskActivityBaselines(sessionId);
    if (baseline.parseErrors > 0 || persisted.parseErrors > 0) return;
    let safeToCompact = true;
    for (const task of baseline.tasks) {
      if (task.activityParseErrors > 0) {
        safeToCompact = false;
        continue;
      }
      const input = latestReopenedTaskInput(task.id, task.workflow, task.activity);
      const sourceRef = input?.sourceRef ?? null;
      const reopenSeq = input?.sourceSeq;
      if (input === null || sourceRef === null || reopenSeq === undefined) continue;

      const active = persisted.items.some(item => item.source === 'agent-raised' && item.sourceRef === sourceRef);
      if (active) {
        // Refresh the one stable item when a newer shipped rewind changed the
        // reason while the older request remained unresolved.
        await this.attention.addFromSource(sessionId, input).catch(error => {
          safeToCompact = false;
          this.report(sessionId, `task reopen refresh ${task.id}`, error);
        });
        continue;
      }

      if (reopenSeq <= task.reopenAckSeq) continue;

      const reopenedAt = Date.parse(input.waitingSince ?? '');
      const durableResolution = persisted.reopenResolvedAt?.[task.id];
      const resolvedAfterReopen =
        (durableResolution !== undefined && Date.parse(durableResolution) >= reopenedAt) ||
        persisted.resolved.some(
          item =>
            item.source === 'agent-raised' &&
            item.sourceRef === sourceRef &&
            item.sourceSeq === undefined &&
            Number.isFinite(reopenedAt) &&
            Date.parse(item.resolvedAt) >= reopenedAt,
        );
      if (resolvedAfterReopen) {
        if (this.tasks.acknowledgeReopen === undefined) {
          safeToCompact = false;
          continue;
        }
        await this.tasks.acknowledgeReopen(sessionId, task.id, reopenSeq, { actor: 'daemon' }).catch(error => {
          safeToCompact = false;
          this.report(sessionId, `task reopen watermark migration ${task.id}`, error);
        });
        continue;
      }
      await this.attention.addFromSource(sessionId, input).catch(error => {
        safeToCompact = false;
        this.report(sessionId, `task reopen recovery ${task.id}`, error);
      });
    }
    if (safeToCompact && persisted.reopenResolvedAt !== undefined) {
      await this.attention.compactLegacyReopenWatermarks(sessionId);
    }
  }

  private dispatch(event: KTeamEvent): void {
    void this.handle(event).catch(error => this.report(event.sessionId, event.type, error));
  }

  private async handle(event: KTeamEvent): Promise<void> {
    if (event.type === 'fleet.anomaly') {
      const anomalies = record(event.data)['anomalies'];
      if (Array.isArray(anomalies)) await this.applyProviderAnomalies(anomalies as WardenAnomaly[]);
      return;
    }

    if (event.type === 'tasks.updated') {
      const snapshot = event.data as SessionTaskListResponse;
      if (snapshot && snapshot.sessionId === event.sessionId && Array.isArray(snapshot.tasks)) {
        await this.reconcileTaskSnapshot(event.sessionId, snapshot, eventActor(event), true);
      }
      return;
    }

    if (event.type === 'task.reopened') {
      const input = reopenedTaskInput(event);
      if (input !== null) await this.attention.addFromSource(event.sessionId, input);
      return;
    }

    const raw = record(event.data);
    const toolUseId = typeof raw['toolUseId'] === 'string' ? raw['toolUseId'] : null;
    if (
      toolUseId &&
      (event.type === 'interaction.answer' ||
        event.type === 'interaction.question_cancelled' ||
        event.type === 'interaction.question.abandoned')
    ) {
      await this.attention.resolveFromSource(
        event.sessionId,
        'question',
        toolUseId,
        event.type.includes('cancel') || event.type.includes('abandon')
          ? 'Question explicitly abandoned.'
          : 'Question answered.',
        eventActor(event),
      );
      return;
    }

    const permissionRef = refFrom(raw);
    if (permissionRef && PERMISSION_RESOLVED_EVENTS.has(event.type)) {
      await this.attention.resolveFromSource(
        event.sessionId,
        'permission',
        permissionRef,
        `Permission prompt resolved by ${event.type}.`,
        eventActor(event),
      );
      return;
    }
    if (permissionRef && PERMISSION_OPEN_EVENTS.has(event.type)) {
      await this.attention.addFromSource(event.sessionId, {
        source: 'permission',
        sourceRef: permissionRef,
        subject: textFrom(raw, ['subject', 'permission', 'message']) ?? 'A permission decision is waiting',
        why: textFrom(raw, ['why', 'reason']) ?? 'The session cannot continue without this permission decision.',
        waitingSince: event.time,
        howToResolve: 'Approve or deny the permission prompt in this session.',
      });
      return;
    }

    const pending = raw['pendingQuestion'];
    if (pending && typeof pending === 'object') {
      const question = pending as PendingQuestion;
      if (typeof question.toolUseId === 'string' && Array.isArray(question.questions)) {
        await this.attention.addFromSource(event.sessionId, questionInput(question, event.time));
      }
      return;
    }

    if (event.type === 'fleet.needs_human') {
      const why = textFrom(raw, ['reason']) ?? 'A warden requested human attention.';
      const reportPath = textFrom(raw, ['reportPath']);
      const anomalyKind = parseWardenAnomalyKind(textFrom(raw, ['anomalyKind']));
      await this.attention.addFromSource(event.sessionId, {
        source: 'agent-raised',
        sourceRef: wardenVerdictSourceRef(reportPath, anomalyKind),
        subject: 'A warden requested human attention',
        why,
        waitingSince: event.time,
        howToResolve: 'Inspect the session and explicitly resolve this attention item after acting.',
      });
    }
  }

  /** One provider outage produces one durable item on one deterministic session
   *  board. Attention is intentionally not auto-resolved on recovery: its
   *  contract requires the human to act and explicitly clear the request. */
  private async applyProviderAnomalies(anomalies: readonly WardenAnomaly[]): Promise<void> {
    const seen = new Set<string>();
    for (const anomaly of anomalies) {
      if (anomaly.kind !== 'provider_unavailable' || !anomaly.fleetKey) continue;
      const sourceRef = `${PROVIDER_ATTENTION_PREFIX}${anomaly.fleetKey}:${anomaly.generation ?? 1}`;
      if (seen.has(sourceRef)) continue;
      seen.add(sourceRef);
      const candidates = [
        this.providerAnchors.get(sourceRef),
        anomaly.sessionId,
        ...(anomaly.affectedSessionIds ?? []),
      ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
      const affected = anomaly.affectedSessionIds?.length ?? 1;
      const provider = anomaly.provider ?? anomaly.fleetKey;
      let lastError: unknown;
      for (const sessionId of candidates) {
        try {
          await this.attention.addFromSource(sessionId, {
            source: 'agent-raised',
            sourceRef,
            subject: `Provider ${provider} is unavailable (${affected} session${affected === 1 ? '' : 's'})`,
            why: anomaly.detail,
            waitingSince: anomaly.since,
            howToResolve:
              'Check `kteam warden status` and `kfleet usage`; wait for cooldown, top up spend, or re-authenticate as indicated, reroute affected work, then explicitly resolve this item.',
          });
          this.providerAnchors.set(sourceRef, sessionId);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError !== undefined) throw lastError;
    }
  }

  private async applyTaskSnapshot(
    sessionId: string,
    snapshot: SessionTaskListResponse,
    actor: AttentionActor,
    resolveDeparted: boolean,
  ): Promise<void> {
    // A partial/corrupt snapshot must never clear a trusted blocker.
    if (snapshot.parseErrors > 0) return;
    const blocked = snapshot.tasks
      .map(task => ({ task, state: taskAttentionState(task) }))
      .filter(entry => entry.state.needsHuman);
    const current = new Set(blocked.map(entry => entry.task.id));
    const previous = this.blocked.get(sessionId) ?? new Set<string>();
    // Clear explicitly departed blockers first so a full board can accept a
    // replacement blocker in the same authoritative snapshot.
    if (resolveDeparted) {
      for (const id of previous) {
        if (current.has(id)) continue;
        await this.attention
          .resolveFromSource(sessionId, 'task', id, `Task #${id} no longer requires human attention.`, actor)
          .catch(error => this.report(sessionId, `task resolution ${id}`, error));
      }
    }
    for (const { task, state } of blocked) {
      await this.attention
        .addFromSource(sessionId, taskInput(task, state))
        .catch(error => this.report(sessionId, `task blocker ${task.id}`, error));
    }
    this.blocked.set(sessionId, current);
  }

  private async reconcileTaskSnapshot(
    sessionId: string,
    snapshot: SessionTaskListResponse,
    actor: AttentionActor,
    resolveDeparted: boolean,
  ): Promise<void> {
    const previous = this.taskReconciliations.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.applyTaskSnapshot(sessionId, snapshot, actor, resolveDeparted));
    this.taskReconciliations.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.taskReconciliations.get(sessionId) === next) this.taskReconciliations.delete(sessionId);
    }
  }

  private report(sessionId: string, operation: string, error: unknown): void {
    this.log(
      `kteamd attention ${operation} failed for ${sessionId} (${error instanceof Error ? error.name : 'error'})`,
    );
  }
}
