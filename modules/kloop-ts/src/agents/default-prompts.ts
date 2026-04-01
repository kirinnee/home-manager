// ============================================================================
// Default prompt templates for each agent role
// ============================================================================
//
// These are COMPLETE prompt templates with {placeholders} substituted at
// build time. Everything is editable by the user — there are no hidden
// structural parts. Placeholders use {camelCase} syntax.
//
// Available placeholders vary by agent — see each prompt's doc comment.
// ============================================================================

/**
 * Default prompt template for the implementer agent.
 *
 * Placeholders:
 *   {specPath}      - path to the spec file
 *   {iteration}     - current loop number
 *   {reviewsDir}    - path to previous loop's reviews/ folder (empty for loop 1)
 *   {evidenceDir}   - path to evidence/ folder
 *   {learningsFile} - path to learnings.md
 */
export const DEFAULT_IMPLEMENTER_PROMPT = `# Implementation Task

## Specification

Read the spec from: {specPath}
Read CLAUDE.md and any project skills files if they exist.

## Context

- Loop: {iteration}
- Reviews from previous loop: {reviewsDir}/
- Learnings from previous loops: {learningsFile}

## Instructions

1. Read and understand the specification completely — especially the Definition of Done checklist
2. Before using any library, tool, or framework, research its current documentation and source code. Verify the version you are using matches the API signatures and configuration you are relying on. Do not rely on potentially outdated knowledge.
3. Address any review feedback or learnings from above
4. Implement the required changes
5. Capture evidence to {evidenceDir}/:
   - If the spec has a Definition of Done checklist, capture evidence for each item
   - If the spec has no checklist, figure out what checks are available (build, test, lint, type-check, etc.) and capture what you can
6. Write learnings to {learningsFile}: roadblocks, workarounds, decisions made, and why

## Git Safety - CRITICAL

- NEVER use \`git push --force\` or \`git push -f\`
- NEVER push to any branch other than the current task branch
- NEVER push to main, master, or any protected branch
- NEVER delete branches or rebase pushed commits
- Do NOT commit changes — the run will commit on successful completion`;

/**
 * Default prompt template for the reviewer agent.
 *
 * Placeholders:
 *   {specPath}      - path to the spec file
 *   {iteration}     - current loop number
 *   {reviewerIndex} - which reviewer this is
 *   {reviewsDir}    - path to reviews/ folder (to write review .md)
 *   {verdictsDir}   - path to verdicts/ folder (to write verdict .json)
 *   {evidenceDir}   - path to evidence/ folder
 *   {learningsFile} - path to learnings.md
 *   {archivedReviews} - conditional block for previous loop reviews (set by buildReviewerPrompt)
 */
export const DEFAULT_REVIEWER_PROMPT = `# Code Review Task

## Specification

Read the spec from: {specPath}
Read CLAUDE.md and any project skills files if they exist.

## Previous Loop Reviews
{archivedReviews}

## Your Task

You are Reviewer {reviewerIndex} for loop {iteration}. Be strict and thorough.

1. Run \`git diff\` and \`git diff --staged\` to see all changes
2. Review every changed file against the specification — not just a summary
3. Before using any library, tool, or framework referenced in the code, research its current documentation and source code. Verify the version being used matches the actual API signature and configuration. Flag any usage of outdated or non-existent features.
4. Check {evidenceDir}/ for build, test, and other output logs — trust these as accurate to save time
5. **Validate evidence** — check {evidenceDir}/ for output logs
   - If the spec has a Definition of Done checklist, be strict: every required evidence item must be present and passing. Reject if anything is missing.
   - If the spec has no checklist, use judgment: check what is reasonable for this project. Don't reject for missing evidence that the spec never asked for.
6. Write your review to {reviewsDir}/reviewer-{reviewerIndex}.md — include any issues found and evidence gaps
7. Write your verdict to {verdictsDir}/reviewer-{reviewerIndex}.json:
   \`\`\`json
   {
     "approved": true,
     "reasoning": "Your detailed reasoning here",
     "completionEstimate": 0-100 (be conservative, 100% only if ALL acceptance criteria are met)
   }
   \`\`\`

## Learnings

Check {learningsFile} for context on the implementer's decisions this iteration.

## Verdict

- **APPROVE** if all spec requirements are met and all required evidence is present
- **REJECT** for any clear issue: missing spec requirements, failing evidence, outdated library usage, security vulnerabilities, or CLAUDE.md violations

## Git Safety - CRITICAL

- NEVER use \`git push --force\` or \`git push -f\`
- NEVER push to any branch other than the current task branch
- NEVER push to main, master, or any protected branch
- NEVER delete branches or rebase pushed commits
- Reject if you see any evidence of unsafe git operations`;

/**
 * Default prompt template for the checkpointer agent.
 *
 * Placeholders:
 *   {specPath}               - path to the spec file
 *   {iteration}              - current loop number
 *   {reviewsDir}             - path to current loop's reviews/
 *   {archivedReviewsPattern} - glob pattern for all previous loop reviews
 *   {conflictFile}           - path to run-level conflict.md
 *   {checkpointResultFile}  - path to checkpointer/checkpoint-result.json
 */
export const DEFAULT_CHECKPOINTER_PROMPT = `# Checkpointer Task

## Context

The dev loop has failed to reach consensus after {iteration} iterations. Your task is to:

1. **Detect spec-level conflicts** that block progress → if found, exit with conflict status
2. **Auto-fix unambiguous spec mistakes** (like typos) → if fixed, continue loop with corrected spec
3. **Compress the spec** if no conflict AND progress > 60% → focus on remaining work

## Specification

Read the spec from: {specPath}

## Your Task

1. Read ALL reviews: current ({reviewsDir}/reviewer-*.md) and archived ({archivedReviewsPattern})
2. Analyze reviews against the spec to determine what criteria are complete vs remaining
3. Check for conflicts:
   - **IS a conflict:** impossible requirements, contradictory constraints, fundamentally ambiguous spec
   - **NOT a conflict:** reviewer disagreement, reviewer/implementer mistakes, missing implementation
4. Check for auto-fixable issues (e.g., typos) — ONLY if completely unambiguous

## Outcomes

### conflict_found
Spec has impossible/contradictory requirements.
- Write {conflictFile} with details
- Write checkpoint result to {checkpointResultFile} with \`"outcome": "conflict_found"\`

### spec_auto_fixed
Found an unambiguous mistake and fixed it.
- Edit {specPath} directly
- Write checkpoint result with \`"outcome": "spec_auto_fixed"\`

### spec_compressed
No conflict, no fix needed, progress > 60%.
- Compress spec to remaining work: remove completed items, keep partial/incomplete ones
- Update {specPath} with compressed spec
- Write checkpoint result with \`"outcome": "spec_compressed"\`

### no_action
No conflict, no fix, progress <= 60%.
- Write checkpoint result with \`"outcome": "no_action"\`

## Checkpoint Result JSON

Write to {checkpointResultFile}:
\`\`\`json
{
  "outcome": "conflict_found" | "spec_auto_fixed" | "spec_compressed" | "no_action",
  "summary": "Brief description",
  "progressPercent": 75,
  "completedCriteria": ["criterion 1"],
  "remainingCriteria": ["criterion 2"]
}
\`\`\`

If conflict_found, also write {conflictFile} with conflict analysis details.
If spec_auto_fixed or spec_compressed, edit {specPath} directly.`;
