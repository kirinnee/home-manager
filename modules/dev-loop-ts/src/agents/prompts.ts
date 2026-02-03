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

export function buildImplementerPrompt(params: ImplementerPromptParams): string {
  const { iteration, specPath, specContent, previousLoopLearnings, currentLoopReviews } = params;
  const evidenceDir = `.kagent/current/evidence`;
  const learningsFile = `.kagent/current/learnings.md`;

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

## Your Task

You are Reviewer ${reviewerIndex} for loop ${iteration}.

1. Review the current implementation against the specification
2. Check the evidence in ${evidenceDir}/
3. Run \`git diff\` to see the changes
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
