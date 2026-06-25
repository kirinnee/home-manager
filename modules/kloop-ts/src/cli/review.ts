import pc from 'picocolors';
import type { CliDeps } from './index';
import { formatDurationHuman } from '../loop/format';
import { shortBinary, loadLoopSummaries, verdictMark } from './shared';

export async function handler(id: string | undefined, opts: { run?: string }, deps: CliDeps): Promise<void> {
  try {
    const { indexDb, state } = deps;

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

    const summaries = await loadLoopSummaries(runId, state.fs);
    if (summaries.length === 0) {
      console.log(pc.yellow('No loop summaries found for this run.'));
      return;
    }

    console.log(pc.bold(`Run ${runId} — Review Verdicts\n`));

    for (const summary of summaries) {
      console.log(pc.bold(`Iteration ${summary.loop}`) + pc.dim(` (${formatDurationHuman(summary.durationMs)})`));

      const impl = summary.implementer;
      const implStatus = impl.exitCode === 0 ? pc.green('success') : pc.red(`exit ${impl.exitCode}`);
      const implModel = impl.model ? pc.dim(` (${impl.model})`) : '';
      console.log(
        `  ${pc.dim('impl')}  ${shortBinary(impl.binary)}${implModel}  ${implStatus}  ${formatDurationHuman(impl.durationMs)}`,
      );

      for (const phase of summary.reviewPhases) {
        for (const r of phase.reviewers) {
          const mark = verdictMark(r.verdict);
          const comp = r.completionEstimate !== undefined ? ` ${r.completionEstimate}% done` : '';
          const note = r.timedOut ? pc.yellow(' (timed out)') : r.error ? pc.red(` (${r.error})`) : '';
          const revModel = r.model ? pc.dim(` (${r.model})`) : '';
          console.log(
            `  ${mark} ${pc.dim('rev')}  ${shortBinary(r.binary)}${revModel}  ${formatDurationHuman(r.durationMs)}${comp}${note}`,
          );
          if (r.reasoning) {
            const lines = r.reasoning.split('\n');
            for (const line of lines) {
              console.log(pc.dim(`      │ ${line}`));
            }
          }
        }
      }

      console.log('');
    }
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
