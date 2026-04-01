// ============================================================================
// Pure: prompt template substitution
// ============================================================================

import { DEFAULT_IMPLEMENTER_PROMPT, DEFAULT_REVIEWER_PROMPT, DEFAULT_CHECKPOINTER_PROMPT } from './default-prompts';

/**
 * Substitute {placeholder} tokens in a template string.
 * Unknown placeholders are left as-is.
 */
export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/{(\w+)}/g, (_, key) => vars[key] ?? `{${key}}`);
}

// ============================================================================
// Implementer prompt
// ============================================================================

export interface ImplementerPromptVars {
  specPath: string;
  iteration: string;
  reviewsDir: string;
  evidenceDir: string;
  learningsFile: string;
}

export function buildImplementerPrompt(template: string | undefined, vars: ImplementerPromptVars): string {
  return substitute(template ?? DEFAULT_IMPLEMENTER_PROMPT, vars);
}

// ============================================================================
// Reviewer prompt
// ============================================================================

export interface ReviewerPromptVars {
  specPath: string;
  iteration: string;
  reviewerIndex: string;
  reviewsDir: string;
  verdictsDir: string;
  evidenceDir: string;
  learningsFile: string;
  archivedReviews: string | null; // path to previous loop's reviews, or null
}

export function buildReviewerPrompt(template: string | undefined, vars: ReviewerPromptVars): string {
  let prompt = template ?? DEFAULT_REVIEWER_PROMPT;
  // Handle the conditional archivedReviews section
  const archivedSection =
    vars.archivedReviews !== null
      ? `Check the previous loop's completed reviews at ${vars.archivedReviews}/ for context on what reviewers found.\n(Read these for background only — do not let previous reviewers opinions override your own assessment of the spec and code.)`
      : `No previous loop reviews available yet.`;
  prompt = substitute(prompt, { ...vars, archivedReviews: archivedSection });
  return prompt;
}

// ============================================================================
// Checkpointer prompt
// ============================================================================

export interface CheckpointerPromptVars {
  specPath: string;
  iteration: string;
  reviewsDir: string;
  archivedReviewsPattern: string;
  conflictFile: string;
  checkpointResultFile: string;
}

export function buildCheckpointerPrompt(template: string | undefined, vars: CheckpointerPromptVars): string {
  return substitute(template ?? DEFAULT_CHECKPOINTER_PROMPT, vars);
}
