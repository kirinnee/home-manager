import type { Config, Run } from '../types';
import { buildImplementerPrompt, buildReviewerPrompt } from '../agents/prompts';

export interface IterationData {
  run: Run;
  config: Config;
  spec: string;
  learnings: string[];
  implementerPrompt: string;
  reviewerPrompts: Array<{ reviewerIndex: number; prompt: string }>;
}

export function buildIterationData(run: Run, config: Config, specPath: string, specContent: string): IterationData {
  const implementerPrompt = buildImplementerPrompt({
    iteration: run.iteration,
    specPath,
    specContent,
    previousLoopLearnings: run.learnings ?? [],
  });

  // Flatten review phases to build prompts for all reviewers
  const allReviewers = config.reviewPhases.flat();
  const reviewerPrompts = Array.from({ length: allReviewers.length }, (_, i) => ({
    reviewerIndex: i,
    prompt: buildReviewerPrompt({
      iteration: run.iteration,
      reviewerIndex: i,
      specPath,
      specContent,
    }),
  }));

  return {
    run,
    config,
    spec: specContent,
    learnings: run.learnings,
    implementerPrompt,
    reviewerPrompts,
  };
}

// Re-export for use by loop/runner.ts
export { buildReviewerPrompt } from '../agents/prompts';
