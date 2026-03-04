// ============================================================================
// Pure: build prompt strings
// ============================================================================

export interface ImplementerPromptParams {
  iteration: number;
  specPath: string;
  specContent: string;
  previousLoopLearnings: string[];
  currentLoopReviews?: string[];
}

export interface ReviewerPromptParams {
  iteration: number;
  reviewerIndex: number;
  specPath: string;
  specContent: string;
}

export interface CheckpointerPromptParams {
  iteration: number;
  specPath: string;
  specContent: string;
  runId: string;
}

export function buildImplementerPrompt(params: ImplementerPromptParams): string {
  const { iteration, specPath, specContent, previousLoopLearnings, currentLoopReviews } = params;
  const evidenceDir = `.kagent/current/evidence`;
  const learningsFile = `.kagent/current/learnings.md`;
  const reviewsDir = `.kagent/current/reviews`;

  const hasReviews = currentLoopReviews && currentLoopReviews.length > 0;
  const reviewsText = hasReviews
    ? `\nPREVIOUS REVIEW FEEDBACK (from last loop):\n${currentLoopReviews.map(r => `- ${r}`).join('\n')}\n`
    : '';

  const learningsText =
    previousLoopLearnings.length > 0
      ? `\nLEARNINGS FROM PREVIOUS LOOPS:\n${previousLoopLearnings.map(l => `- ${l}`).join('\n')}\n`
      : '';

  return `# Implementation Task

## Specification

${specContent}

## Context

- Loop: ${iteration}
- Spec: ${specPath}
${reviewsText}
${learningsText}

## Reviews

Check \`${reviewsDir}/\` for the latest review feedback.
Previous reviews are archived in \`.kagent/reviews/{runId}/\` for reference.
Focus on the most recent feedback to guide your implementation.

## Instructions

1. Read and understand the specification completely
2. If there are learnings or review feedback above, address those issues first
3. Implement the required changes
4. Run ALL tests and verify they pass
5. Run the build and verify it succeeds
6. Write evidence to ${evidenceDir}/:
   - build-output.log: Complete build command output
   - test-output.log: Complete test command output
   - evidence.md: Summary of what you verified and how
7. Write learnings to ${learningsFile}:
   - Document any roadblocks encountered
   - Note workarounds or discoveries
   - Document any decisions made and why
   - This helps the next iteration if reviewers find issues

## Important

- Do not interact with the user. Work autonomously.
- Be thorough - reviewers will verify your work independently.
- If tests fail, fix them before completing.
- If build fails, fix it before completing.
- Document everything in evidence so reviewers can verify.

## Test/Build Commands

Auto-detect and use the appropriate commands:
- Makefile: \`make test\`, \`make build\`
- Taskfile.yml: \`task test\`, \`task build\`
- justfile: \`just test\`, \`just build\`
- CI config: Use exact commands from CI configuration
- If none detected, prompt user for commands

## Git Safety - CRITICAL

- NEVER use \`git push --force\` or \`git push -f\`
- NEVER push to any branch other than the current task branch
- NEVER push to main, master, or any protected branch
- NEVER delete branches
- NEVER rebase pushed commits
- If push fails, use \`git pull\` and merge, never force
- Do NOT commit changes - the run will commit on successful completion
`;
}

