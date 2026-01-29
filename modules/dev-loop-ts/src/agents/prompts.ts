// ============================================================================
// Pure: build prompt strings
// ============================================================================

export interface ImplementerPromptParams {
  iteration: number;
  specPath: string;
  specContent: string;
  learnings: string[];
}

export interface ReviewerPromptParams {
  iteration: number;
  reviewerIndex: number;
  specPath: string;
  specContent: string;
}

export function buildImplementerPrompt(params: ImplementerPromptParams): string {
  const { iteration, specPath, specContent, learnings } = params;
  const evidenceDir = '.claude/dev-loop/current/evidence';

  if (iteration === 1) {
    return `You are the IMPLEMENTER for iteration 1 (first iteration).

READ FIRST:
- Spec: ${specPath}

TASK:
1. Implement the spec requirements
2. Do NOT modify the spec
3. Do NOT commit changes

EVIDENCE OF COMPLETION:
When your implementation is complete, you MUST provide evidence:
- Build output showing successful compilation/build
- Test output showing passing tests
- Screenshots or terminal output demonstrating the feature works
- Save all evidence to files in ${evidenceDir}/
  - build-output.log or build-output.txt: Build/command output
  - test-output.log or test-output.txt: Test results
  - evidence.md: Summary of what was done and proof it works

Example evidence commands:
- For TypeScript: bun run build > ${evidenceDir}/build-output.log 2>&1
- For tests: bun test > ${evidenceDir}/test-output.log 2>&1
- For demo: echo "Demo output" > ${evidenceDir}/evidence.md

Be concise and focused.`;
  }

  const learningsText = learnings.length > 0 ? learnings.map(l => `- ${l}`).join('\n') : 'None yet';

  return `You are the IMPLEMENTER for iteration ${iteration}.

READ FIRST:
- Spec: ${specPath}

PREVIOUS LEARNINGS (from earlier iterations):
${learningsText}

TASKS:
1. Read the spec carefully
2. Apply learnings from previous iterations
3. Implement improvements based on what was learned
4. Write new learnings to .claude/dev-loop/current/learnings.md (1-3 bullet points)

EVIDENCE OF COMPLETION:
You MUST provide proof that your implementation works:
- Build output: ${evidenceDir}/build-output.log
- Test output: ${evidenceDir}/test-output.log
- Summary: ${evidenceDir}/evidence.md

Do NOT modify the spec. Do NOT commit changes. Be concise.`;
}

export function buildReviewerPrompt(params: ReviewerPromptParams): string {
  const { iteration, reviewerIndex, specPath } = params;
  const evidenceDir = '.claude/dev-loop/current/evidence';
  const reviewsDir = '.claude/dev-loop/current/reviews';
  const reviewFile = `${reviewsDir}/reviewer-${reviewerIndex}.md`;
  const verdictFile = `.claude/dev-loop/current/verdicts/${iteration}-${reviewerIndex}.json`;

  return `You are reviewing iteration ${iteration} (reviewer ${reviewerIndex}).

TASKS:
1. Read spec: ${specPath}
2. Run: git diff
3. Check ALL acceptance criteria
4. Review evidence in ${evidenceDir}/ (build output, tests, etc)

OUTPUT (MANDATORY):
1. Create the reviews directory if it doesn't exist:
   mkdir -p ${reviewsDir}

2. Write your review to ${reviewFile}:
   # Review: Reviewer ${reviewerIndex} (Iteration ${iteration})
   ## Criteria: [x] or [ ] each
   ## Issues: list or None
   ## Evidence Review: Comment on provided evidence
   ## Verdict: APPROVED or REJECTED

3. Write your final verdict to ${verdictFile} as JSON:
   {"verdict": "approved" or "rejected", "reasoning": "explanation"}
   This file MUST be created. Use lowercase for verdict value.`;
}
