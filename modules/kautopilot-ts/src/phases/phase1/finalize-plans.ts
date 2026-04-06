import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Phase1Context } from './types';
import { appendEvent } from '../../core/log';
import { snapshotPath, ensureArtifactDir } from '../../core/artifacts';
import { buildPromptVars } from '../../core/type-config';
import { discoverPlans, validatePlanContent, findLatestPlanDraftDir } from '../shared';
import { writeContractManifest, writePlanManifest, writeDeliveryManifest } from '../../core/manifests';
import { logOk, logError, logWarn } from '../../util/format';

/**
 * [code] Snapshot plans from worktree to session artifacts and commit.
 * Terminal state for Phase 1.
 */
export async function handleFinalizePlans(ctx: Phase1Context): Promise<string | null> {
  const { session, version } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'finalize_plans:started',
    version,
    metadata: { stepType: 'code' },
  });

  const vars = buildPromptVars(session.worktree, version, session.ticket_id || 'local');

  // Discover plan files from worktree — try draft-based first, then flat files
  const latestDraft = findLatestPlanDraftDir(vars.plans);
  const planFiles = latestDraft ? latestDraft.files : discoverPlans(vars.plans);
  if (planFiles.length === 0) {
    logError(`No plan files found at ${vars.plans}. Did the TTY write them?`);
    throw new Error('No plan files written');
  }

  // Validate plan content
  const emptyPlans = validatePlanContent(planFiles);
  if (emptyPlans.length > 0) {
    logError(`Empty plan files: ${emptyPlans.join(', ')}`);
    throw new Error('Some plan files are empty');
  }

  // Snapshot to session artifacts with spec convention: plan-{ordinal}-1.md
  const sessionPlansDir = snapshotPath(session.id, version, 'plans');
  ensureArtifactDir(join(sessionPlansDir, 'placeholder'));
  for (let i = 0; i < planFiles.length; i++) {
    const specFilename = `plan-${i + 1}-1.md`;
    copyFileSync(planFiles[i], join(sessionPlansDir, specFilename));
  }

  // Write typed manifests (contract.json, plans/manifest.json, delivery.json)
  const deliveryKind = ctx.deliveryKind ?? 'pr';
  writeContractManifest(session.id, version, deliveryKind, planFiles.length);
  writePlanManifest(session.id, version);
  writeDeliveryManifest(session.id, version, { kind: deliveryKind });

  // Persist deliveryKind to WAL
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    metadata: { deliveryKind },
  });

  // Git commit the spec + plans — stage only the specific files created by this phase
  const { $ } = await import('bun');
  try {
    const addedFiles: string[] = [];
    // Stage the plan files that were written to the worktree by the TTY
    for (const f of planFiles) {
      if (existsSync(f)) {
        await $`git add ${f}`.cwd(session.worktree).quiet();
        addedFiles.push(f);
      }
    }

    if (addedFiles.length > 0) {
      const ticketPrefix = session.ticket_id ? `[${session.ticket_id}] ` : '';
      const commitProc = Bun.spawnSync({
        cmd: ['git', 'commit', '-m', `${ticketPrefix}spec + plans v${version}`],
        cwd: session.worktree,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      if (commitProc.exitCode === 0) {
        logOk(`Committed spec + ${planFiles.length} plan(s) (v${version})`);
      } else {
        const stderr = commitProc.stderr.toString().trim();
        if (!stderr.includes('nothing to commit')) {
          logError(`git commit failed: ${stderr}`);
        }
      }
    }
  } catch (err) {
    logWarn(`[finalize_plans] Git staging/commit error: ${err}`);
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'finalize_plans:completed',
    version,
    metadata: { planCount: planFiles.length },
  });

  return null; // terminal state
}
