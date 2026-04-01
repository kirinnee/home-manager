import { Command } from 'commander';
import { getSessionByWorktree, getSessionById } from '../core/db';
import { readLog } from '../core/log';
import { ensureStatus } from '../core/status';
import { getGitRoot, getWorktree } from '../core/git';
import { formatDuration, logField, logHeading, logError, logDim } from '../util/format';
import { readContractManifest, readPlanManifest, readDeliveryManifest } from '../core/manifests';

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
  let session;
  if (id) {
    session = getSessionById(id);
    if (!session) {
      logError(`Session ${id} not found in index.`);
      process.exit(1);
    }
  } else {
    const repoPath = getGitRoot();
    const worktree = getWorktree();
    session = getSessionByWorktree(repoPath, worktree);
    if (!session) {
      logError('No session found in this worktree.');
      process.exit(1);
    }
  }

  const log = readLog(session.id);
  const status = ensureStatus(session.id);

  if (opts.json) {
    // Build enriched event list with durations
    const events = log.map(entry => {
      const base: Record<string, unknown> = {
        ts: entry.ts,
        event: entry.event,
      };
      if (entry.version !== undefined) base.version = entry.version;
      if (entry.attempt !== undefined) base.attempt = entry.attempt;
      if (entry.metadata) base.metadata = entry.metadata;

      // Compute duration for :completed events
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

    // Active epoch
    const activeEpoch = status.version;

    // Find superseded epochs from all contract manifests
    const supersededEpochs: Array<{ version: number; supersededBy: number; supersededAt: string }> = [];
    for (const entry of log) {
      if (entry.event === 'context:updated' && entry.version !== undefined) {
        const meta = entry.metadata as Record<string, unknown> | undefined;
        if (meta?.rewriteDecision === 'revisit_spec' || meta?.ticketFeedback) {
          // A rewrite happened at this version
        }
      }
    }
    // Scan all versions for superseded contract manifests
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

    // Current plan manifest (active epoch)
    const planManifest = readPlanManifest(session.id, activeEpoch);

    // Rewrite history: collect all rewrite decisions from WAL
    const rewriteHistory: Array<{ version: number; decision: string; plan?: string }> = [];
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

    // Delivery state (active epoch)
    const delivery = readDeliveryManifest(session.id, activeEpoch);

    // PR rollover history
    const rolloverHistory = delivery?.prRolloverHistory ?? [];

    // Handoff reason: current rewrite decision or ticket feedback
    const handoffReason = status.context.rewriteDecision
      ? `rewrite: ${status.context.rewriteDecision}`
      : status.context.ticketFeedback
        ? 'ticket_feedback'
        : null;

    const data = {
      session: session.id,
      ticketId: session.ticket_id,
      // Durable state surface (spec sections 9.2 / 13.1.E)
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
      // Legacy event data
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
  console.log();

  if (log.length === 0) {
    logDim('No events recorded.');
    return;
  }

  // Separate versioned and non-versioned events
  const versionedEvents = log.filter(e => e.version !== undefined);
  const nonVersionedEvents = log.filter(e => e.version === undefined);

  // Find max version
  let currentVersion = 0;
  for (const entry of versionedEvents) {
    if (entry.version !== undefined && entry.version > currentVersion) {
      currentVersion = entry.version;
    }
  }

  if (currentVersion === 0) {
    // No versioned events, show all events
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
  } else {
    // Group by version (only versioned events)
    for (let v = 1; v <= currentVersion; v++) {
      logHeading(`Version ${v}`);
      const versionEvents = versionedEvents.filter(e => e.version === v);
      const startedEvents = versionEvents.filter(e => e.event.endsWith(':started'));

      for (let i = 0; i < startedEvents.length; i++) {
        const started = startedEvents[i];
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

    // Show non-versioned CLI events (init, start, stop)
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
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
