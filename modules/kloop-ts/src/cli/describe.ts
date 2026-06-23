import pc from 'picocolors';
import { format } from 'date-fns';
import type { CliDeps } from './index';
import type { MaterializedStatus, MaterializedLoop, MaterializedAgentState, Config } from '../types';
import { reviewTypeLabel, parseRawConfig } from '../types';
import { paths } from '../deps';
import { formatDurationHuman, formatAgeHuman } from '../loop/format';

const CLAUDE_AUTO_PREFIX = 'claude-auto-';

function shortBinary(binary: string, harness?: string): string {
  if (harness && harness !== 'claude') return `${binary}:${harness}`;
  return binary;
}

function agentLabel(agent: MaterializedAgentState): string {
  return shortBinary(agent.binary, agent.harness);
}

function formatDuration(ms: number): string {
  return formatDurationHuman(ms);
}

function formatTokens(input?: number, output?: number): string {
  if (!input && !output) return '';
  const total = (input ?? 0) + (output ?? 0);
  if (total < 1000) return `${total}`;
  return `${(total / 1000).toFixed(1)}k`;
}

// ============================================================================
// Renderers
// ============================================================================

function statusMark(ok: boolean | undefined): string {
  if (ok === undefined) return pc.dim('○');
  return ok ? pc.green('●') : pc.red('●');
}

function verdictMark(verdict?: string): string {
  if (verdict === 'approved') return pc.green('\u2713');
  if (verdict === 'rejected') return pc.red('\u2717');
  return pc.dim('·');
}

const NAME_W = 10;
const ROLE_W = 10;

function fmtRow(role: string, name: string, dur: string, info: string): string {
  return `  ${pc.dim(role.padEnd(ROLE_W))}  ${name.padEnd(NAME_W)}  ${dur.padStart(8)}  ${info}`;
}

function agentDuration(agent: MaterializedAgentState): string {
  if (agent.durationMs) return formatDuration(agent.durationMs);
  if (agent.startedAt && agent.status === 'running') {
    return formatDuration(Date.now() - new Date(agent.startedAt).getTime());
  }
  return '';
}

function agentOk(agent: MaterializedAgentState): boolean | undefined {
  if (agent.status === 'completed') return agent.exitCode === 0;
  if (agent.status === 'error' || agent.status === 'timeout') return false;
  return undefined;
}