export function buildReviewerPrompt(params: ReviewerPromptParams): string {
  const { iteration, reviewerIndex, specPath } = params;
  const evidenceDir = `.kagent/current/evidence`;
  const reviewsDir = `.kagent/current/reviews`;
  const reviewFile = `${reviewsDir}/reviewer-${reviewerIndex}.md`;
  const verdictFile = `.kagent/current/verdicts/${iteration}-${reviewerIndex}.json`;
  const learningsFile = `.kagent/current/learnings.md`;

  return `# Code Review Task

## Specification

Read the spec from: ${specPath}

**IMPORTANT:** Only refer to \`.kagent/spec.md\` as the source of truth for this implementation. Ignore any other spec files in the project (e.g., \`spec.md\`, \`spec-v2.md\`, \`spec-v3.md\`, \`spec-v4.md\` in the project root). The target specification is exclusively \`.kagent/spec.md\`.

## Your Task

You are Reviewer ${reviewerIndex} for loop ${iteration}.

1. Review the current implementation against the specification
2. Check the evidence in ${evidenceDir}/
3. Run \`git status\`, \`git diff\`, and \`git diff --staged\` to see all changes (staged, unstaged, and untracked files)
4. Run the tests yourself to verify they pass
5. Run the build yourself to verify it succeeds
6. Check CLAUDE.md in the project root (if exists) - ensure all changes conform to those guidelines
7. Check for any relevant skills in the project - ensure implementation follows best practices
8. Write your review to ${reviewFile}
9. Write your verdict to ${verdictFile}:
   \`\`\`json
   {
     "verdict": "approved" or "rejected",
     "reasoning": "Your detailed reasoning here",
     "completionEstimate": 0-100 (percentage of spec completion - be conservative, 100% only if ALL acceptance criteria are met)
   }
   \`\`\`

## Completion Estimate Guidelines

Estimate how much of the specification has been completed:
- 0-30%: Basic structure started, most features missing
- 30-60%: Core features implemented, but incomplete or buggy
- 60-90%: Most features working, edge cases or polish needed
- 100%: ALL acceptance criteria fully met, tests passing, no known issues

**Be conservative** - it's better to underestimate than overestimate. Only give 100% if the spec is truly complete.

## Review Criteria - BE STRICT

You must verify ALL of the following. Reject if ANY criterion fails:

### 1. Specification Compliance

- Does the implementation address EVERY requirement in the spec?
- Are there any spec requirements that were missed or partially implemented?
- Does the behavior match what was specified exactly?

### 2. Code Quality

- Is the code clean, readable, and maintainable?
- Are there any obvious bugs or logic errors?
- Is error handling appropriate?
- Are edge cases handled?

### 3. Testing

- Do ALL tests pass? (Run them yourself, don't trust evidence alone)
- Is test coverage adequate for the changes?
- Are there missing test cases for important scenarios?

### 4. Build & Integration

- Does the build succeed without warnings? (Run it yourself)
- Are there any type errors or linting issues?
- Does the change integrate properly with existing code?

### 5. Security

- Are there any security vulnerabilities introduced?
- Is user input properly validated?
- Are there any injection risks (SQL, XSS, command injection)?

### 6. Evidence Verification

- Did the implementer provide complete evidence?
- Do the evidence files match what you observe when running commands yourself?
- Are there any discrepancies between claimed and actual results?

### 7. CLAUDE.md / Skills Compliance

- If CLAUDE.md exists in the project root, do all changes follow those guidelines?
- Are there relevant skills in the project that should be followed?
- Does the implementation match the project's coding standards and conventions?

## Verdict Guidelines

**APPROVE only if:**

- ALL specification requirements are fully implemented
- ALL tests pass when you run them
- Build succeeds when you run it
- Code quality is acceptable
- No security issues identified
- Evidence is accurate and complete
- Changes conform to CLAUDE.md (if present) and relevant skills

**REJECT if:**

- ANY specification requirement is missing or incomplete
- ANY test fails
- Build fails or has errors
- Significant code quality issues
- Security vulnerabilities present
- Evidence is missing, incomplete, or inaccurate
- Changes violate CLAUDE.md guidelines or relevant skills
- You have ANY doubt about the implementation correctness

When in doubt, REJECT. It is better to have another iteration than to approve incomplete work.

## Learnings

You can also check ${learningsFile} to understand what the implementer learned during this iteration. This may provide context for their decisions.

## Git Safety - CRITICAL

- NEVER use \`git push --force\` or \`git push -f\`
- NEVER push to any branch other than the current task branch
- NEVER push to main, master, or any protected branch
- NEVER delete branches
- NEVER rebase pushed commits
- Reject if you see any evidence of force pushing or unsafe git operations

Be thorough and strict. Your review ensures quality.
`;
}

