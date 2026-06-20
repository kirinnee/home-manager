import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { sessionDir } from '../core/artifacts';
import type { ArtifactKind } from '../core/revisions';
import { diffRevisions } from '../core/revisions';
import { logError } from '../util/format';
import { resolveSession } from './resolve-session';

/** Repo subfolders present under `epoch/<E>/plans/` (the registered plan repos). */
function plansRepos(sessionId: string, epoch: number): string[] {
  const dir = join(sessionDir(sessionId), 'epoch', String(epoch), 'plans');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

// ============================================================================
// `kautopilot diff <artifact[:repo]> [--from n] [--to n]` — unified diff between
// two revisions of a versioned artifact (default n-1 → n). (CLI-CONTRACT §5)
// ============================================================================

const KINDS = new Set(['triage', 'spec', 'plan', 'plans', 'feedback', 'brainstorm']);

export function createDiffCommand(): Command {
  return new Command('diff')
    .description('Show the diff between two revisions of a versioned artifact')
    .argument('<artifact>', 'triage | spec | plan[:<repo>] | feedback | brainstorm')
    .option('--from <n>', 'From revision', v => Number.parseInt(v, 10))
    .option('--to <n>', 'To revision', v => Number.parseInt(v, 10))
    .option('--session <id>', 'Target session id')
    .action(async (artifact: string, opts: { from?: number; to?: number; session?: string }) => {
      try {
        if (opts.from !== undefined && Number.isNaN(opts.from)) {
          logError('--from must be a number.');
          process.exit(1);
        }
        if (opts.to !== undefined && Number.isNaN(opts.to)) {
          logError('--to must be a number.');
          process.exit(1);
        }
        const { sessionId, meta } = resolveSession(opts.session);
        const [rawKind, repo] = artifact.split(':');
        const kind = (rawKind === 'plan' ? 'plans' : rawKind) as ArtifactKind;
        if (!KINDS.has(rawKind)) {
          logError(`Unknown artifact: ${rawKind}. Use triage|spec|plan[:repo]|feedback|brainstorm.`);
          process.exit(1);
        }
        // Epoch-scoped kinds operate on the current epoch; brainstorm is global.
        const epoch = kind === 'brainstorm' ? null : meta.epoch;
        // Plans are per-repo: when no `:repo` is given, resolve a unique repo
        // folder; error (listing the choices) when there are zero or many.
        let resolvedRepo = repo ?? null;
        if (kind === 'plans' && !resolvedRepo) {
          const repos = plansRepos(sessionId, meta.epoch);
          if (repos.length === 1) {
            resolvedRepo = repos[0];
          } else if (repos.length === 0) {
            logError(`No plan revisions found for epoch ${meta.epoch}. Run plan writing first.`);
            process.exit(1);
          } else {
            logError(`Multiple plan repos exist — specify one as \`plan:<repo>\`. Available: ${repos.join(', ')}.`);
            process.exit(1);
          }
        }
        const out = diffRevisions(sessionId, kind, {
          from: opts.from,
          to: opts.to,
          epoch,
          repo: resolvedRepo,
        });
        console.log(out);
        process.exit(0);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
