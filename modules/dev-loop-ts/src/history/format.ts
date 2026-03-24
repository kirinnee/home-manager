import type { HistoryEntry } from '../types';
import { format } from 'date-fns';
import pc from 'picocolors';

export function formatHistoryEntry(entry: HistoryEntry): string {
  const lines: string[] = [];

  lines.push(pc.bold(`Run: ${entry.id}`));
  lines.push(`  Status: ${formatStatus(entry.status)}`);
  lines.push(`  Iterations: ${entry.iterations}`);
  lines.push(`  Started: ${format(new Date(entry.startedAt), 'yyyy-MM-dd HH:mm:ss')}`);
  lines.push(`  Completed: ${format(new Date(entry.completedAt), 'yyyy-MM-dd HH:mm:ss')}`);
  if (entry.checkpointRan) {
    lines.push(`  Checkpoint ran: ${pc.cyan('yes')}`);
  }

  // Show metrics summary if available
  if (entry.metricsSummary) {
    const ms = entry.metricsSummary;
    const durationMins = Math.round(ms.totalDurationMs / 60000);
    const durationSecs = Math.round((ms.totalDurationMs % 60000) / 1000);
    const totalTokens = ms.totalInputTokens + ms.totalOutputTokens;
    lines.push(`  Duration: ${durationMins}m ${durationSecs}s`);
    if (totalTokens > 0) {
      lines.push(
        `  Tokens: ${totalTokens.toLocaleString()} (${ms.totalInputTokens.toLocaleString()} in / ${ms.totalOutputTokens.toLocaleString()} out)`,
      );
    }
  }

  lines.push('');

  for (const sum of entry.summary) {
    lines.push(`  Iteration ${sum.iteration}:`);
    lines.push(`    Duration: ${Math.round(sum.implementerDuration / 1000)}s`);

    const verdicts = sum.reviewerVerdicts
      .map(v => {
        const verdict = v.verdict === 'approved' ? pc.green('✓') : pc.red('✗');
        const binary = v.binary ? ` (${v.binary})` : '';
        return `${verdict}${binary}`;
      })
      .join(' ');
    lines.push(`    Verdicts: ${verdicts}`);

    if (sum.learnings.length > 0) {
      lines.push(`    Learnings: ${sum.learnings.length}`);
    }

    if (sum.checkpointInfo) {
      const outcomeColors: Record<string, (s: string) => string> = {
        conflict_found: pc.red,
        spec_auto_fixed: pc.green,
        spec_compressed: pc.blue,
        no_action: pc.dim,
      };
      const colorFn = outcomeColors[sum.checkpointInfo.outcome] || pc.dim;
      lines.push(`    Checkpoint: ${colorFn(sum.checkpointInfo.outcome)}`);
      if (sum.checkpointInfo.progressPercent !== undefined) {
        lines.push(`      Progress: ${sum.checkpointInfo.progressPercent}%`);
      }
    }
  }

  return lines.join('\n');
}

export function formatHistoryList(entries: HistoryEntry[]): string {
  if (entries.length === 0) {
    return 'No history entries.';
  }

  return entries
    .map(e => {
      const date = format(new Date(e.startedAt), 'MM-dd HH:mm');
      const status = formatStatus(e.status);
      const checkpoint = e.checkpointRan ? pc.cyan(' ⚡') : '';
      let metricsInfo = '';
      if (e.metricsSummary) {
        const totalTokens = e.metricsSummary.totalInputTokens + e.metricsSummary.totalOutputTokens;
        if (totalTokens > 0) {
          metricsInfo = pc.dim(` ${totalTokens.toLocaleString()} tokens`);
        }
      }
      return `${e.id}  ${date}  ${status}  ${e.iterations} iterations${checkpoint}${metricsInfo}`;
    })
    .join('\n');
}

function formatStatus(status: string): string {
  switch (status) {
    case 'completed':
      return pc.green('completed');
    case 'cancelled':
      return pc.yellow('cancelled');
    case 'failed':
      return pc.red('failed');
    case 'conflict':
      return pc.red('conflict');
    default:
      return status;
  }
}
