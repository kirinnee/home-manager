import pc from 'picocolors';
import type { StateService } from '../deps';
import { format } from 'date-fns';

const CLAUDE_AUTO_PREFIX = 'claude-auto-';

function shortBinary(binary: string): string {
  return binary.startsWith(CLAUDE_AUTO_PREFIX) ? binary.slice(CLAUDE_AUTO_PREFIX.length) : binary;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}

export async function handler(state: StateService): Promise<void> {
  try {
    const hasConfig = await state.hasConfig();
    if (!hasConfig) {
      console.log(pc.yellow('Dev-loop not initialized.'));
      console.log(pc.dim('Run: dev-loop init'));
      return;
    }

    const config = await state.loadConfig();
    const run = await state.loadRun();

    console.log(pc.bold('Dev Loop Status'));
    console.log('');

    console.log(pc.cyan('Config:'));
    // Implementers
    const implEntries = Object.entries(config.implementers);
    if (implEntries.length === 1 && implEntries[0][1] === 1) {
      console.log(`  Implementer: ${shortBinary(implEntries[0][0])}`);
    } else {
      console.log(`  Implementers:`);
      for (const [binary, weight] of implEntries) {
        console.log(`    ${shortBinary(binary)} (weight: ${weight})`);
      }
    }

    // Review phases
    if (config.reviewPhases.length === 1) {
      console.log(`  Reviewers: ${config.reviewPhases[0].map(shortBinary).join(', ')}`);
    } else {
      console.log(`  Review Phases:`);
      for (let i = 0; i < config.reviewPhases.length; i++) {
        console.log(`    Phase ${i}: ${config.reviewPhases[i].map(shortBinary).join(', ')}`);
      }
    }

    if (config.conflictChecker) {
      console.log(`  Conflict checker: ${shortBinary(config.conflictChecker)}`);
    }
    console.log(`  Max iterations: ${config.maxIterations}`);
    console.log(`  Timeouts: impl ${config.implementerTimeout}m, rev ${config.reviewerTimeout}m`);
    console.log(`  Conflict check threshold: ${config.conflictCheckThreshold} failures`);
    console.log('');

    if (!run) {
      console.log(pc.yellow('No active run.'));
      console.log(pc.dim('Run: dev-loop run'));
      return;
    }

    const statusColor = run.status === 'running' ? pc.green : run.status === 'completed' ? pc.blue : pc.yellow;
    console.log(`${pc.cyan('Run:')} ${run.id} ${statusColor(`[${run.status.toUpperCase()}]`)}`);
    console.log(`  Iteration: ${run.iteration} / ${config.maxIterations}`);
    console.log(`  Phase: ${run.phase}`);
    console.log(`  Started: ${format(new Date(run.startedAt), 'yyyy-MM-dd HH:mm:ss')}`);

    // Show elapsed time
    const elapsedMs = Date.now() - new Date(run.startedAt).getTime();
    console.log(`  Elapsed: ${formatDuration(elapsedMs)}`);

    // Show consecutive failures if any
    if (run.consecutiveFailures > 0) {
      const failureColor = run.consecutiveFailures >= config.conflictCheckThreshold ? pc.red : pc.yellow;
      console.log(
        `  Consecutive failures: ${failureColor(`${run.consecutiveFailures} / ${config.conflictCheckThreshold}`)}`,
      );
    }
    console.log('');

    // Show metrics summary for current run
    try {
      const samples = await state.loadMetricSamples(run.id);
      if (samples.length > 0) {
        console.log(pc.cyan('Metrics:'));
        const totalDurationMs = samples.reduce((sum, s) => sum + s.durationMs, 0);
        const totalInputTokens = samples.reduce((sum, s) => sum + (s.inputTokens ?? 0), 0);
        const totalOutputTokens = samples.reduce((sum, s) => sum + (s.outputTokens ?? 0), 0);
        const totalTokens = totalInputTokens + totalOutputTokens;

        console.log(`  Total time: ${formatDuration(totalDurationMs)}`);
        if (totalTokens > 0) {
          console.log(
            `  Total tokens: ${totalTokens.toLocaleString()} (${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out)`,
          );
        } else {
          console.log(`  Tokens: not available`);
        }
        console.log(`  Samples: ${samples.length}`);

        // Per-loop breakdown
        const byLoop = new Map<string, typeof samples>();
        for (const s of samples) {
          const loop = s.labels.loop;
          if (!byLoop.has(loop)) byLoop.set(loop, []);
          byLoop.get(loop)!.push(s);
        }
        console.log(`  Per-loop:`);
        for (const [loop, loopSamples] of Array.from(byLoop.entries()).sort((a, b) => Number(a[0]) - Number(b[0]))) {
          const loopDuration = loopSamples.reduce((sum, s) => sum + s.durationMs, 0);
          const loopInput = loopSamples.reduce((sum, s) => sum + (s.inputTokens ?? 0), 0);
          const loopOutput = loopSamples.reduce((sum, s) => sum + (s.outputTokens ?? 0), 0);
          const loopTotal = loopInput + loopOutput;
          const tokenStr = loopTotal > 0 ? `, ${loopTotal.toLocaleString()} tok` : '';
          console.log(`    Loop ${loop}: ${formatDuration(loopDuration)}${tokenStr}`);
        }
        console.log('');
      }
    } catch {
      // Metrics not available
    }

    // Show checkpoint result if available
    const checkpointResult = await state.loadCheckpointResult();
    if (checkpointResult) {
      const outcomeColors: Record<string, (s: string) => string> = {
        conflict_found: pc.red,
        spec_auto_fixed: pc.green,
        spec_compressed: pc.blue,
        no_action: pc.dim,
      };
      const outcomeColor = outcomeColors[checkpointResult.outcome] || pc.dim;
      console.log(pc.cyan('Last Checkpoint:'));
      console.log(`  Outcome: ${outcomeColor(checkpointResult.outcome)}`);
      console.log(`  Summary: ${checkpointResult.summary}`);
      if (checkpointResult.progressPercent !== undefined) {
        console.log(`  Progress: ${checkpointResult.progressPercent}%`);
      }
      console.log('');
    }

    if (run.learnings.length > 0) {
      console.log(pc.cyan(`Learnings (${run.learnings.length}):`));
      run.learnings.slice(-3).forEach((l, i) => {
        console.log(`  ${pc.dim(`${i + 1}.`)} ${l.slice(0, 60)}...`);
      });
      console.log('');
    }

    const sessions = await state.loadSessions();
    if (sessions.length > 0) {
      // Show per-iteration tables
      const iterations = [...new Set(sessions.map(s => s.iteration))].sort((a, b) => a - b).slice(-2);

      for (const iter of iterations) {
        const iterSessions = sessions.filter(s => s.iteration === iter);
        const isCurrent = iter === run.iteration;
        const implSessions = iterSessions.filter(s => s.role === 'implementer');
        const revSessions = iterSessions
          .filter(s => s.role === 'reviewer')
          .sort((a, b) => (a.reviewerIndex ?? 0) - (b.reviewerIndex ?? 0));

        // Iteration header
        const iterLabel = isCurrent ? pc.bold(`Iteration ${iter}`) : `Iteration ${iter}`;
        console.log(`${iterLabel}`);

        // Implementer row
        for (const s of implSessions) {
          const statusIcon =
            s.status === 'running' ? pc.yellow('⏳') : s.status === 'completed' ? pc.green('✓') : pc.red('✗');
          const duration = s.completedAt
            ? formatDuration(new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime())
            : '';
          console.log(
            `  ${statusIcon}  ${pc.bold(shortBinary(s.binary ?? 'impl'))}  ${pc.dim('implementer')}  ${duration}`,
          );
        }

        // Reviewer table
        if (revSessions.length > 0) {
          // Load verdicts for this iteration
          const iterVerdicts = iter > 0 ? await state.loadVerdicts(iter).catch(() => new Map()) : new Map();

          // Calculate column widths
          const nameCol =
            Math.max(8, ...revSessions.map(s => shortBinary(s.binary ?? `rev${s.reviewerIndex ?? '?'}`).length)) + 1;
          const rows = revSessions.map(s => {
            const vf = iterVerdicts.get(s.reviewerIndex ?? -1);
            const hasVerdictFile = !!vf;
            const completionEstimate = vf?.completionEstimate;
            const duration = s.completedAt
              ? formatDuration(new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime())
              : '';

            // Verdict emoji: ✓/✗ based on actual verdict
            const verdictStr = s.verdict ? (s.verdict === 'approved' ? pc.green('✓') : pc.red('✗')) : pc.dim('·');

            // Verdict source emoji: 📋 if verdict file exists, 🚫 if inferred (no verdict file)
            const sourceStr = hasVerdictFile ? '📋' : '🚫';

            const pctStr = completionEstimate !== undefined ? `${String(completionEstimate).padStart(3)}%` : '';

            return {
              name: shortBinary(s.binary ?? `rev${s.reviewerIndex ?? '?'}`),
              verdict: verdictStr,
              source: sourceStr,
              duration,
              pct: pctStr,
              running: s.status === 'running',
            };
          });

          // Table header
          const hdr = `  ${'ROLE'.padEnd(nameCol)}  VD  SRC  ${'DUR'.padStart(6)}  PCT`;
          console.log(pc.dim(hdr));
          console.log(pc.dim(`  ${'─'.repeat(nameCol)}  ──  ───  ${'──────'.padStart(6)}  ────`));

          for (const row of rows) {
            if (row.running) {
              console.log(
                `  ${pc.dim(row.name.padEnd(nameCol))}  ${pc.yellow('⏳')}  ${pc.dim('···')}  ${pc.dim('running'.padStart(6))}  ${pc.dim('···')}`,
              );
            } else {
              console.log(
                `  ${row.name.padEnd(nameCol)}  ${row.verdict}   ${row.source}  ${pc.dim(row.duration.padStart(6))}  ${row.pct ? pc.dim(row.pct) : ''}`,
              );
            }
          }
        }

        console.log('');
      }
    }

    console.log(pc.dim('Commands: dev-loop attach | dev-loop cancel | dev-loop logs | dev-loop metrics'));
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
