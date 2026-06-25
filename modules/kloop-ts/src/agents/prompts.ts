// ============================================================================
// Pure: prompt template substitution
// ============================================================================

import {
  DEFAULT_IMPLEMENTER_PROMPT,
  REVIEWER_PLUMBING_PROMPT,
  REVIEW_LENS_PROFILES,
  DEFAULT_REVIEW_LENS,
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
// Interactive-mode completion sentinel
// ============================================================================

/**
 * Instruction appended to an agent's prompt when running in interactive (non --print)
 * mode. The agent runs in a persistent TUI that never exits on its own, so kloop watches
 * for this marker file to know the work is done — then it sends /exit and closes the
 * session. The agent MUST create it as its final action (and only when truly finished).
 */
export function buildSentinelInstruction(sentinelFile: string): string {
  return `

---
## ⛔ SESSION COMPLETION SIGNAL (interactive mode — READ THIS)

You are running in an INTERACTIVE session that does NOT exit on its own. kloop is watching
for a marker file to know you have finished.

When — and ONLY when — you have completely finished ALL work described above AND written
every required output file (verdict / review / learnings / spec / summary, as applicable),
create the marker file by running EXACTLY:

    touch "${sentinelFile}"

Rules:
- Create it as your VERY LAST action. Never create it early or speculatively.
- After creating it, stop working. kloop will close the session for you.
- Do all other required file writes BEFORE touching the marker.`;
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
  lensFocus?: string; // the lens's "what to scrutinize" text; defaults to the general lens
}

export function buildReviewerPrompt(template: string | undefined, vars: ReviewerPromptVars): string {
  // Default reviewer prompt = plumbing (mechanics) with the lens focus appended via
  // {lensFocus}. A custom template (config.prompts.reviewer) is used verbatim; if it
  // contains {lensFocus} it gets the lens too, otherwise that token is simply absent.
  const prompt = template ?? REVIEWER_PLUMBING_PROMPT;
  const archivedSection = vars.archivedReviews !== null ? vars.archivedReviews : '';
  return substitute(prompt, {
    ...vars,
    archivedReviews: archivedSection,
    previousSummaryPath: vars.previousSummaryPath ?? '',
    // Resolve placeholders INSIDE the lens text too — substitute() is single-pass and does
    // not re-scan inserted text, so a lens may reference {evidenceDir}, {reviewsDir}, etc.
    lensFocus: substitute(vars.lensFocus ?? REVIEW_LENS_PROFILES[DEFAULT_REVIEW_LENS], vars),
  });
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
