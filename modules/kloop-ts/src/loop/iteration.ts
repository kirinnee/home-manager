import type { Config, Run } from '../types';
import type { Paths } from '../deps';
import { buildImplementerPrompt, buildReviewerPrompt } from '../agents/prompts';
import type { ImplementerPromptVars, ReviewerPromptVars } from '../agents/prompts';

export interface IterationData {
  run: Run;
  config: Config;
  spec: string;
  learnings: string[];
  implementerPrompt: string;
  reviewerPrompts: Array<{ reviewerIndex: number; prompt: string }>;
  reviewSummaryPath: string | null;
}

/**
 * Build iteration data for prompts.
 * @param loopNum 1-based loop number (matches directory name loop-{loopNum})
 */
export function buildIterationData(
  run: Run,
  config: Config,
  specPath: string,
  _specContent: string,
  runId: string,
  loopNum: number,
  paths: Paths,
): IterationData {
  const reviewsDir = paths.loopReviewsPath(runId, loopNum);
  const verdictsDir = paths.loopVerdictsPath(runId, loopNum);
  const evidenceDir = paths.loopEvidencePath(runId, loopNum);
  const learningsFile = paths.runLearnings(runId);

  // Implementer reads reviews from the PREVIOUS loop (current loop's dir is empty)
  const implReviewsDir =
    loopNum > 1 ? paths.loopReviewsPath(runId, loopNum - 1) : paths.loopReviewsPath(runId, loopNum);

  // Compute review summary path from previous loop's synthesis (needed for implVars)
  const reviewSummaryPath = loopNum > 1 ? `${paths.loopSynthesisPath(runId, loopNum - 1)}/review-summary.md` : null;

  // Implementer: always gets previous loop context (no roll).
  // synthesis on → summary only; synthesis off → raw reviews folder
  const scratchDir = paths.scratchDir(process.cwd());
  const implVars: ImplementerPromptVars = {
    specPath,
    iteration: String(run.iteration),
    reviewsDir: config.synthesis ? 'none (see synthesized summary above)' : implReviewsDir,
    evidenceDir,
    learningsFile,
    reviewSummaryPath: reviewSummaryPath ?? undefined,
    scratchDir,
  };

  const implementerPrompt = buildImplementerPrompt(config.prompts?.implementer, implVars);

  // Flatten review phases to build prompts for all reviewers
  const allReviewers = config.reviewPhases.flat();
  const prevLoop = loopNum > 1 ? loopNum - 1 : null;

  // Reviewer: roll determines if they see ANY previous loop context.
  // synthesis on + roll pass → summary only; synthesis off + roll pass → raw reviews folder; roll fail → nothing
  const reviewerPrompts = Array.from({ length: allReviewers.length }, (_, i) => {
    const seesPrev = prevLoop !== null && Math.random() < (config.previousReviewPropagation ?? 0);
    const revVars: ReviewerPromptVars = {
      specPath,
      iteration: String(run.iteration),
      reviewerIndex: String(i),
      reviewsDir,
      verdictsDir,
      evidenceDir,
      learningsFile,
      archivedReviews: seesPrev && !config.synthesis ? paths.loopReviewsPath(runId, prevLoop) : null,
      previousSummaryPath: seesPrev && config.synthesis ? (reviewSummaryPath ?? undefined) : undefined,
      scratchDir,
    };
    return {
      reviewerIndex: i,
      prompt: buildReviewerPrompt(config.prompts?.reviewer, revVars),
    };
  });

  return {
    run,
    config,
    spec: _specContent,
    learnings: run.learnings,
    implementerPrompt,
    reviewerPrompts,
    reviewSummaryPath,
  };
}

// Re-export for use by loop/runner.ts
export { buildReviewerPrompt } from '../agents/prompts';
