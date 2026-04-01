import pc from 'picocolors';
import { format } from 'date-fns';
import type { CliDeps } from './index';
import type { LoopSummary } from '../types';
import { paths } from '../deps';
import { formatDurationHuman } from '../loop/format';
import { shortBinary, loadLoopSummaries } from './shared';

// ============================================================================
// Data-driven summary (fallback when LLM is unavailable)
// ============================================================================

function buildDataSummary(
  runId: string,
  startedAt: string,
  status: string,
  exitReason: string | undefined,
  maxIterations: number | undefined,
  summaries: LoopSummary[],
  learnings: string | null,
): string {
  const startDate = new Date(startedAt);
  const startedStr = format(startDate, 'MMM dd, HH:mm');
  const totalDurationMs = summaries.reduce((sum, s) => sum + s.durationMs, 0);
  const durationStr = formatDurationHuman(totalDurationMs);
  const lastSummary = summaries[summaries.length - 1];
  const completedStr = lastSummary ? format(new Date(startDate.getTime() + totalDurationMs), 'MMM dd, HH:mm') : '';
  const verdict =
    exitReason === 'consensus'
      ? 'approved (consensus)'
      : exitReason === 'max_iterations'
        ? 'max iterations reached'
        : (exitReason ?? status);

  let md = `# Run Summary: ${runId}\n\n`;
  md += `## Overview\n`;
  md += `- **Status**: ${status} (${verdict})\n`;
  md += `- **Duration**: ${durationStr}\n`;
  md += `- **Iterations**: ${summaries.length}${maxIterations ? ` / ${maxIterations}` : ''}\n`;
  md += `- **Started**: ${startedStr}\n`;
  if (completedStr) md += `- **Completed**: ${completedStr}\n`;
  md += '\n';

  for (const summary of summaries) {
    md += `## Iteration ${summary.loop} (${formatDurationHuman(summary.durationMs)})\n\n`;
    const impl = summary.implementer;
    const implStatus = impl.exitCode === 0 ? 'success' : `exit ${impl.exitCode}`;
    md += `**Implementer** (${shortBinary(impl.binary)}): ${implStatus}, ${formatDurationHuman(impl.durationMs)}\n\n`;

    for (const phase of summary.reviewPhases) {
      for (const r of phase.reviewers) {
        const vLabel = r.verdict ?? 'no verdict';
        const comp = r.completionEstimate !== undefined ? `, ${r.completionEstimate}% complete` : '';
        const note = r.timedOut ? ' (timed out)' : r.error ? ` (${r.error})` : '';
        md += `**Review** (${shortBinary(r.binary)}): ${vLabel}${comp}${note}, ${formatDurationHuman(r.durationMs)}\n`;
        if (r.reasoning) {
          md += `> ${r.reasoning.replace(/\n/g, '\n> ')}\n`;
        }
        md += '\n';
      }
    }

    if (summary.checkpoint) {
      const ck = summary.checkpoint;
      const ckLabel = `${ck.outcome}${ck.progressPercent !== undefined ? ` — ${ck.progressPercent}% progress` : ''}`;
      md += `**Checkpoint**: ${ckLabel}\n`;
      if (ck.summary) md += `> ${ck.summary.replace(/\n/g, '\n> ')}\n`;
      md += '\n';
    }
    md += '\n';
  }

  if (learnings) {
    const lines = learnings.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    if (lines.length > 0) {
      md += `## Learnings\n\n`;
      for (const line of lines) {
        md += `- ${line.replace(/^[-*]\s*/, '')}\n`;
      }
      md += '\n';
    }
  }

  return md;
}

// ============================================================================
// LLM-evaluated summary
// ============================================================================

