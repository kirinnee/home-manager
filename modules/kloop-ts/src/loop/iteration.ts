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

  const implVars: ImplementerPromptVars = {
    specPath,
    iteration: String(run.iteration),
    reviewsDir: implReviewsDir,
    evidenceDir,
    learningsFile,
  };

  const implementerPrompt = buildImplementerPrompt(config.prompts?.implementer, implVars);

  // Flatten review phases to build prompts for all reviewers
  const allReviewers = config.reviewPhases.flat();
  const prevLoop = loopNum > 1 ? loopNum - 1 : null;
  const reviewerPrompts = Array.from({ length: allReviewers.length }, (_, i) => {
    // Per-reviewer probability roll for seeing previous loop's reviews
    const seesPrevReviews = prevLoop !== null && Math.random() < (config.previousReviewPropagation ?? 0);
    const archivedReviews = seesPrevReviews ? paths.loopReviewsPath(runId, prevLoop) : null;

    const revVars: ReviewerPromptVars = {
      specPath,
      iteration: String(run.iteration),
      reviewerIndex: String(i),
      reviewsDir,
      verdictsDir,
      evidenceDir,
      learningsFile,
      archivedReviews,
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
  };
}

// Re-export for use by loop/runner.ts
export { buildReviewerPrompt } from '../agents/prompts';