function renderLoopFull(loop: MaterializedLoop, multiPhase: boolean): void {
  // Implementer — green dot for running/exit 0, red dot for non-zero
  if (loop.implementer) {
    const impl = loop.implementer;
    const implTok = formatTokens(impl.inputTokens, impl.outputTokens);
    const errNote = impl.error ? pc.yellow(` ${impl.error}`) : '';
    if (impl.status === 'running') {
      console.log(fmtRow('impl', agentLabel(impl), agentDuration(impl), `${pc.green('●')} running`));
    } else if (impl.status === 'pending') {
      console.log(fmtRow('impl', pc.dim('...'), '', pc.dim('pending')));
    } else {
      const dot = impl.exitCode === 0 ? pc.green('●') : pc.red('●');
      console.log(
        fmtRow(
          'impl',
          agentLabel(impl),
          agentDuration(impl),
          `${dot}${implTok ? `  ${pc.dim(implTok + ' tok')}` : ''}${errNote}`,
        ),
      );
    }
  }

  // Verify phases
  for (const phase of loop.verifyPhases ?? []) {
    const role = multiPhase ? `verify ${phase.phase}` : 'verify';
    for (const r of phase.reviewers) {
      const errNote = r.error ? pc.yellow(` ${r.error}`) : '';
      const tok = formatTokens(r.inputTokens, r.outputTokens);
      if (r.status === 'running' || r.status === 'pending') {
        const elapsed = r.startedAt ? formatDuration(Date.now() - new Date(r.startedAt).getTime()) : '';
        console.log(
          fmtRow(role, agentLabel(r), elapsed, `${pc.dim(r.status)}${r.verdict ? `  ${verdictMark(r.verdict)}` : ''}`),
        );
      } else {
        console.log(
          fmtRow(
            role,
            agentLabel(r),
            agentDuration(r),
            `${verdictMark(r.verdict)}  ${statusMark(agentOk(r))}${tok ? `  ${pc.dim(tok + ' tok')}` : ''}${errNote}`,
          ),
        );
      }
    }
  }

  // Review phases
  for (const phase of loop.reviewPhases) {
    const role = multiPhase ? `phase ${phase.phase}` : 'review';
    for (const r of phase.reviewers) {
      const pct = r.completionEstimate !== undefined ? `${r.completionEstimate}%` : '';
      const tok = formatTokens(r.inputTokens, r.outputTokens);
      const errNote = r.error ? pc.yellow(` ${r.error}`) : '';

      if (r.status === 'running' || r.status === 'pending') {
        const elapsed = r.startedAt ? formatDuration(Date.now() - new Date(r.startedAt).getTime()) : '';
        console.log(
          fmtRow(
            role,
            agentLabel(r),
            elapsed,
            `${pc.dim(r.status)}${r.verdict ? `  ${verdictMark(r.verdict)}` : ''}${pct ? `  ${pct}` : ''}`,
          ),
        );
      } else {
        console.log(
          fmtRow(
            role,
            agentLabel(r),
            agentDuration(r),
            `${verdictMark(r.verdict)}  ${statusMark(agentOk(r))}${pct ? `  ${pc.dim(pct)}` : ''}${tok ? `  ${pc.dim(tok + ' tok')}` : ''}${errNote}`,
          ),
        );
      }
    }
  }

  // Synthesis
  if (loop.synthesis) {
    const synth = loop.synthesis;
    if (synth.status === 'running') {
      console.log(`  synthesis: ${pc.dim('running...')}`);
    } else if (synth.status === 'completed') {
      console.log(`  synthesis: ${pc.green('completed')}${synth.summaryPath ? ` → ${synth.summaryPath}` : ''}`);
    } else if (synth.status === 'error') {
      console.log(`  synthesis: ${pc.red('failed')}${synth.error ? ` (${synth.error})` : ''}`);
    }
  }

  // Checkpoint
  if (loop.checkpoint) {
    const ck = loop.checkpoint;
    if (ck.status === 'running') {
      console.log(`  checkpoint: ${pc.dim('running...')}`);
    } else if (ck.outcome) {
      const ckColor =
        ck.outcome === 'conflict_found'
          ? pc.red
          : ck.outcome === 'spec_auto_fixed'
            ? pc.green
            : ck.outcome === 'spec_compressed'
              ? pc.blue
              : pc.dim;
      console.log(
        `  checkpoint: ${ckColor(ck.outcome)}${ck.progressPercent !== undefined ? ` (${ck.progressPercent}%)` : ''}`,
      );
      if (ck.summary) console.log(`    ${ckColor(ck.summary)}`);
    }
  }
}

// ============================================================================
// Handler
// ============================================================================

