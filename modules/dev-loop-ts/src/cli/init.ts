import type { StateService } from '../deps';
import * as config from '../state/config';
import { formatConfigDisplay } from '../state/config';

export async function handler(
  opts: {
    implementer: string;
    implementers: string;
    reviewers: string;
    reviewPhases: string;
    conflictChecker: string;
    maxIterations: string;
    implementerTimeout: string;
    reviewerTimeout: string;
    conflictCheckThreshold: string;
    firstLoopFullReview: boolean;
    previousReviewPropagation: string;
  },
  state: StateService,
): Promise<void> {
  try {
    // When review-phases is explicitly provided, don't pass reviewers (to avoid override)
    // Commander always provides the default value for --reviewers, so we check if review-phases is set
    const hasReviewPhases = opts.reviewPhases !== undefined && opts.reviewPhases !== '';

    // Parse reviewers as comma-separated list (only when not using review-phases)
    const reviewersList =
      !hasReviewPhases && opts.reviewers
        ? opts.reviewers
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0)
        : [];

    const partial = config.configFromOptions({
      implementer: opts.implementer || undefined,
      implementers: opts.implementers || undefined,
      reviewers: reviewersList.length > 0 ? reviewersList : undefined,
      reviewPhases: hasReviewPhases ? opts.reviewPhases : undefined,
      conflictChecker: opts.conflictChecker || undefined,
      maxIterations: parseInt(opts.maxIterations, 10) || undefined,
      implementerTimeout: parseFloat(opts.implementerTimeout) || undefined,
      reviewerTimeout: parseFloat(opts.reviewerTimeout) || undefined,
      conflictCheckThreshold: parseInt(opts.conflictCheckThreshold, 10) || undefined,
      firstLoopFullReview: opts.firstLoopFullReview ? true : undefined,
      previousReviewPropagation: parseFloat(opts.previousReviewPropagation) || undefined,
    });

    await state.initProject(partial);

    // For display, build the resolved config
    const cfg = await state.loadConfig();

    console.log('Dev Loop Initialized');
    console.log(formatConfigDisplay(cfg));
    console.log('');
    console.log('Next: edit .kagent/spec.md, then run: dev-loop run');
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
