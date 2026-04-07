import { copyFileSync, existsSync } from 'node:fs';
import { ensureArtifactDir, snapshotPath } from '../../core/artifacts';
import { appendEvent } from '../../core/log';
import { buildPromptVars } from '../../core/type-config';
import { logError, logOk } from '../../util/format';
import type { Phase1Context } from './types';

/**
 * [code] Finalize the approved spec by copying the working copy to session artifacts.
 *
 * The TTY already wrote task-spec.md (working copy) and called snapshot.
 * This step ensures the working copy is also copied to the session artifact
 * directory as the canonical task-spec.md reference.
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

  // Verify working copy exists
  if (!existsSync(vars.spec)) {
    logError(`No task-spec.md found at ${vars.spec}. Did the TTY write it?`);
    throw new Error('No spec working copy found');
  }

  // Copy working copy to session artifacts as task-spec.md (canonical reference)
  const dest = snapshotPath(session.id, version, 'task-spec.md');
  ensureArtifactDir(dest);
  copyFileSync(vars.spec, dest);

  logOk(`Spec finalized: task-spec.md → session artifacts`);

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'finalize_spec:completed',
    version,
  });

  return 'write_plans';
}
