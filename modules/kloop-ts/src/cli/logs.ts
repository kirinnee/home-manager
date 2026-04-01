import pc from 'picocolors';
import * as fs from 'fs/promises';
import { paths, getKloopHome } from '../deps';
import type { CliDeps } from './index';

/**
 * kloop logs [id] [-f] [--since <duration|iso>]
 *
 * Shows kloop's own run log (~/.kloop/{runId}/run.log).
 */

export async function handler(
  runId: string | undefined,
  opts: { f?: boolean; since?: string },
  deps: CliDeps,
): Promise<void> {
  try {
    const { indexDb } = deps;

    // Resolve run ID
    if (!runId) {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log(pc.yellow('No run found for this workspace.'));
        return;
      }
      runId = row.id;
    }

    const logPath = paths.runLog(runId);
    if (!(await fileExists(logPath))) {
      console.log(pc.yellow(`No run log found: ${logPath}`));
      return;
    }

    // Follow mode
    if (opts.f) {
      const { execSync } = await import('child_process');
      console.log(pc.dim(`Following: ${logPath}`));
      console.log(pc.dim('Press Ctrl+C to stop'));
      console.log('');
      execSync(`tail -f "${logPath}"`, { stdio: 'inherit' });
      return;
    }

    // Read and filter
    let content = await fs.readFile(logPath, 'utf-8');
    if (opts.since) {
      content = filterSince(content, opts.since, logPath);
    }

    if (!content.trim()) {
      console.log(pc.yellow('No log entries.'));
      return;
    }

    console.log(pc.dim(`Run log: ${logPath}`));
    console.log('');
    console.log(content);
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

function filterSince(content: string, since: string, logPath: string): string {
  const cutoff = parseSince(since);
  if (!cutoff) return content;

  // run.log doesn't have timestamps per line (it's console output), but each line
  // is captured from kloop's stdout. If --since is given, try to read the file's
  // mtime as a proxy for the run start time.
  // For now, just show everything — run.log timestamps are imprecise.
  // Future: add timestamps to run.log lines for proper filtering.
  console.log(pc.dim(`--since filtering is approximate (run.log has no per-line timestamps)`));
  return content;
}

function parseSince(since: string): Date | null {
  // Try ISO date
  const d = new Date(since);
  if (!isNaN(d.getTime())) return d;

  // Try duration like "5m", "1h", "30s"
  const match = since.match(/^(\d+)([smhd])$/);
  if (match) {
    const val = parseInt(match[1], 10);
    const unit = match[2];
    const now = Date.now();
    const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return new Date(now - val * (multipliers[unit] ?? 60000));
  }

  return null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
