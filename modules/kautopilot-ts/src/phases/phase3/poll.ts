import {
  ghClosePr,
  ghPrChecks,
  ghPrComments,
  ghPrView,
  ghReviews,
  ghReviewThreads,
  ghRunLogsFailed,
} from '../../core/github';
import { appendEvent } from '../../core/log';
import { readDeliveryManifest, updateDeliveryManifest } from '../../core/manifests';
import { ensureStatus } from '../../core/status';
import type { DeliveryManifest, PollState } from '../../core/types';
import type { Phase3Context, PollSignals, RolloverRecommendation } from './types';

/**
 * Compute poll state from GitHub signals and merge policy.
 */
function computePollState(signals: PollSignals, _ctx: Phase3Context): PollState {
  // PR closed externally
  if (signals.prState === 'CLOSED') {
    throw new Error('PR was closed externally');
  }

  // Check if changes were requested
  if (signals.changesRequested) {
    return 'blocked';
  }

  // Check if there are unresolved threads
  if (signals.unresolvedThreads > 0) {
    return 'blocked';
  }

  // Check CI status
  const failingChecks = signals.checks.filter(c => c.status === 'failing');
  const pendingChecks = signals.checks.filter(c => c.status === 'pending');

  if (failingChecks.length > 0) {
    return 'blocked';
  }

  if (pendingChecks.length > 0) {
    return 'pending';
  }

  // Note: required reviewer approvals are intentionally excluded — they may
  // take days and are outside automation scope. We only gate on CI/checks.

  // Check GitHub mergeability after local review/CI gates.
  // BLOCKED is allowed — it typically means required reviewers haven't approved,
  // which we intentionally exclude from automation scope.
  if (!signals.mergeable || !['CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'BLOCKED'].includes(signals.mergeStateStatus)) {
    return 'pending';
  }

  // Check CodeRabbit status
  if (signals.crStatus === 'running' || signals.crStatus === 'failing') {
    return 'pending';
  }

  return 'mergeable';
}

/**
 * Compute PR rollover recommendation from heuristic signals.
 * Spec section 10.2: evaluate whether the current PR is still a good reasoning surface.
 */
function computeRolloverRecommendation(signals: PollSignals, pushCycles: number): RolloverRecommendation {
  const result: RolloverRecommendation = {
    shouldRollover: false,
    signals: {
      unresolvedThreads: signals.unresolvedThreads,
      totalComments: signals.prComments,
      pushCycles,
      prAgeHours: signals.prAge ?? 0,
    },
  };

  // Heuristic thresholds for "too noisy" detection
  const UNRESOLVED_THREAD_THRESHOLD = 15;
  const COMMENT_VOLUME_THRESHOLD = 50;
  const PUSH_CYCLE_THRESHOLD = 8;
  const PR_AGE_HOURS_THRESHOLD = 168; // 7 days

  const reasons: string[] = [];

  if (signals.unresolvedThreads >= UNRESOLVED_THREAD_THRESHOLD) {
    reasons.push(`${signals.unresolvedThreads} unresolved threads (threshold: ${UNRESOLVED_THREAD_THRESHOLD})`);
  }
  if (signals.prComments >= COMMENT_VOLUME_THRESHOLD) {
    reasons.push(`${signals.prComments} total comments (threshold: ${COMMENT_VOLUME_THRESHOLD})`);
  }
  if (pushCycles >= PUSH_CYCLE_THRESHOLD) {
    reasons.push(`${pushCycles} push cycles (threshold: ${PUSH_CYCLE_THRESHOLD})`);
  }
  if ((signals.prAge ?? 0) >= PR_AGE_HOURS_THRESHOLD) {
    reasons.push(`PR age: ${signals.prAge}h (threshold: ${PR_AGE_HOURS_THRESHOLD}h)`);
  }

  // Recommend rollover if 2+ signals fire
  if (reasons.length >= 2) {
    result.shouldRollover = true;
    result.reason = `PR review saturation: ${reasons.join('; ')}`;
  }

  return result;
}

function ensureReportedRunIds(ctx: Phase3Context): number[] {
  const status = ensureStatus(ctx.session.id);
  return status.context.reportedFailedRunIds ?? [];
}

export async function handlePoll(ctx: Phase3Context): Promise<string | null> {
  const { session, version, prNumber, pushCycle, config } = ctx;

  if (!prNumber) {
    throw new Error('poll: no PR number available');
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'poll:started',
    version,
    metadata: { stepType: 'code', pushCycle },
  });

  // Parallel API calls
  const [checks, prView, threads, reviews, prComments] = await Promise.all([
    ghPrChecks(prNumber, session.worktree).catch(e => {
      console.warn('[poll] Failed to fetch checks:', e);
      return [];
    }),
    ghPrView(prNumber, session.worktree).catch(e => {
      console.warn('[poll] Failed to fetch PR view:', e);
      return null;
    }),
    ghReviewThreads(prNumber, session.worktree).catch(e => {
      console.warn('[poll] Failed to fetch threads:', e);
      return [];
    }),
    ghReviews(prNumber, session.worktree).catch(e => {
      console.warn('[poll] Failed to fetch reviews:', e);
      return [];
    }),
    ghPrComments(prNumber, undefined, session.worktree).catch(e => {
      console.warn('[poll] Failed to fetch PR comments:', e);
      return [];
    }),
  ]);

  if (!prView) {
    throw new Error('poll: could not fetch PR status');
  }

  // Fetch failed CI logs only once per failed run ID
  const failingChecks = checks.filter(c => c.status === 'failing');
  if (failingChecks.length > 0) {
    const { ghPrRuns } = await import('../../core/github');
    const runs = await ghPrRuns(prView.headRefName, session.worktree).catch(() => []);
    const failedRuns = runs.filter(r => r.conclusion === 'failure');
    const reportedFailedRunIds = new Set(ctx.session.state === 'running' ? ensureReportedRunIds(ctx) : []);
    const newlyFailedRuns = failedRuns.filter(run => !reportedFailedRunIds.has(run.databaseId));
    await Promise.all(
      newlyFailedRuns.map(async run => {
        const logs = await ghRunLogsFailed(String(run.databaseId), session.worktree).catch(() => '');
        if (logs) {
          console.warn(`[poll] CI failure logs for ${run.name}:\n${logs.slice(0, 1000)}`);
        }
        reportedFailedRunIds.add(run.databaseId);
      }),
    );
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'context:updated',
      metadata: {
        reportedFailedRunIds: [...reportedFailedRunIds].sort((a, b) => a - b),
      },
    });
  }

  // Build signals
  const changesRequested = reviews.some(r => r.state === 'CHANGES_REQUESTED');
  const approvals = reviews.filter(r => r.state === 'APPROVED').length;

  // Detect CodeRabbit status from checks (skip if coderabbit disabled)
  const crCheck = config.settings.coderabbit
    ? checks.find(c => c.name.toLowerCase().includes('coderabbit'))
    : undefined;
  const crStatus = crCheck
    ? crCheck.status === 'passing'
      ? ('passing' as const)
      : crCheck.status === 'failing'
        ? ('failing' as const)
        : ('running' as const)
    : ('none' as const);

  // Compute PR age in hours
  const prCreatedAt = prView.createdAt ? new Date(prView.createdAt).getTime() : Date.now();
  const prAgeHours = Math.round((Date.now() - prCreatedAt) / (1000 * 60 * 60));

  const signals: PollSignals = {
    prState: prView.state,
    mergeable: prView.mergeable,
    mergeStateStatus: prView.mergeStateStatus,
    checks: checks.map(c => ({ name: c.name, status: c.status })),
    threads: threads.length,
    unresolvedThreads: threads.length, // all fetched threads are unresolved
    reviews: reviews.map(r => ({
      author: r.author?.login ?? 'unknown',
      state: r.state,
    })),
    prComments: prComments.length,
    changesRequested,
    approvals,
    crStatus,
    prAge: prAgeHours,
  };

  const pollState = computePollState(signals, ctx);

  // Compute PR rollover recommendation (spec section 10.2)
  const rollover = computeRolloverRecommendation(signals, pushCycle);
  if (rollover.shouldRollover) {
    console.log(`[poll] Rollover recommended: ${rollover.reason}`);
  }

  // Persist rollover recommendation to WAL and delivery manifest
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    metadata: { rolloverRecommendation: rollover },
  });

  // Build delivery manifest updates (spec section 10.2 / 13.1.F)
  const deliveryUpdates: Partial<DeliveryManifest> = {
    kind: 'pr',
    prNumber: prNumber as number,
  };

  // If rollover is recommended, close old PR and route to create_pr for a fresh one
  if (rollover.shouldRollover) {
    const existing = readDeliveryManifest(session.id, version);
    const history = existing?.prRolloverHistory ?? [];
    const oldPrNumber = prNumber as number;

    // Close the old PR (spec section 1.3 / 10.2: rollover must be actionable)
    try {
      await ghClosePr(oldPrNumber, session.worktree);
      console.log(`[poll] Closed old PR #${oldPrNumber} for rollover`);
    } catch (err) {
      console.warn(`[poll] Failed to close old PR #${oldPrNumber}: ${err}`);
    }

    // Record rollover with placeholder toPr — create_pr will update it
    history.push({
      fromPr: oldPrNumber,
      toPr: 0, // placeholder: will be updated when new PR is created
      reason: rollover.reason ?? 'PR review saturation',
      timestamp: new Date().toISOString(),
    });
    deliveryUpdates.prRolloverHistory = history;

    updateDeliveryManifest(session.id, version, deliveryUpdates);

    // Clear PR context and store old PR for create_pr to reference
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'context:updated',
      metadata: { prNumber: null, prUrl: null, rolloverFromPr: oldPrNumber },
    });
    ctx.prNumber = null;
    ctx.prUrl = null;

    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'poll:completed',
      version,
      metadata: {
        pushCycle,
        pollState,
        rollover: {
          shouldRollover: true,
          fromPr: oldPrNumber,
          reason: rollover.reason,
        },
      },
    });

    return 'create_pr';
  }

  updateDeliveryManifest(session.id, version, deliveryUpdates);

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'poll:completed',
    version,
    metadata: {
      pushCycle,
      pollState,
      rollover: {
        shouldRollover: rollover.shouldRollover,
        reason: rollover.reason,
      },
      signals: {
        prState: signals.prState,
        mergeable: signals.mergeable,
        mergeStateStatus: signals.mergeStateStatus,
        checks: signals.checks.map(c => c.status),
        threads: signals.threads,
        unresolvedThreads: signals.unresolvedThreads,
        changesRequested: signals.changesRequested,
        approvals: signals.approvals,
        crStatus: signals.crStatus,
        prAgeHours,
      },
    },
  });

  console.log(
    `[poll] State: ${pollState} (checks: ${checks.filter(c => c.status === 'passing').length}/${checks.length} passing, threads: ${threads.length}, approvals: ${approvals}, cr: ${crStatus})`,
  );

  // Route based on poll state
  switch (pollState) {
    case 'mergeable':
      return 'feedback_check';

    case 'pending': {
      // Wait then re-poll, bounded by maxPushCycles
      if (pushCycle >= config.settings.maxPushCycles) {
        console.log(`[poll] Max push cycles (${config.settings.maxPushCycles}) exceeded`);
        return 'failed';
      }
      const waitMs = (config.settings.pollInterval ?? 60) * 1000;
      console.log(`[poll] Pending — waiting ${(waitMs / 1000).toFixed(0)}s before re-poll...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return 'poll';
    }

    case 'blocked':
      return 'ensure_branch';
  }
}