export async function handler(runId: string | undefined, opts: { json: boolean }, deps: CliDeps): Promise<void> {
  try {
    const { indexDb, eventLog, pidLock, state } = deps;

    if (!runId) {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log(pc.yellow('No run found for this workspace.'));
        return;
      }
      runId = row.id;
    }

    const row = await indexDb.getRun(runId);
    if (!row) {
      console.log(pc.red(`Run not found: ${runId}`));
      return;
    }

    const lock = await pidLock.read(runId);
    const matStatus = await eventLog.materializeStatus(runId, lock?.pid);
    const status = await eventLog.enrichStatus(matStatus, runId);
    const elapsedMs = Date.now() - new Date(status.startedAt).getTime();

    // Load config from config.yaml (source of truth for static config)
    let config: Config | undefined;
    try {
      const YAML = await import('yaml');
      const configContent = await state.fs.readFile(paths.runConfig(runId));
      config = parseRawConfig(YAML.parse(configContent));
    } catch {
      /* config not available */
    }

    // --json: output all loops
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            id: runId,
            workspace: row.workspace,
            status: status.status,
            loop: status.loops.length > 0 ? status.loops[status.loops.length - 1].loop : 0,
            maxIterations: config?.maxIterations,
            compressSpec: config?.compressSpec,
            synthesis: config?.synthesis,
            verify: config?.verify,
            verifyPhases: config?.verifyPhases,
            verifyTimeout: config?.verifyTimeout,
            rerankAfterCheckpoint: config?.rerankAfterCheckpoint,
            implementerRetry: config?.implementerRetry,
            firstIterationWeightMultiplier: config?.firstIterationWeightMultiplier,
            startedAt: status.startedAt,
            elapsedMs,
            exitCode: status.exitCode,
            exitReason: status.exitReason,
            failures: status.consecutiveFailures,
            failureThreshold: status.failureThreshold,
            loops: status.loops,
            lastEventIndex: status.lastEventIndex,
          },
          null,
          2,
        ),
      );
      return;
    }

    // --human
    const statusColor =
      status.status === 'running'
        ? pc.green
        : status.status === 'completed'
          ? pc.blue
          : status.status === 'cancelled'
            ? pc.yellow
            : status.status === 'crashed'
              ? pc.magenta
              : pc.red;

    const isRunning = status.status === 'running';
    const maxLoop = config?.maxIterations ?? '?';
    const multiPhase = (config?.reviewPhases as string[][])?.length > 1;

    // Header
    const startedDate = new Date(status.startedAt);
    const ageStr = formatAgeHuman(startedDate);
    const durStr = formatDurationHuman(elapsedMs);
    if (isRunning) {
      console.log(pc.bold(`Run: ${runId}  ${statusColor(`[${status.status.toUpperCase()}]`)}`));
      console.log(`  started ${ageStr}  (running for ${durStr})`);
    } else {
      const completedAge = status.lastEventAt ? formatAgeHuman(new Date(status.lastEventAt)) : '';
      console.log(pc.bold(`Run: ${runId}  ${statusColor(`[${status.status.toUpperCase()}]`)}`));
      console.log(`  started ${format(startedDate, 'MMM dd, HH:mm')}`);
      console.log(`  ran for ${durStr}${completedAge ? pc.dim(`  completed ${completedAge}`) : ''}`);
    }
    if (status.status === 'conflict') {
      console.log(pc.red(`  CONFLICT: ${status.exitReason ?? 'unknown'}`));
      const conflictPath = `${paths.runPath(runId)}/conflict.md`;
      console.log(pc.dim(`  See conflict details: ${conflictPath}`));
      console.log(pc.dim('  Resolve the conflict, then run: kloop run'));
    } else if (status.exitReason) {
      const verdictLabel =
        status.exitReason === 'consensus'
          ? pc.green('all reviewers approved')
          : status.exitReason === 'max_iterations'
            ? pc.red('max iterations reached')
            : pc.dim(status.exitReason);
      console.log(`  ${verdictLabel}`);
    }
    console.log('');

    // Config
    if (config) {
      console.log(pc.cyan('Config:'));
      const implEntries = Object.entries(config.implementers as Record<string, number>);
      if (implEntries.length === 1) {
        console.log(`  Implementer: ${shortBinary(implEntries[0][0])}`);
      } else {
        for (const [binary, weight] of implEntries) {
          console.log(`    ${shortBinary(binary)} (weight: ${weight})`);
        }
      }
      const phases = config.reviewPhases;
      if (phases?.length === 1) {
        console.log(`  Types:       ${phases[0].map(e => reviewTypeLabel(e, config.poolProfiles)).join(', ')}`);
      } else if (phases) {
        for (let i = 0; i < phases.length; i++) {
          console.log(`    Phase ${i}:    ${phases[i].map(e => reviewTypeLabel(e, config.poolProfiles)).join(', ')}`);
        }
      }
      const lenses = config.reviewLenses ?? ['general'];
      console.log(`  Lenses:      ${lenses.join(', ')}`);
      const compressLabel = config.compressSpec ? 'on' : 'off';
      const verifyLabel = config.verify ? 'on' : 'off';
      const synthesisLabel = config.synthesis ? 'on' : 'off';
      const rerankLabel = config.rerankAfterCheckpoint ? 'on' : 'off';
      const retryMax = config.implementerRetry?.maxRetries ?? 0;
      const weightMul = config.firstIterationWeightMultiplier ?? 2;
      console.log(
        `  Max: ${config.maxIterations} loops | Impl: ${config.implementerTimeout}m | Rev: ${config.reviewerTimeout}m | Compress: ${compressLabel}`,
      );
      console.log(
        `  Synthesis: ${synthesisLabel} | Verify: ${verifyLabel} | Rerank: ${rerankLabel} | Impl-retry: ${retryMax} | ::i weight: ${weightMul}x`,
      );
      console.log('');
    }

    // Failures
    const failColor =
      status.consecutiveFailures >= status.failureThreshold
        ? pc.red
        : status.consecutiveFailures > 0
          ? pc.yellow
          : pc.dim;
    console.log(`Failures: ${failColor(`${status.consecutiveFailures} / ${status.failureThreshold}`)}`);
    console.log('');

    // All iterations
    for (const loop of status.loops) {
      const isCurrent = loop === status.loops[status.loops.length - 1] && isRunning;
      const prefix = isCurrent ? '' : pc.dim('Previous — ');

      console.log(
        isCurrent
          ? pc.bold(`Iteration ${loop.loop}  ${loop.durationMs ? formatDuration(loop.durationMs) : ''}`)
          : `${prefix}${pc.dim(`Iteration ${loop.loop}  ${loop.durationMs ? formatDuration(loop.durationMs) : ''}`)}`,
      );

      renderLoopFull(loop, multiPhase);
      console.log('');
    }

    // Final verdict
    if (status.loops.length > 0 && !isRunning) {
      const lastLoop = status.loops[status.loops.length - 1];
      const hasReviewResults = lastLoop.reviewPhases.some(p => p.reviewers.length > 0);
      const rejectedByVerifyGate =
        !hasReviewResults && (lastLoop.verifyPhases?.some(p => p.reviewers.length > 0) ?? false);
      const approvedByConsensus = status.exitReason === 'consensus';

      const estimates: number[] = [];
      for (const phase of lastLoop.reviewPhases) {
        for (const r of phase.reviewers) {
          if (r.completionEstimate !== undefined) estimates.push(r.completionEstimate);
        }
      }
      const avgCompletion =
        estimates.length > 0 ? Math.round(estimates.reduce((a, b) => a + b, 0) / estimates.length) : undefined;

      if (approvedByConsensus) {
        console.log(
          `Final verdict: ${pc.green('APPROVED')}${avgCompletion !== undefined ? `  (avg ${avgCompletion}% completion)` : ''}`,
        );
      } else {
        const verdictLabel =
          status.exitReason === 'max_iterations'
            ? 'REJECTED (max iterations)'
            : rejectedByVerifyGate
              ? 'REJECTED (verify gate)'
              : 'REJECTED';
        console.log(
          `Final verdict: ${pc.red(verdictLabel)}${avgCompletion !== undefined ? `  (avg ${avgCompletion}% completion)` : ''}`,
        );
      }
      console.log('');
    }

    // Learnings
    const learningsPath = paths.runLearnings(runId);
    if (await state.fs.exists(learningsPath)) {
      const content = await state.fs.readFile(learningsPath);
      const lines = content.split('\n').filter((l: string) => l.trim() && !l.startsWith('#'));
      if (lines.length > 0) {
        console.log(pc.cyan(`Learnings (${lines.length}):`));
        for (let i = 0; i < Math.min(5, lines.length); i++) {
          console.log(`  ${pc.dim(`${i + 1}.`)} ${lines[i].replace(/^[-*]\s*/, '').slice(0, 70)}`);
        }
        if (lines.length > 5) {
          console.log(pc.dim(`  ... and ${lines.length - 5} more`));
        }
        console.log('');
      }
    }

    console.log(pc.dim('kloop status | kloop view | kloop logs | kloop metrics'));
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
