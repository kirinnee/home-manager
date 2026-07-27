// One-way, copy-only migration from the legacy fleet-global TaskStore into the
// per-session SessionTaskStore. The source is never deleted or mutated here.

import path from 'path';
import { atomicJson, now } from './io';
import type { KTeamPaths } from './paths';
import { SessionTaskStore, type LegacyTaskImport } from './session-tasks-store';
import { TaskStore } from './tasks-store';
import type { TaskAssigneeView } from './tasks-live';
import { TASK_SCHEMA_VERSION, type Task, type TaskActivity } from './tasks-types';

export const TASK_MIGRATION_REPORT_VERSION = 1;

export interface TaskMigrationReport {
  v: number;
  at: string;
  source: string;
  destination: string;
  /** Always true in this phase. Deletion is a separate, later decision after
   *  the human has inspected a clean report and both stores agree. */
  globalStoreRetained: true;
  imported: Array<{ sessionId: string; taskId: string }>;
  alreadyImported: Array<{ sessionId: string; taskId: string }>;
  conflicts: Array<{ sessionId: string; taskId: string }>;
  /** Valid records with no assignee that resolves to a real session. Their
   *  defined home remains the retained global store and aggregate read. */
  unresolved: string[];
  unresolvedDetails: Array<{
    taskId: string;
    assignee: string | null;
    reason: 'unassigned' | 'human' | 'not-found' | 'ambiguous';
    candidates: string[];
  }>;
  /** Valid task record, damaged activity log: copying only the readable lines
   *  would falsely prove a complete migration, so the source remains canonical. */
  damagedActivity: Array<{ taskId: string; parseErrors: number }>;
  /** Destination boards that could not be read or written. Their entire
   *  source group remains canonical, while migration continues for unrelated
   *  sessions instead of taking every task route down. */
  damagedDestinations: Array<{
    sessionId: string;
    taskIds: string[];
    error: string;
  }>;
  sourceParseErrors: number;
  sourceParseErrorIds: string[];
  /** True only when every readable source record is durably represented and no
   *  damaged/unresolved/conflicting source remains. */
  proven: boolean;
}

export function taskMigrationReportFile(paths: KTeamPaths): string {
  return path.join(paths.daemon, 'tasks-migration-v1.json');
}

/** Names that identify the human in legacy records, never an agent session.
 *  Denying them before callsign lookup prevents a future teammate named
 *  "kirin" from silently inheriting the human's blocked work. */
export const LEGACY_HUMAN_ASSIGNEES = new Set(['user', 'kirin']);

export interface LegacyOwnerResolution {
  sessionId: string | null;
  reason: 'resolved' | 'unassigned' | 'human' | 'not-found' | 'ambiguous';
  candidates: string[];
}

const millis = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Migration is stricter than live annotation: an exact session id is stable;
 *  a callsign/name is accepted only when exactly one plausible session exists.
 *  Sessions born after the task's last assignment cannot be what that historic
 *  assignee meant. Ambiguity stays in the retained source instead of guessing. */
export function resolveLegacyTaskOwner(
  task: Task,
  activity: readonly TaskActivity[],
  views: readonly TaskAssigneeView[],
): LegacyOwnerResolution {
  const assignee = task.assignee?.trim() ?? '';
  if (!assignee) return { sessionId: null, reason: 'unassigned', candidates: [] };
  if (LEGACY_HUMAN_ASSIGNEES.has(assignee.toLowerCase())) {
    return { sessionId: null, reason: 'human', candidates: [] };
  }
  const exact = views.find(view => view.config.id === assignee);
  if (exact) return { sessionId: exact.config.id, reason: 'resolved', candidates: [exact.config.id] };

  const assignedEvent = [...activity].reverse().find(entry => entry.type === 'assign' || entry.type === 'created');
  const assignedAt = millis(assignedEvent?.time) ?? millis(task.createdAt);
  const candidates = views.filter(view => {
    if (view.config.teammate !== assignee && view.config.name !== assignee) return false;
    const born = millis(view.config.createdAt);
    return assignedAt === null || born === null || born <= assignedAt;
  });
  const ids = [...new Set(candidates.map(view => view.config.id))];
  if (ids.length === 1) return { sessionId: ids[0]!, reason: 'resolved', candidates: ids };
  return { sessionId: null, reason: ids.length === 0 ? 'not-found' : 'ambiguous', candidates: ids };
}

