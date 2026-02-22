import type { StateService } from '../deps';
import { DEFAULT_CONFIG } from '../types';
import * as config from '../state/config';

export async function handler(
  opts: {
    implementer: string;
    reviewers: string;
    conflictChecker: string;
    maxIterations: string;
    implementerTimeout: string;
    reviewerTimeout: string;
    conflictCheckThreshold: string;
  },
  state: StateService,
): Promise<void> {
  try {
    // Parse reviewers as comma-separated list
    const reviewersList = opts.reviewers
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    const cfg = config.configFromOptions({
      implementer: opts.implementer || undefined,
      reviewers: reviewersList.length > 0 ? reviewersList : undefined,
      conflictChecker: opts.conflictChecker || undefined,
      maxIterations: parseInt(opts.maxIterations, 10) || undefined,
      implementerTimeout: parseInt(opts.implementerTimeout, 10) || undefined,
      reviewerTimeout: parseInt(opts.reviewerTimeout, 10) || undefined,
      conflictCheckThreshold: parseInt(opts.conflictCheckThreshold, 10) || undefined,
    });

    await state.initProject(cfg);

    console.log('Dev Loop Initialized');
    console.log(`  Implementer: ${cfg.implementer}`);
    console.log(`  Reviewers: ${cfg.reviewers.join(', ')}`);
    if (cfg.conflictChecker) {
      console.log(`  Conflict checker: ${cfg.conflictChecker}`);
    }
    console.log(`  Max iterations: ${cfg.maxIterations}`);
    console.log(`  Implementer timeout: ${cfg.implementerTimeout}m`);
    console.log(`  Reviewer timeout: ${cfg.reviewerTimeout}m`);
    console.log(`  Conflict check threshold: ${cfg.conflictCheckThreshold} failures`);
    console.log('');
    console.log('Next: edit .kagent/spec.md, then run: dev-loop run');
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
