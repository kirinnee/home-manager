import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSessionByWorktree } from '../core/db';
import { getGitRoot, getWorktree } from '../core/git';
import { readConfig } from '../core/config';
import { sessionDir } from '../core/artifacts';
import { ensureStatus } from '../core/status';
import { buildPromptVars } from '../core/type-config';
import { runReviewers } from '../core/review-runner';
import { logError } from '../util/format';

export function createSpecReviewCommand(): Command {
  return new Command('spec-review')
    .description('Run spec reviewers for the current session (stateless, stdout only)')
    .action(async () => {
      try {
        await runSpecReview();
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function runSpecReview(): Promise<void> {
  // Discover session from worktree
  const repoPath = getGitRoot();
  const worktree = getWorktree();
  const session = getSessionByWorktree(repoPath, worktree);
  if (!session) {
    logError('No session found in this worktree.');
    process.exit(1);
  }

  // Load config
  const config = readConfig(session.id);
  if (!config) {
    logError('No config found for this session.');
    process.exit(1);
  }

  // Determine version from status
  const status = ensureStatus(session.id);
  const version = status.version || 1;

  // Read type.json to find the ticket type
  const typeJsonPath = join(sessionDir(session.id), 'artifacts', `v${version}`, 'type.json');
  if (!existsSync(typeJsonPath)) {
    logError(`No type.json found at ${typeJsonPath}. Has route_type completed?`);
    process.exit(1);
  }

  const typeInfo = JSON.parse(readFileSync(typeJsonPath, 'utf-8'));
  const typeName = typeInfo.type as string;

  const typeConfig = config.types[typeName];
  if (!typeConfig) {
    logError(`Type "${typeName}" not found in config.`);
    process.exit(1);
  }

  const reviewers = typeConfig.spec_reviewers;
  if (!reviewers || Object.keys(reviewers).length === 0) {
    console.log('No spec reviewers configured for this type.');
    return;
  }

  // Build prompt vars
  const vars = buildPromptVars(worktree, version);

  // Run reviewers and print summary to stdout
  const summary = await runReviewers(reviewers, vars, config, session.id);
  console.log(summary);
}