function buildSummaryPrompt(
  runId: string,
  startedAt: string,
  status: string,
  exitReason: string | undefined,
  maxIterations: number | undefined,
  summaries: LoopSummary[],
  learnings: string | null,
  spec: string | null,
): string {
  const startDate = new Date(startedAt);
  const startedStr = format(startDate, 'MMM dd, HH:mm');
  const totalDurationMs = summaries.reduce((sum, s) => sum + s.durationMs, 0);
  const durationStr = formatDurationHuman(totalDurationMs);
  const lastSummary = summaries[summaries.length - 1];
  const completedStr = lastSummary ? format(new Date(startDate.getTime() + totalDurationMs), 'MMM dd, HH:mm') : '';
  const verdict =
    exitReason === 'consensus'
      ? 'approved (consensus)'
      : exitReason === 'max_iterations'
        ? 'max iterations reached'
        : (exitReason ?? status);

  let prompt = `You are generating a run summary for an automated development loop. Based on the data below, write a concise narrative summary in markdown format.

The summary should:
1. Start with an Overview section (status, duration, iterations, started/completed dates)
2. For each iteration, write a short narrative paragraph describing what the implementer did, what reviewers found, and any checkpoint outcomes. Use the reviewer reasoning text to understand what was accomplished.
3. Keep each iteration to 2-4 sentences.
4. End with a Learnings section if there are any.

# Run Data
- **Run ID**: ${runId}
- **Status**: ${status} (${verdict})
- **Duration**: ${durationStr}
- **Iterations**: ${summaries.length}${maxIterations ? ` / ${maxIterations}` : ''}
- **Started**: ${startedStr}${completedStr ? `\n- **Completed**: ${completedStr}` : ''}

# Loop Iteration Data
`;

  for (const summary of summaries) {
    prompt += `\n## Iteration ${summary.loop} (${formatDurationHuman(summary.durationMs)})\n\n`;

    const impl = summary.implementer;
    const implStatus = impl.exitCode === 0 ? 'success' : `failed (exit ${impl.exitCode})`;
    prompt += `**Implementer** (${shortBinary(impl.binary)}): ${implStatus}, ${formatDurationHuman(impl.durationMs)}\n`;

    for (const phase of summary.reviewPhases) {
      for (const r of phase.reviewers) {
        const vLabel = r.verdict ?? 'no verdict';
        const comp = r.completionEstimate !== undefined ? `, ${r.completionEstimate}% complete` : '';
        const note = r.timedOut ? ' (timed out)' : r.error ? ` (${r.error})` : '';
        prompt += `**Review** (${shortBinary(r.binary)}): ${vLabel}${comp}${note}, ${formatDurationHuman(r.durationMs)}\n`;
        if (r.reasoning) {
          prompt += `Reasoning: ${r.reasoning}\n`;
        }
      }
    }

    if (summary.checkpoint) {
      const ck = summary.checkpoint;
      prompt += `\n**Checkpoint**: ${ck.outcome}${ck.progressPercent !== undefined ? ` (${ck.progressPercent}% progress)` : ''}\n`;
      if (ck.summary) prompt += `Summary: ${ck.summary}\n`;
    }
  }

  if (learnings) {
    prompt += `\n# Learnings\n${learnings}\n`;
  }

  if (spec) {
    prompt += `\n# Spec\n${spec}\n`;
  }

  prompt += `\nGenerate the summary markdown now. Start with "# Run Summary: ${runId}". Do not wrap in code fences.`;

  return prompt;
}

async function generateLlmSummary(binary: string, prompt: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([binary, '--print', '--dangerously-skip-permissions'], {
      cwd: process.cwd(),
      stdin: Buffer.from(prompt),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [output, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      if (process.env.DEBUG) console.error(pc.dim(`LLM summary failed (exit ${exitCode}): ${stderr.slice(0, 200)}`));
      return null;
    }

    return output.trim();
  } catch (err) {
    if (process.env.DEBUG) console.error(pc.dim(`LLM summary error: ${(err as Error).message}`));
    return null;
  }
}

// ============================================================================
// Handler
// ============================================================================

export async function handler(
  id: string | undefined,
  opts: { force: boolean; run?: string },
  deps: CliDeps,
): Promise<void> {
  try {
    const { indexDb, eventLog, pidLock, state } = deps;

    // Resolve run ID: --run > positional [id] > workspace lookup
    let runId = opts.run ?? id;
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
    const runState = await eventLog.deriveStatus(runId, lock?.pid);

    const summaries = await loadLoopSummaries(runId, state.fs);
    if (summaries.length === 0) {
      console.log(pc.yellow('No loop summaries found for this run.'));
      return;
    }

    const summaryPath = `${paths.runPath(runId)}/summary.md`;
    const exists = await state.fs.exists(summaryPath);

    if (exists && !opts.force) {
      const content = await state.fs.readFile(summaryPath);
      console.log(content);
      console.log(pc.dim(`\n(summary already exists — use --force to regenerate)`));
      return;
    }

    // Load learnings
    let learnings: string | null = null;
    const learningsPath = paths.runLearnings(runId);
    if (await state.fs.exists(learningsPath)) {
      learnings = await state.fs.readFile(learningsPath);
    }

    // Load spec
    let spec: string | null = null;
    const specPath = paths.runSpec(runId);
    if (await state.fs.exists(specPath)) {
      spec = await state.fs.readFile(specPath);
    }

    const startedAt = runState?.startedAt ?? row.started_at;
    const status = runState?.status ?? 'unknown';
    const exitReason = runState?.exitReason;
    const maxIterations = runState?.config?.maxIterations;
    const config = runState?.config;

    // Try LLM-evaluated summary first
    let md: string | null = null;
    if (config) {
      const implBinary = Object.keys(config.implementers)[0];
      console.log(pc.dim(`Generating LLM-evaluated summary via ${shortBinary(implBinary)}...`));

      const prompt = buildSummaryPrompt(
        runId,
        startedAt,
        status,
        exitReason,
        maxIterations,
        summaries,
        learnings,
        spec,
      );
      md = await generateLlmSummary(implBinary, prompt);

      if (md) {
        console.log(pc.dim('LLM summary generated successfully.'));
      } else {
        console.log(pc.yellow('LLM summary failed, falling back to data-driven summary.'));
      }
    }

    // Fallback to data-driven summary
    if (!md) {
      md = buildDataSummary(runId, startedAt, status, exitReason, maxIterations, summaries, learnings);
    }

    // Save
    await state.fs.writeFile(summaryPath, md);
    console.log(md);
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
