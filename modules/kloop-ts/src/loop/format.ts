import pc from 'picocolors';
import { format } from 'date-fns';

// ============================================================================
// Formatting helpers for run loop output
// ============================================================================

/** Legacy short duration for live loop output */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

/**
 * Human-friendly duration: show the largest non-zero units from days, hours, minutes, seconds.
 * Examples: "2d 3h 12m", "1h 24m 6s", "45m 2s", "12s"
 */
export function formatDurationHuman(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSecs = Math.floor(ms / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Human-friendly age ("how long ago").
 * If older than 2 days: "Mar 26" or "Mar 26, 14:30"
 * If <= 2 days: "1d 3h ago", "4h 12m ago", "23m ago"
 */
export function formatAgeHuman(date: Date): string {
  const now = Date.now();
  const then = date.getTime();
  const diffMs = now - then;
  const diffDays = diffMs / 86400000;

  if (diffDays > 2) {
    return format(date, 'MMM dd, HH:mm');
  }

  const totalSecs = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (parts.length === 0) parts.push(`${Math.floor(diffMs / 1000)}s`);

  return parts.join(' ') + ' ago';
}

export function formatHeader(
  runId: string,
  config: { implementers?: Record<string, number>; reviewPhases?: string[][] },
  workspace: string,
): void {
  const implBinary = config.implementers ? Object.keys(config.implementers)[0] : 'claude';
  const totalReviewers = config.reviewPhases?.reduce((sum: number, phase: string[]) => sum + phase.length, 0) ?? 0;
  const phaseInfo = config.reviewPhases?.length > 1 ? ` in ${config.reviewPhases.length} phases` : '';

  console.log('');
  console.log(`  ${pc.bold(pc.cyan(`kloop ${runId}`))}  ${pc.green('●')}  ${pc.green('running')}`);
  console.log(pc.dim(`  implementer: ${implBinary}  │  ${totalReviewers} reviewers${phaseInfo}`));
  console.log(pc.dim(`  workspace: ${workspace}`));
  console.log('');
}

export function formatIterationStart(loopNum: number, maxIterations: number): void {
  console.log(
    pc.dim(
      `── iteration ${loopNum}/${maxIterations} ${'─'.repeat(Math.max(1, 45 - String(loopNum).length - String(maxIterations).length))}`,
    ),
  );
}

export function formatImplementerResult(binary: string, exitCode: number, durationMs: number): void {
  const icon = exitCode === 0 ? pc.green('✓') : pc.red('✗');
  const color = exitCode === 0 ? pc.green : pc.red;
  console.log(`  ${icon} impl  ${binary}     ${color(`exit ${exitCode}`)}   ${pc.dim(formatDuration(durationMs))}`);
}

export function formatReviewPhaseStart(phaseIdx: number, reviewers: string[]): void {
  console.log('');
  console.log(pc.dim(`  ◆ review phase ${phaseIdx} (${reviewers.length} reviewers)`));
}

export function formatReviewerResult(
  reviewerIndex: number,
  binary: string,
  verdict: string | undefined,
  completionEstimate: number | undefined,
  durationMs: number,
): void {
  const approved = verdict === 'approved';
  const icon = approved ? pc.green('✓') : pc.red('✗');
  const verdictColor = approved ? pc.green('approved') : pc.red('rejected');
  const completion = completionEstimate !== undefined ? `${String(completionEstimate).padStart(3)}%` : '    ';
  console.log(
    `  ${icon} rev-${reviewerIndex}  ${binary}    ${verdictColor}  ${pc.dim(completion)}  ${pc.dim(formatDuration(durationMs))}`,
  );
}

export function formatConsensus(
  approved: boolean,
  verdictsList: Array<{ verdict: string; approved: boolean; rejected: boolean }>,
): void {
  if (approved) {
    console.log(`  ${pc.green('✓ consensus: approved')}`);
  } else {
    const approvedCount = verdictsList.filter(v => v.verdict === 'approved').length;
    const totalCount = verdictsList.length;
    console.log(`  ${pc.red('✗ consensus: rejected')}  ${pc.dim(`(${approvedCount}/${totalCount} approved)`)}`);
  }
}

export function formatFailure(consecutive: number, threshold: number): void {
  console.log(pc.dim(`  failures ${consecutive}/${threshold}`));
}

export function formatCheckpointStart(): void {
  console.log(pc.yellow('  ◆ conflict threshold reached, running checkpointer...'));
}

export function formatCheckpointOutcome(outcome: string, detail?: string): void {
  switch (outcome) {
    case 'conflict_found':
      console.log(pc.red('  ✗ conflict detected'));
      if (detail) console.log(pc.dim(`    ${detail}`));
      break;
    case 'spec_auto_fixed':
      console.log(pc.yellow('  ◆ spec auto-fixed, reloading...'));
      break;
    case 'spec_compressed':
      console.log(pc.yellow(`  ◆ spec compressed, reloading...`));
      break;
    case 'no_action':
      console.log(pc.dim('  ◆ no action needed, continuing...'));
      break;
  }
}

export function formatPhaseShortCircuit(phaseIdx: number, remaining: number): void {
  console.log(pc.dim(`  phase ${phaseIdx} rejection → skipping ${remaining} remaining phase(s)`));
}

export function formatApproval(loopNum: number): void {
  console.log('');
  console.log(`  ${pc.green(pc.bold(`✓ approved after ${loopNum} iteration(s)`))}`);
}

export function formatMaxIterations(maxIterations: number): void {
  console.log(pc.yellow(`  max iterations reached (${maxIterations})`));
}

export function formatAgentFailure(binary: string, error: string): void {
  console.log(pc.red('  ───────────────────────────────────────────'));
  console.log(pc.red('  AGENT FAILURE'));
  console.log(pc.red('  ───────────────────────────────────────────'));
  console.log(pc.red(`  ${binary}: ${error}`));
  console.log(pc.dim('  Use kloop view to inspect the agent log.'));
  console.log(pc.red('  ───────────────────────────────────────────'));
}

export function formatRunStart(): void {
  console.log('');
}

export function formatAgentLaunch(
  role: 'impl' | 'reviewer' | 'checkpoint',
  label: string,
  binary: string,
  tmuxSession: string,
  logPath: string,
): void {
  const roleLabel = role === 'impl' ? 'implementer' : role === 'reviewer' ? label : 'checkpointer';
  console.log(`  ▸ ${pc.cyan(roleLabel)}  ${pc.bold(binary)}`);
  console.log(pc.dim(`    tmux: ${tmuxSession}`));
  console.log(pc.dim(`    log:  ${logPath}`));
}

export function formatImplementerFailure(error: string): void {
  console.log(pc.red(`  ✗ implementer failed: ${error}`));
}

export function formatConflict(summary: string): void {
  console.log('');
  console.log(pc.red('  ───────────────────────────────────────────'));
  console.log(pc.red(pc.bold('  CONFLICT DETECTED')));
  console.log(pc.red('  ───────────────────────────────────────────'));
  for (const line of summary.split('\n')) {
    console.log(pc.red(`  ${line}`));
  }
  console.log(pc.dim('  A conflict.md file has been generated.'));
  console.log(pc.dim('  Please resolve the conflict and restart the loop.'));
  console.log(pc.red('  ───────────────────────────────────────────'));
  console.log('');
}

export function formatProgress(
  estimates: number[],
  allResults: Array<{ reviewerIndex: number; completionEstimate?: number }>,
): void {
  if (estimates.length === 0) return;
  const lowestEstimate = Math.min(...estimates);
  const lowestEstimateReviewer = allResults.find(r => r.completionEstimate === lowestEstimate);
  const reviewerInfo = lowestEstimateReviewer ? ` (rev-${lowestEstimateReviewer.reviewerIndex})` : '';

  const barWidth = 30;
  const filled = Math.round((lowestEstimate / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = pc.green('█'.repeat(filled)) + pc.dim('░'.repeat(empty));

  console.log(`  progress  ${bar} ${lowestEstimate}%${reviewerInfo}`);
}
