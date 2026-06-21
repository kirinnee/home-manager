// ============================================================================
// Pure: prompt template substitution
// ============================================================================

import {
  DEFAULT_IMPLEMENTER_PROMPT,
  DEFAULT_REVIEWER_PROMPT,
  DEFAULT_CHECKPOINTER_PROMPT,
  CONFLICT_ONLY_CHECKPOINTER_PROMPT,
  DEFAULT_SYNTHESIZER_PROMPT,
  DEFAULT_VERIFIER_PROMPT,
  DEFAULT_RE_SYNTHESIS_PROMPT,
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
  reviewSummaryPath?: string;
}

export function buildImplementerPrompt(template: string | undefined, vars: ImplementerPromptVars): string {
  return substitute(template ?? DEFAULT_IMPLEMENTER_PROMPT, {
    ...vars,
    reviewSummaryPath: vars.reviewSummaryPath ?? '',
  });
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
  previousSummaryPath?: string; // path to previous loop's review-summary.md
}

export function buildReviewerPrompt(template: string | undefined, vars: ReviewerPromptVars): string {
  let prompt = template ?? DEFAULT_REVIEWER_PROMPT;
  const archivedSection = vars.archivedReviews !== null ? vars.archivedReviews : '';
  prompt = substitute(prompt, {
    ...vars,
    archivedReviews: archivedSection,
    previousSummaryPath: vars.previousSummaryPath ?? '',
  });
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
  archivedSummariesPattern: string;
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

// ============================================================================
// Synthesizer prompt
// ============================================================================

export interface SynthesizerPromptVars {
  specPath: string;
  iteration: string;
  reviewsDir: string;
  verdictsDir: string;
  previousSummaryPath: string;
  summaryOutputPath: string;
  learningsFile: string;
  evidenceDir: string;
}

export function buildSynthesizerPrompt(template: string | undefined, vars: SynthesizerPromptVars): string {
  return substitute(template ?? DEFAULT_SYNTHESIZER_PROMPT, vars);
}

// ============================================================================
// Verifier prompt
// ============================================================================

export interface VerifierPromptVars {
  specPath: string;
  iteration: string;
  previousSummaryPath: string;
  reviewsDir: string;
  verdictsDir: string;
  evidenceDir: string;
  learningsFile: string;
  verifierIndex: string;
}

export function buildVerifierPrompt(template: string | undefined, vars: VerifierPromptVars): string {
  return substitute(template ?? DEFAULT_VERIFIER_PROMPT, vars);
}

// ============================================================================
// Re-synthesizer prompt
// ============================================================================

export interface ReSynthesisPromptVars {
  specPath: string;
  iteration: string;
  previousSummaryPath: string;
  verifyDir: string;
  verdictsDir: string;
  summaryOutputPath: string;
  learningsFile: string;
}

export function buildReSynthesisPrompt(template: string | undefined, vars: ReSynthesisPromptVars): string {
  return substitute(template ?? DEFAULT_RE_SYNTHESIS_PROMPT, vars);
}