function migrationActivity(
  taskId: string,
  activity: readonly TaskActivity[],
  resolution: LegacyOwnerResolution & { sessionId: string },
): TaskActivity {
  const highest = activity.reduce((value, entry) => Math.max(value, entry.seq), 0);
  return {
    v: TASK_SCHEMA_VERSION,
    seq: highest + 1,
    time: now(),
    actor: 'daemon',
    actorName: null,
    type: 'session',
    data: {
      event: 'migrated',
      from: 'global',
      taskId,
      resolvedSession: resolution.sessionId,
      ...(resolution.candidates.length > 1 ? { candidates: resolution.candidates } : {}),
    },
  };
}

export async function migrateLegacyTasks(
  paths: KTeamPaths,
  legacy: TaskStore,
  sessions: SessionTaskStore,
  views: readonly TaskAssigneeView[],
): Promise<TaskMigrationReport> {
  const source = await legacy.listTasks();
  const groups = new Map<string, LegacyTaskImport[]>();
  const unresolved: string[] = [];
  const unresolvedDetails: TaskMigrationReport['unresolvedDetails'] = [];
  const damagedActivity: Array<{ taskId: string; parseErrors: number }> = [];

  for (const task of source.tasks) {
    const activity = await legacy.readActivity(task.id);
    if (activity.parseErrors > 0) {
      damagedActivity.push({ taskId: task.id, parseErrors: activity.parseErrors });
      continue;
    }
    const owner = resolveLegacyTaskOwner(task, activity.activity, views);
    if (owner.sessionId === null) {
      unresolved.push(task.id);
      unresolvedDetails.push({
        taskId: task.id,
        assignee: task.assignee,
        reason: owner.reason as Exclude<LegacyOwnerResolution['reason'], 'resolved'>,
        candidates: owner.candidates,
      });
      continue;
    }
    const resolved = { ...owner, sessionId: owner.sessionId };
    const list = groups.get(owner.sessionId) ?? [];
    list.push({ task, activity: [...activity.activity, migrationActivity(task.id, activity.activity, resolved)] });
    groups.set(owner.sessionId, list);
  }

  const imported: TaskMigrationReport['imported'] = [];
  const alreadyImported: TaskMigrationReport['alreadyImported'] = [];
  const conflicts: TaskMigrationReport['conflicts'] = [];
  const damagedDestinations: TaskMigrationReport['damagedDestinations'] = [];
  for (const [sessionId, records] of groups) {
    try {
      const result = await sessions.importLegacy(sessionId, records);
      imported.push(...result.imported.map(taskId => ({ sessionId, taskId })));
      alreadyImported.push(...result.alreadyImported.map(taskId => ({ sessionId, taskId })));
      conflicts.push(...result.conflicts.map(taskId => ({ sessionId, taskId })));
    } catch (error) {
      damagedDestinations.push({
        sessionId,
        taskIds: records.map(record => record.task.id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report: TaskMigrationReport = {
    v: TASK_MIGRATION_REPORT_VERSION,
    at: now(),
    source: legacy.dir,
    destination: '<sessionDir>/tasks.json',
    globalStoreRetained: true,
    imported,
    alreadyImported,
    conflicts,
    unresolved,
    unresolvedDetails,
    damagedActivity,
    damagedDestinations,
    sourceParseErrors: source.parseErrors,
    sourceParseErrorIds: source.parseErrorIds,
    proven:
      conflicts.length === 0 &&
      unresolved.length === 0 &&
      damagedActivity.length === 0 &&
      damagedDestinations.length === 0 &&
      source.parseErrors === 0,
  };
  await atomicJson(taskMigrationReportFile(paths), report);
  return report;
}
