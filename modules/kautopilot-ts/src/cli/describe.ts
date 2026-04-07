import { Command } from 'commander';
import { getSessionById, getSessionByWorktree } from '../core/db';
import { getGitRoot, getWorktree } from '../core/git';
import { getActiveInitForWorktree, getInitAttemptById, getInitAttemptByPromotedSessionId } from '../core/init-db';
import { ensureInitStatus } from '../core/init-status';
import { readInitLog, readLog } from '../core/log';
import { readContractManifest, readDeliveryManifest, readPlanManifest } from '../core/manifests';
import { ensureStatus } from '../core/status';
import { formatDuration, logDim, logError, logField, logHeading } from '../util/format';

export function createDescribeCommand(): Command {
  return new Command('describe')
    .argument('[id]', 'Session ID (optional — defaults to local worktree)')
    .option('--json', 'Machine-readable JSON output')
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      try {
        await runDescribe(id, opts);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function runDescribe(id: string | undefined, opts: { json?: boolean }): Promise<void> {
  if (id) {
    const session = getSessionById(id);
    if (session) {
      await describeSession(session.id, opts);
      return;
    }

    const initAttempt = getInitAttemptById(id);
    if (initAttempt) {
      await describeInitAttempt(initAttempt.id, opts);
      return;
    }

    logError(`Session or init attempt ${id} not found in index.`);
    process.exit(1);
  }

  const repoPath = getGitRoot();
  const worktree = getWorktree();
  const session = getSessionByWorktree(repoPath, worktree);
  if (session) {
    await describeSession(session.id, opts);
    return;
  }

  const activeInit = getActiveInitForWorktree(repoPath, worktree);
  if (activeInit) {
    await describeInitAttempt(activeInit.id, opts);
    return;
  }

  logError('No session or init attempt found in this worktree.');
  process.exit(1);
}

async function describeSession(sessionId: string, opts: { json?: boolean }): Promise<void> {
  const session = getSessionById(sessionId);
  if (!session) {
    logError(`Session ${sessionId} not found in index.`);
    process.exit(1);
  }

  const log = readLog(session.id);
  const status = ensureStatus(session.id);
  const initAttemptId = getInitAttemptByPromotedSessionId(session.id)?.id ?? null;

  if (opts.json) {
    const events = log.map(entry => {
      const base: Record<string, unknown> = {
        ts: entry.ts,
        event: entry.event,
      };
      if (entry.version !== undefined) base.version = entry.version;
      if (entry.attempt !== undefined) base.attempt = entry.attempt;
      if (entry.metadata) base.metadata = entry.metadata;

      if (entry.event.endsWith(':completed')) {
        const startEvent = entry.event.replace(':completed', ':started');
        const started = log.find(
          e =>
            e.event === startEvent &&
            e.version === entry.version &&
            (entry.attempt === undefined || e.attempt === entry.attempt),
        );
        if (started) {
          base.duration = new Date(entry.ts).getTime() - new Date(started.ts).getTime();
        }
      }
      return base;
    });

    const activeEpoch = status.version;
    const supersededEpochs: Array<{
      version: number;
      supersededBy: number;
      supersededAt: string;
    }> = [];
    const versionedVersions = [...new Set(log.filter(e => e.version !== undefined).map(e => e.version as number))];
    for (const v of versionedVersions) {
      if (v === activeEpoch) continue;
      const contract = readContractManifest(session.id, v);
      if (contract?.supersededBy) {
        supersededEpochs.push({
          version: v,
          supersededBy: contract.supersededBy,
          supersededAt: contract.supersededAt ?? '',
        });
      }
    }

    const planManifest = readPlanManifest(session.id, activeEpoch);
    const rewriteHistory: Array<{
      version: number;
      decision: string;
      plan?: string;
    }> = [];
    for (const entry of log) {
      if (entry.event === 'context:updated' && entry.version !== undefined) {
        const meta = entry.metadata as Record<string, unknown> | undefined;
        if (meta?.rewriteDecision && typeof meta.rewriteDecision === 'string') {
          rewriteHistory.push({
            version: entry.version,
            decision: meta.rewriteDecision,
            plan: (meta as Record<string, unknown>).plan as string | undefined,
          });
        }
      }
    }

    const delivery = readDeliveryManifest(session.id, activeEpoch);
    const rolloverHistory = delivery?.prRolloverHistory ?? [];
    const handoffReason = status.context.rewriteDecision
      ? `rewrite: ${status.context.rewriteDecision}`
      : status.context.ticketFeedback
        ? 'ticket_feedback'
        : null;

    const data = {
      kind: 'session',
      session: session.id,
      initAttempt: initAttemptId,
      ticketId: session.ticket_id,
      activeEpoch,
      supersededEpochs,
      currentPlans:
        planManifest?.plans.map(p => ({
          ordinal: p.ordinal,
          file: p.file,
          activeRewrite: p.activeRewrite,
          completed: p.completed,
          commitSha: p.commitSha ?? null,
        })) ?? [],
      rewriteHistory,
      handoffReason,
      delivery: {
        kind: delivery?.kind ?? null,
        prNumber: delivery?.prNumber ?? null,
        prUrl: delivery?.prUrl ?? null,
        rolloverHistory,
        ticketArtifacts: delivery?.ticketArtifacts ?? [],
        publishedAt: delivery?.publishedAt ?? null,
      },
      rolloverRecommendation: status.context.rolloverRecommendation ?? null,
      checkpoints: status.completedSteps
        .filter(s => log.some(e => e.event === `${s}:completed`))
        .map(s => {
          const completed = log.filter(e => e.event === `${s}:completed`).pop();
          return { state: s, ts: completed?.ts };
        }),
      events,
    };

    console.log(JSON.stringify(data, null, 2));
    return;
  }

  logField('Session', session.id);
  logField('Ticket', session.ticket_id || '—');
  logField('Branch', session.branch || '—');
  logField('Repo', session.git_root_host);
  logField('Init attempt', initAttemptId || '—');
  console.log();

  if (log.length === 0) {
    logDim('No events recorded.');
    return;
  }

  const versionedEvents = log.filter(e => e.version !== undefined);
  const nonVersionedEvents = log.filter(e => e.version === undefined);

  let currentVersion = 0;
  for (const entry of versionedEvents) {
    if (entry.version !== undefined && entry.version > currentVersion) {
      currentVersion = entry.version;
    }
  }

  if (currentVersion === 0) {
    for (const entry of log) {
      const ts = formatTimestamp(entry.ts);
      const meta = entry.metadata
        ? ' ' +
          Object.entries(entry.metadata)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')
        : '';
      console.log(`${ts} ${entry.event}${meta}`);
    }
    return;
  }

  for (let v = 1; v <= currentVersion; v++) {
    logHeading(`Version ${v}`);
    const versionEvents = versionedEvents.filter(e => e.version === v);
    const startedEvents = versionEvents.filter(e => e.event.endsWith(':started'));

    for (const started of startedEvents) {
      const completed = versionEvents.find(
        e => e.event === started.event.replace(':started', ':completed') && e.version === v,
      );

      const startTime = new Date(started.ts);
      const endTime = completed ? new Date(completed.ts) : startTime;
      const duration = formatDuration(endTime.getTime() - startTime.getTime());
      const stepName = started.event.replace(':started', '');
      const attemptStr = started.attempt ? ` (attempt ${started.attempt})` : '';
      const resultStr = completed?.result ? ` (${completed.result})` : '';
      const metaStr = completed?.metadata
        ? ' ' +
          Object.entries(completed.metadata)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')
        : '';

      console.log(`  ${stepName.padEnd(16)} ${duration.padStart(10)}${attemptStr}${resultStr}${metaStr}`);
    }
    console.log();
  }

  if (nonVersionedEvents.length > 0) {
    logHeading('CLI Events');
    for (const entry of nonVersionedEvents) {
      const ts = formatTimestamp(entry.ts);
      const meta = entry.metadata
        ? ' ' +
          Object.entries(entry.metadata)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')
        : '';
      console.log(`${ts} ${entry.event}${meta}`);
    }
  }
}

async function describeInitAttempt(initAttemptId: string, opts: { json?: boolean }): Promise<void> {
  const initAttempt = getInitAttemptById(initAttemptId);
  if (!initAttempt) {
    logError(`Init attempt ${initAttemptId} not found in index.`);
    process.exit(1);
  }

  const log = readInitLog(initAttempt.id);
  const status = ensureInitStatus(initAttempt.id);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          kind: 'init',
          initAttempt: initAttempt.id,
          outcome: initAttempt.outcome,
          promotedSessionId: initAttempt.promoted_session_id,
          repoPath: initAttempt.repo_path,
          worktree: initAttempt.worktree,
          repo: initAttempt.git_root_host,
          org: initAttempt.org,
          state: status.state,
          stateStatus: status.stateStatus,
          running: status.running,
          startedAt: status.startedAt,
          walCursor: status.walCursor,
          walTimestamp: status.walTimestamp,
          context: status.context,
          completedStates: status.completedStates,
          events: log,
        },
        null,
        2,
      ),
    );
    return;
  }

  logField('Init attempt', initAttempt.id);
  logField('Outcome', initAttempt.outcome || 'active');
  logField('Promoted', initAttempt.promoted_session_id || '—');
  logField('Repo', initAttempt.git_root_host);
  console.log();

  if (log.length === 0) {
    logDim('No events recorded.');
    return;
  }

  for (const entry of log) {
    const ts = formatTimestamp(entry.ts);
    const meta = entry.metadata
      ? ' ' +
        Object.entries(entry.metadata)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
      : '';
    console.log(`${ts} ${entry.event}${meta}`);
  }
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
