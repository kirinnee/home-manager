import pc from 'picocolors';
import type { LoopSummary } from '../types';
import { paths } from '../deps';

// ============================================================================
// Shared CLI utilities — deduplicated from describe, status, summary, review
// ============================================================================

const CLAUDE_AUTO_PREFIX = 'claude-auto-';

export function shortBinary(binary: string, harness?: string): string {
  const name = binary.startsWith(CLAUDE_AUTO_PREFIX) ? binary.slice(CLAUDE_AUTO_PREFIX.length) : binary;
  if (harness && harness !== 'claude') return `${name}:${harness}`;
  return name;
}

export async function loadLoopSummaries(
  runId: string,
  fs: {
    exists(p: string): Promise<boolean>;
    readJson<T>(p: string): Promise<T | null>;
    readdir(p: string): Promise<string[]>;
  },
): Promise<LoopSummary[]> {
  const runDir = paths.runPath(runId);
  const summaries: LoopSummary[] = [];
  try {
    const entries = await fs.readdir(runDir);
    const loopDirs = entries
      .map(e => ({ match: e.match(/^loop-(\d+)$/), name: e }))
      .filter(e => e.match)
      .sort((a, b) => parseInt(a.match![1], 10) - parseInt(b.match![1], 10));

    for (const { match } of loopDirs) {
      const loopNum = parseInt(match![1], 10);
      const summaryPath = paths.loopSummaryJson(runId, loopNum);
      if (await fs.exists(summaryPath)) {
        const summary = await fs.readJson<LoopSummary>(summaryPath);
        if (summary) summaries.push(summary);
      }
    }
  } catch {}
  return summaries;
}

export function verdictMark(verdict?: string): string {
  if (verdict === 'approved') return pc.green('\u2713');
  if (verdict === 'rejected') return pc.red('\u2717');
  return pc.dim('·');
}