export function buildCheckpointerPrompt(params: CheckpointerPromptParams): string {
  const { iteration, specPath, specContent, runId } = params;
  const currentReviewsDir = `.kagent/current/reviews`;
  const archivedReviewsDir = `.kagent/reviews/${runId}`;
  const conflictFile = `.kagent/conflict.md`;
  const checkpointResultFile = `.kagent/current/checkpoint-result.json`;
  const specFile = specPath;

  return `# Checkpointer Task

## Context

The dev loop has failed to reach consensus after ${iteration} iterations. Your task is to:

1. **Detect spec-level conflicts** that block progress → if found, exit with conflict status
2. **Auto-fix unambiguous spec mistakes** (like typos) → if fixed, continue loop with corrected spec
3. **Compress the spec** if no conflict AND progress > 60% → focus on remaining work

## Specification

Current spec content:
\`\`\`
${specContent}
\`\`\`

Spec file: ${specFile}

## Your Task

1. **Read ALL reviews:**
   - Current iteration reviews: ${currentReviewsDir}/
   - Archived reviews from previous iterations: ${archivedReviewsDir}/
   - Each file is named: \`reviewer-{index}.md\` (current) or \`review-{iteration}-{index}-{binary}.md\` (archived)

2. **Analyze reviews against the spec** to determine:
   - What acceptance criteria are complete (based on reviewer feedback)
   - What acceptance criteria remain incomplete
   - Progress percentage (completed / total criteria)

3. **Check for conflicts:**

   **What IS a conflict (MUST flag):**
   - Impossible requirements in the spec itself
   - Contradictory constraints that cannot all be satisfied
   - Ambiguous spec that leads to fundamentally different interpretations

   **What is NOT a conflict (DO NOT flag):**
   - Reviewer disagreement due to leniency/strictness
   - Reviewer mistakes
   - Implementer mistakes
   - Reviewer preference differences
   - Missing implementation (this is a normal failure, not a conflict)

4. **Check for auto-fixable issues:**
   - Obvious typos in the spec (e.g., "config.ts" when it should be "config.tsx")
   - ONLY if the fix is completely unambiguous - if there's ANY doubt, treat as conflict

5. **Determine outcome and take action:**

### Outcome 1: conflict_found
Spec contains impossible or contradictory requirements.

**Actions:**
1. Write \`${conflictFile}\` with conflict details
2. Write checkpoint result JSON with outcome "conflict_found"
3. Print conflict summary to stdout (will be shown to user)
4. Exit - loop will end with status "conflict"

### Outcome 2: spec_auto_fixed
Found an unambiguous mistake (e.g., typo) and fixed it.

**Actions:**
1. Edit ${specFile} directly to fix the issue
2. Write checkpoint result JSON with outcome "spec_auto_fixed"
3. Loop will reload spec and continue

**ONLY use this for completely unambiguous fixes.**
If there's ANY ambiguity about what the user intended, use conflict_found instead.

### Outcome 3: spec_compressed
No conflict found, no auto-fix needed, progress > 60%.

**Actions:**
1. Backup original spec to \`.kagent/spec-${runId}.md\`
2. Compress the spec to focus on remaining work:
   - Remove or mark as done: items marked as complete in reviews
   - Keep with updated status: items with partial progress
   - Keep as-is: items not mentioned or incomplete
   - Compress verbose descriptions to essential requirements
3. Update ${specFile} with compressed spec
4. Write checkpoint result JSON with outcome "spec_compressed"

### Outcome 4: no_action
No conflict found, no auto-fix needed, progress <= 60%.

**Actions:**
1. Write checkpoint result JSON with outcome "no_action"
2. Loop continues normally

## Checkpoint Result JSON

Write your result to ${checkpointResultFile}:

\`\`\`json
{
  "outcome": "conflict_found" | "spec_auto_fixed" | "spec_compressed" | "no_action",
  "summary": "Brief description of what was found/decided",
  "progressPercent": 75,
  "completedCriteria": ["criterion 1", "criterion 2"],
  "remainingCriteria": ["criterion 3", "criterion 4"]
}
\`\`\`

## Conflict File Format

If outcome is "conflict_found", write ${conflictFile}:

\`\`\`markdown
# Conflict Analysis

## Summary
[Brief summary of the conflict]

## Conflicts Found

### Conflict 1: [Title]
- **Source**: [Which spec sections conflict]
- **Description**: [What the conflict is]
- **Impact**: [Why this prevents progress]
- **User Decision Required**: [What the user needs to decide]

## Recommendation
[What should happen next]
\`\`\`

## Important

- Be thorough - read ALL reviews from current and archived locations
- Focus on SPEC-LEVEL conflicts only, NOT reviewer disagreements
- A conflict means: the spec itself has impossible or contradictory requirements
- Implementation mistakes are NOT conflicts
- Auto-fix ONLY for completely unambiguous issues
- When in doubt, use conflict_found or no_action rather than guessing

## Output

After analysis, write the checkpoint result JSON to ${checkpointResultFile}.
If conflict_found, also write ${conflictFile}.
If spec_auto_fixed or spec_compressed, edit ${specFile} directly.
`;
}
