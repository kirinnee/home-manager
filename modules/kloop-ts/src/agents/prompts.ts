// ============================================================================
// Pure: prompt template substitution
// ============================================================================

import {
  DEFAULT_IMPLEMENTER_PROMPT,
  DEFAULT_REVIEWER_PROMPT,
  DEFAULT_CHECKPOINTER_PROMPT,
  CONFLICT_ONLY_CHECKPOINTER_PROMPT,
} from './default-prompts';

/**
 * Substitute {placeholder} tokens in a template string.
 * Unknown placeholders are left as-is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function substitute(template: string, vars: any): string {
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
  // Handle the conditional archivedReviews section — path only, no inline instructions
  const archivedSection = vars.archivedReviews !== null ? vars.archivedReviews : '';
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

export function buildCheckpointerPrompt(
  conflictOnlyTemplate: string | undefined,
  fullTemplate: string | undefined,
  vars: CheckpointerPromptVars,
  compressSpec?: boolean,
): string {
  // Pick the right custom template based on compressSpec flag
  const template = compressSpec ? fullTemplate : conflictOnlyTemplate;
  if (template) return substitute(template, vars);
  // Fall back to built-in defaults based on compressSpec flag
  const defaultTemplate = compressSpec ? DEFAULT_CHECKPOINTER_PROMPT : CONFLICT_ONLY_CHECKPOINTER_PROMPT;
  return substitute(defaultTemplate, vars);
}
