import { existsSync, copyFileSync, readdirSync } from 'node:fs';
import type { Phase1Context } from './types';
import { appendEvent } from '../../core/log';
import { snapshotPath, ensureArtifactDir } from '../../core/artifacts';
import { buildPromptVars } from '../../core/type-config';
import { logOk, logError } from '../../util/format';

/**
 * Find the latest spec-draft-N.md in a directory.
 */
function findLatestDraftPath(specDir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(specDir);
  } catch {
    return null;
  }

  const drafts = files
    .filter(f => /^spec-draft-\d+\.md$/.test(f))
    .map(f => ({ file: f, ordinal: parseInt(f.match(/spec-draft-(\d+)\.md/)![1]) }))
    .sort((a, b) => b.ordinal - a.ordinal);

  if (drafts.length === 0) return null;
  return `${specDir}/${drafts[0].file}`;
}

/**
 * [code] Copy the latest approved spec-draft-N.md as task-spec.md in both
 * worktree and session artifacts.
 */
export async function handleFinalizeSpec(ctx: Phase1Context): Promise<string | null> {
  const { session, version } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'finalize_spec:started',
    version,
    metadata: { stepType: 'code' },
  });

  const vars = buildPromptVars(session.worktree, version, session.ticket_id || 'local');

  // Find latest spec draft
  const latestDraft = findLatestDraftPath(vars.specDir);
  if (!latestDraft || !existsSync(latestDraft)) {
    logError(`No spec-draft-N.md found in ${vars.specDir}. Did the TTY write it?`);
    throw new Error('No spec draft found');
  }

  // Copy to task-spec.md in worktree spec dir
  const taskSpecWorktree = vars.spec; // now points to task-spec.md
  copyFileSync(latestDraft, taskSpecWorktree);

  // Snapshot to session artifacts as task-spec.md
  const dest = snapshotPath(session.id, version, 'task-spec.md');
  ensureArtifactDir(dest);
  copyFileSync(latestDraft, dest);

  logOk(`Spec finalized: ${latestDraft.split('/').pop()} → task-spec.md`);

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'finalize_spec:completed',
    version,
  });

  return 'write_plans';
}
