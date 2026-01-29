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
  lines.push('');

  for (const sum of entry.summary) {
    lines.push(`  Iteration ${sum.iteration}:`);
    lines.push(`    Duration: ${Math.round(sum.implementerDuration / 1000)}s`);

    const verdicts = sum.reviewerVerdicts
      .map(v => `${v.verdict === 'approved' ? pc.green('✓') : pc.red('✗')}`)
      .join(' ');
    lines.push(`    Verdicts: ${verdicts}`);

    if (sum.learnings.length > 0) {
      lines.push(`    Learnings: ${sum.learnings.length}`);
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
      return `${e.id}  ${date}  ${status}  ${e.iterations} iterations`;
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
    default:
      return status;
  }
}
