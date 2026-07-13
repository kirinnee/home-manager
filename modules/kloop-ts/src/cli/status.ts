import pc from 'picocolors';
import { format } from 'date-fns';
import { reapDeadRun } from '../index-db';
import type { CliDeps } from './index';
import type {
  MaterializedStatus,
  MaterializedLoop,
  MaterializedAgentState,
  MaterializedReviewPhase,
  Config,
} from '../types';
import { parseRawConfig, reviewTypeLabel } from '../types';
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
const ROLE_W = 8;

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

function renderLoop(loop: MaterializedLoop, multiPhase: boolean, dimmed: boolean): void {
  const prefix = dimmed ? pc.dim : (s: string) => s;

  // Implementer — green dot for running/exit 0, red dot for non-zero
  if (loop.implementer) {
    const impl = loop.implementer;
    const errNote = impl.error ? pc.yellow(` ${impl.error}`) : '';
    const retryNote =
      impl.retryAttempt !== undefined && impl.retryAttempt > 0
        ? pc.yellow(` retry ${impl.retryAttempt}/${impl.retryMax ?? '?'}`)
        : '';
    if (impl.status === 'running') {
      console.log(
        prefix(fmtRow('impl', agentLabel(impl), agentDuration(impl), `${pc.green('●')} running${retryNote}`)),
      );
    } else if (impl.status === 'pending') {
      console.log(prefix(fmtRow('impl', pc.dim('...'), '', pc.dim('pending'))));
    } else {
      const dot = impl.exitCode === 0 ? pc.green('●') : pc.red('●');
      console.log(prefix(fmtRow('impl', agentLabel(impl), agentDuration(impl), `${dot}${errNote}${retryNote}`)));
    }
  }

  // Verify phases (before review — spec lifecycle: impl → verify → review → synthesis → checkpoint)
  for (const phase of loop.verifyPhases ?? []) {
    for (const r of phase.reviewers) {
      const errNote = r.error ? pc.yellow(` ${r.error}`) : '';
      if (r.status === 'running' || r.status === 'pending') {
        const elapsed = r.startedAt ? formatDuration(Date.now() - new Date(r.startedAt).getTime()) : '';
        console.log(
          prefix(
            fmtRow(
              'verify',
              agentLabel(r),
              elapsed,
              `${pc.dim(r.status)}${r.verdict ? `  ${verdictMark(r.verdict)}` : ''}${errNote}`,
            ),
          ),
        );
      } else {
        console.log(
          prefix(
            fmtRow(
              'verify',
              agentLabel(r),
              agentDuration(r),
              `${verdictMark(r.verdict)}  ${statusMark(agentOk(r))}${errNote}`,
            ),
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
      const errNote = r.error ? pc.yellow(` ${r.error}`) : '';
      // Matrix: prefix the label with the lens so each lens × type review is distinct.
      const label = r.lens ? `${pc.cyan(r.lens)} ${agentLabel(r)}` : agentLabel(r);

      if (r.status === 'running' || r.status === 'pending') {
        const elapsed = r.startedAt ? formatDuration(Date.now() - new Date(r.startedAt).getTime()) : '';
        const propMark = r.propagated ? pc.cyan('*') : '';
        console.log(
          prefix(
            fmtRow(
              role,
              label,
              elapsed,
              `${pc.dim(r.status)}${r.verdict ? `  ${verdictMark(r.verdict)}` : ''}${pct ? `  ${pct}` : ''}${propMark ? `  ${propMark}` : ''}`,
            ),
          ),
        );
      } else {
        const propMark = r.propagated ? pc.cyan('*') : '';
        console.log(
          prefix(
            fmtRow(
              role,
              label,
              agentDuration(r),
              `${verdictMark(r.verdict)}  ${statusMark(agentOk(r))}${pct ? `  ${pc.dim(pct)}` : ''}${errNote}${propMark ? `  ${propMark}` : ''}`,
            ),
          ),
        );
      }
    }
  }

  // Synthesis
  if (loop.synthesis) {
    const synth = loop.synthesis;
    if (synth.status === 'running') {
      console.log(prefix(`  synthesis: ${pc.dim('running...')}`));
    } else if (synth.status === 'completed') {
      console.log(prefix(`  synthesis: ${pc.green('done')}${synth.summaryPath ? ` → ${synth.summaryPath}` : ''}`));
    } else if (synth.status === 'error') {
      console.log(prefix(`  synthesis: ${pc.red('failed')}${synth.error ? ` (${synth.error})` : ''}`));
    }
  }

  // Checkpoint
  if (loop.checkpoint) {
    const ck = loop.checkpoint;
    if (ck.status === 'running') {
      console.log(pc.dim(`  checkpoint: running...`));
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
        pc.dim(
          `  checkpoint: ${ckColor(ck.outcome)}${ck.progressPercent !== undefined ? ` (${ck.progressPercent}%)` : ''}`,
        ),
      );
      if (ck.summary) console.log(pc.dim(`    ${ckColor(ck.summary)}`));
    }
  }
}

// ============================================================================
// Handler
// ============================================================================

export async function handler(id: string | undefined, opts: { json: boolean }, deps: CliDeps): Promise<void> {
  try {
    const { indexDb, eventLog, pidLock, state } = deps;

    let runId = id;
    if (!runId) {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log(pc.yellow('No active run for this workspace.'));
        return;
      }
      runId = row.id;
    }

    const lock = await pidLock.read(runId);
    const matStatus = await eventLog.materializeStatus(runId, lock?.pid);

    if (matStatus.status === 'crashed') {
      await reapDeadRun(runId, deps.eventLog, deps.pidLock, deps.tmux);
    }

    // Enrich with verdict files and summary data
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

    // --json: output latest 2 loops
    if (opts.json) {
      const latestLoops = status.loops.slice(-2);
      console.log(
        JSON.stringify(
          {
            id: runId,
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
            // Implementer stall detection (absent unless currently stalled)
            ...(status.stalled
              ? {
                  stalled: true,
                  stalledSinceMs: status.stalledSinceMs,
                  stallReason: status.stallReason,
                  stallDialogText: status.stallDialogText,
                }
              : {}),
            loops: latestLoops,
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
    const lastLoop = status.loops[status.loops.length - 1];
    const currentLoop1 = lastLoop?.loop ?? 0;
    const maxLoop = config?.maxIterations ?? '?';
    const multiPhase = (config?.reviewPhases?.length ?? 0) > 1;

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
    if (status.stalled) {
      const stalledFor = status.stalledSinceMs ? formatDurationHuman(Date.now() - status.stalledSinceMs) : '?';
      console.log(pc.red(`  ⚠ STALLED (${status.stallReason ?? 'idle'}) for ${stalledFor}`));
      if (status.stallDialogText) {
        for (const line of status.stallDialogText.split('\n').slice(-6)) {
          console.log(pc.dim(`  │ ${line}`));
        }
      }
      const implSession = lastLoop ? `kloop-${runId}-${lastLoop.loop}-impl` : null;
      if (implSession) {
        console.log(pc.dim(`  Answer it: tmux attach -t ${implSession}`));
      }
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

    // Config (compact)
    if (config) {
      const impls = Object.entries(config.implementers as Record<string, number>);
      const implStr = impls.map(([b, w]) => (w > 1 ? `${shortBinary(b)}:${w}` : shortBinary(b))).join(', ');
      const phases = config.reviewPhases;
      const phaseCount = phases?.length ?? 1;
      const numTypes = phases?.flat().length ?? 0;
      const numLenses = config.reviewLenses?.length ?? 1;
      const revCount = numTypes * numLenses;
      const lensSuffix = numLenses > 1 ? ` (${numTypes} types × ${numLenses} lenses)` : '';
      const compressLabel = config.compressSpec ? 'on' : 'off';
      const synthesisLabel = config.synthesis ? 'on' : 'off';
      const verifyLabel = config.verify ? 'on' : 'off';
      const rerankLabel = config.rerankAfterCheckpoint ? 'on' : 'off';
      const retryMax = config.implementerRetry?.maxRetries ?? 0;
      console.log(
        pc.dim(
          `Impl: ${implStr}  |  ${revCount} reviews${lensSuffix} in ${phaseCount} phase${phaseCount > 1 ? 's' : ''}  |  max ${config.maxIterations} loops  |  compress: ${compressLabel}`,
        ),
      );
      console.log(
        pc.dim(
          `synthesis: ${synthesisLabel}  |  verify: ${verifyLabel}  |  rerank: ${rerankLabel}  |  impl-retry: ${retryMax}`,
        ),
      );
      // Show config review phases (types, pool-safe)
      for (let i = 0; i < phaseCount; i++) {
        const phaseRevs = (phases[i] ?? []).map(e => reviewTypeLabel(e, config.poolProfiles)).join(', ');
        console.log(pc.dim(`  phase ${i}: [${phaseRevs}]`));
      }
      // Show reranked phases if the distinct TYPES per phase differ from config
      if (config.rerankAfterCheckpoint && lastLoop && lastLoop.reviewPhases.length > 0) {
        const actualPhases = lastLoop.reviewPhases.map(p => [
          ...new Set(p.reviewers.map(r => r.reviewType ?? shortBinary(r.binary))),
        ]);
        const configPhases = phases.map(p => p.map(e => reviewTypeLabel(e, config.poolProfiles)));
        const phasesChanged = JSON.stringify(actualPhases) !== JSON.stringify(configPhases);
        if (phasesChanged) {
          console.log(pc.dim('  reranked:'));
          for (let i = 0; i < actualPhases.length; i++) {
            console.log(pc.dim(`    phase ${i}: [${(actualPhases[i] ?? []).join(', ')}]`));
          }
        }
      }
      console.log('');
    }

    // Failures
    const failColor =
      status.consecutiveFailures >= status.failureThreshold
        ? pc.red
        : status.consecutiveFailures > 0
          ? pc.yellow
          : pc.dim;
    console.log(pc.dim(`Failures: ${failColor(`${status.consecutiveFailures} / ${status.failureThreshold}`)}`));

    // Current iteration
    if (lastLoop) {
      // Derive phase label from materialized state (only for running runs)
      let phaseLabel = '';
      if (isRunning) {
        if (lastLoop.checkpoint?.status === 'running') {
          phaseLabel = pc.dim('  checkpointing');
        } else if (lastLoop.synthesis?.status === 'running') {
          phaseLabel = pc.dim('  synthesizing');
        } else if (lastLoop.reviewPhases.length > 0 && !lastLoop.completedAt) {
          phaseLabel = pc.dim('  reviewing');
        } else if ((lastLoop.verifyPhases?.length ?? 0) > 0 && !lastLoop.completedAt) {
          phaseLabel = pc.dim('  verifying');
        } else if (
          lastLoop.implementer &&
          (lastLoop.implementer.status === 'running' || lastLoop.implementer.status === 'pending')
        ) {
          phaseLabel = pc.dim('  implementing');
        }
      }

      let currentElapsed = '';
      if (lastLoop.durationMs) {
        currentElapsed = pc.dim(`  ${formatDuration(lastLoop.durationMs)}`);
      } else if (lastLoop.startedAt) {
        currentElapsed = pc.dim(`  ${formatDuration(Date.now() - new Date(lastLoop.startedAt).getTime())}`);
      }

      console.log('');
      console.log(pc.bold(`Iteration ${currentLoop1} / ${maxLoop}${phaseLabel}${currentElapsed}`));
      renderLoop(lastLoop, multiPhase, false);
    }

    // Previous iteration (dimmed) — only the one before current
    if (status.loops.length >= 2) {
      const prev = status.loops[status.loops.length - 2];
      console.log('');
      console.log(
        pc.dim(`Previous — Iteration ${prev.loop}  ${prev.durationMs ? formatDuration(prev.durationMs) : ''}`),
      );
      renderLoop(prev, multiPhase, true);
    }

    console.log('');

    // Learnings
    const learningsPath = paths.runLearnings(runId);
    if (await state.fs.exists(learningsPath)) {
      const content = await state.fs.readFile(learningsPath);
      const lines = content.split('\n').filter((l: string) => l.trim() && !l.startsWith('#'));
      if (lines.length > 0) {
        console.log(pc.cyan(`Learnings (${lines.length}):`));
        for (let i = 0; i < Math.min(3, lines.length); i++) {
          console.log(`  ${pc.dim(`${i + 1}.`)} ${lines[i].replace(/^[-*]\s*/, '').slice(0, 70)}`);
        }
        if (lines.length > 3) {
          console.log(pc.dim(`  ... and ${lines.length - 3} more`));
        }
        console.log('');
      }
    }

    console.log(pc.dim('kloop describe | kloop view | kloop logs | kloop metrics'));
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
