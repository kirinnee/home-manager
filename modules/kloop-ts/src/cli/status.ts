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
import { paths } from '../deps';
import { formatDurationHuman, formatAgeHuman } from '../loop/format';

const CLAUDE_AUTO_PREFIX = 'claude-auto-';

function shortBinary(binary: string, harness?: string): string {
  const name = binary.startsWith(CLAUDE_AUTO_PREFIX) ? binary.slice(CLAUDE_AUTO_PREFIX.length) : binary;
  if (harness && harness !== 'claude') return `${name}:${harness}`;
  return name;
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
    if (impl.status === 'running') {
      console.log(prefix(fmtRow('impl', agentLabel(impl), agentDuration(impl), `${pc.green('●')} running`)));
    } else if (impl.status === 'pending') {
      console.log(prefix(fmtRow('impl', pc.dim('...'), '', pc.dim('pending'))));
    } else {
      const dot = impl.exitCode === 0 ? pc.green('●') : pc.red('●');
      console.log(prefix(fmtRow('impl', agentLabel(impl), agentDuration(impl), `${dot}${errNote}`)));
    }
  }

  // Review phases
  for (const phase of loop.reviewPhases) {
    const role = multiPhase ? `phase ${phase.phase}` : 'review';
    for (const r of phase.reviewers) {
      const pct = r.completionEstimate !== undefined ? `${r.completionEstimate}%` : '';
      const errNote = r.error ? pc.yellow(` ${r.error}`) : '';

      if (r.status === 'running' || r.status === 'pending') {
        const elapsed = r.startedAt ? formatDuration(Date.now() - new Date(r.startedAt).getTime()) : '';
        const propMark = r.propagated ? pc.cyan('*') : '';
        console.log(
          prefix(
            fmtRow(
              role,
              agentLabel(r),
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
              agentLabel(r),
              agentDuration(r),
              `${verdictMark(r.verdict)}  ${statusMark(agentOk(r))}${pct ? `  ${pc.dim(pct)}` : ''}${errNote}${propMark ? `  ${propMark}` : ''}`,
            ),
          ),
        );
      }
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
      config = YAML.parse(configContent) as Config;
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
            startedAt: status.startedAt,
            elapsedMs,
            exitCode: status.exitCode,
            exitReason: status.exitReason,
            failures: status.consecutiveFailures,
            failureThreshold: status.failureThreshold,
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

    // Config (compact)
    if (config) {
      const impls = Object.entries(config.implementers as Record<string, number>);
      const implStr = impls.map(([b, w]) => (w > 1 ? `${shortBinary(b)}:${w}` : shortBinary(b))).join(', ');
      const phases = config.reviewPhases as string[][];
      const phaseCount = phases?.length ?? 1;
      const revCount = phases?.flat().length ?? 0;
      const compressLabel = config.compressSpec ? 'on' : 'off';
      console.log(
        pc.dim(
          `Impl: ${implStr}  |  ${revCount} reviewers in ${phaseCount} phase${phaseCount > 1 ? 's' : ''}  |  max ${config.maxIterations} loops  |  compress: ${compressLabel}`,
        ),
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
    console.log(pc.dim(`Failures: ${failColor(`${status.consecutiveFailures} / ${status.failureThreshold}`)}`));

    // Current iteration
    if (lastLoop) {
      // Derive phase label from materialized state (only for running runs)
      let phaseLabel = '';
      if (isRunning) {
        if (lastLoop.checkpoint?.status === 'running') {
          phaseLabel = pc.dim('  checkpointing');
        } else if (lastLoop.reviewPhases.length > 0 && !lastLoop.completedAt) {
          phaseLabel = pc.dim('  reviewing');
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
      const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
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
