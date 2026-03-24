import pc from 'picocolors';
import type { HistoryService, LogsService } from '../deps';

export async function listHandler(history: HistoryService, logs?: LogsService): Promise<void> {
  try {
    const entries = await history.list();

    if (entries.length === 0) {
      console.log(pc.yellow('No run history found.'));
      return;
    }

    const runsWithLogs = logs ? new Set(await logs.listRuns()) : new Set<string>();

    console.log(pc.bold('Run History'));
    console.log('');

    for (const entry of entries) {
      const hasLogs = runsWithLogs.has(entry.id);
      const logsIndicator = hasLogs ? pc.dim(' [logs]') : '';
      const status =
        entry.status === 'completed' ? pc.green('✓') : entry.status === 'cancelled' ? pc.yellow('○') : pc.red('✗');
      console.log(
        `${status} ${entry.id}${logsIndicator} - ${entry.iterations} iter(s) - ${entry.startedAt.slice(0, 10)}`,
      );
    }

    console.log('');
    console.log(pc.dim('Use "dev-loop history show <runId>" for details'));
    console.log(pc.dim('Use "dev-loop logs" to view logs'));
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

export async function showHandler(runId: string, history: HistoryService, logs?: LogsService): Promise<void> {
  try {
    const entry = await history.load(runId);

    if (!entry) {
      console.log(pc.yellow(`Run ${runId} not found in history.`));
      return;
    }

    const runLogs = logs ? await logs.listLogs(runId) : [];
    const hasLogs = runLogs.length > 0;

    console.log(pc.bold(`Run ${entry.id}`));
    console.log(`Status: ${entry.status}`);
    console.log(`Started: ${entry.startedAt}`);
    console.log(`Completed: ${entry.completedAt}`);
    console.log(`Iterations: ${entry.iterations}`);
    if (entry.metricsSummary) {
      const ms = entry.metricsSummary;
      const durationMins = Math.round(ms.totalDurationMs / 60000);
      const durationSecs = Math.round((ms.totalDurationMs % 60000) / 1000);
      const totalTokens = ms.totalInputTokens + ms.totalOutputTokens;
      console.log(`Duration: ${durationMins}m ${durationSecs}s`);
      if (totalTokens > 0) {
        console.log(
          `Tokens: ${totalTokens.toLocaleString()} (${ms.totalInputTokens.toLocaleString()} in / ${ms.totalOutputTokens.toLocaleString()} out)`,
        );
      }
    }
    if (hasLogs) {
      console.log(`Logs: ${pc.green(`${runLogs.length} file(s) available`)}`);
    }
    console.log('');

    console.log(pc.cyan('Iterations:'));
    for (const iter of entry.summary) {
      console.log(`  #${iter.iteration}:`);
      if (iter.implementerDuration) {
        console.log(`    Duration: ${Math.round(iter.implementerDuration / 1000)}s`);
      }
      console.log(`    Verdicts:`);
      for (const v of iter.reviewerVerdicts) {
        const icon = v.verdict === 'approved' ? pc.green('✓') : pc.red('✗');
        const binaryLabel = v.binary ? pc.dim(` (${v.binary})`) : '';
        console.log(`      ${icon} reviewer ${v.index}${binaryLabel}`);
      }
      if (iter.learnings.length > 0) {
        console.log(`    Learnings: ${iter.learnings.join('; ')}`);
      }
    }

    if (hasLogs) {
      console.log('');
      console.log(pc.dim(`View logs: dev-loop logs`));
    }
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

export async function clearHandler(history: HistoryService): Promise<void> {
  try {
    await history.clear();
    console.log(pc.green('History cleared.'));
    console.log(pc.dim('Note: Logs are preserved. Use "dev-loop logs clear" to remove logs.'));
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
