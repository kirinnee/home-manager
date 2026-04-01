import pc from 'picocolors';
import type { LoopSummary, KloopEvent } from '../types';
import { EVENT_TYPES } from '../types';
import { paths } from '../deps';

// ============================================================================
// Shared CLI utilities — deduplicated from describe, status, summary, review
// ============================================================================

const CLAUDE_AUTO_PREFIX = 'claude-auto-';

export function shortBinary(binary: string): string {
  return binary.startsWith(CLAUDE_AUTO_PREFIX) ? binary.slice(CLAUDE_AUTO_PREFIX.length) : binary;
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

export function deriveFailures(events: KloopEvent[]): { count: number; threshold: number } {
  const runStart = events.find(e => e.type === EVENT_TYPES.RUN_START);
  const threshold = (runStart && 'config' in runStart && runStart.config?.conflictCheckThreshold) ?? 3;

  let consecutiveFailures = 0;
  let lastApprovedLoop = -1;

  for (const e of events) {
    if (e.type === EVENT_TYPES.COMPLETED && 'reason' in e && e.reason === 'consensus') {
      const idx = events.indexOf(e);
      for (let i = idx - 1; i >= 0; i--) {
        if (events[i].type === EVENT_TYPES.LOOP_END && 'loop' in events[i]) {
          lastApprovedLoop = events[i].loop;
          break;
        }
      }
    }
  }

  for (const e of events) {
    if (e.type === EVENT_TYPES.LOOP_END && 'loop' in e) {
      if (e.loop > lastApprovedLoop) consecutiveFailures++;
    }
  }

  return { count: consecutiveFailures, threshold };
}

// Column width helpers
export const NAME_W = 10;
export const ROLE_W = 10;

export function statusMark(ok: boolean | undefined): string {
  if (ok === undefined) return pc.dim('○');
  return ok ? pc.green('●') : pc.red('●');
}

export function verdictMark(verdict?: string): string {
  if (verdict === 'approved') return pc.green('\u2713');
  if (verdict === 'rejected') return pc.red('\u2717');
  return pc.dim('·');
}

export function fmtRow(role: string, name: string, dur: string, info: string): string {
  return `  ${pc.dim(role.padEnd(ROLE_W))}  ${name.padEnd(NAME_W)}  ${dur.padStart(8)}  ${info}`;
}

export function checkpointColor(outcome: string): (s: string) => string {
  return outcome === 'conflict_found'
    ? pc.red
    : outcome === 'spec_auto_fixed'
      ? pc.green
      : outcome === 'spec_compressed'
        ? pc.blue
        : pc.dim;
}

export function formatTokens(input?: number, output?: number): string {
  if (!input && !output) return '';
  const total = (input ?? 0) + (output ?? 0);
  if (total < 1000) return `${total}`;
  return `${(total / 1000).toFixed(1)}k`;
}
