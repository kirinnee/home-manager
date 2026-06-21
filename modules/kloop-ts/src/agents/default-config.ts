import {
  DEFAULT_IMPLEMENTER_PROMPT,
  DEFAULT_REVIEWER_PROMPT,
  CONFLICT_ONLY_CHECKPOINTER_PROMPT,
  DEFAULT_CHECKPOINTER_PROMPT,
  DEFAULT_SYNTHESIZER_PROMPT,
  DEFAULT_VERIFIER_PROMPT,
  DEFAULT_RE_SYNTHESIS_PROMPT,
} from './default-prompts';

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map(line => pad + line)
    .join('\n');
}

export function buildDefaultConfigYaml(): string {
  return `# kloop run configuration

# ── Model Configuration ─────────────────────────────────────────────────────
# Which agents/binaries run each role.

implementers:
  claude: 1

reviewPhases:
  - - claude

conflictChecker: claude
synthesizer: claude

verifyPhases:
  - - claude-auto-zai
    - claude-auto-mm

# ── Loop Controls ────────────────────────────────────────────────────────────
# Iteration limits, timeouts, thresholds, and feature flags.

maxIterations: 7
implementerTimeout: 30     # minutes
reviewerTimeout: 15        # minutes
synthesisTimeout: 15       # minutes
verifyTimeout: 5           # minutes
conflictCheckThreshold: 3
compressSpec: false
firstLoopFullReview: true
previousReviewPropagation: 0.7

synthesis: true
verify: true
rerankAfterCheckpoint: true
snapshot: false

implementerRetry:
  maxRetries: 2
  backoffBaseMs: 5000       # ms, doubles each retry

# Retry a reviewer that produced NO parseable verdict (transport failure, crash,
# timeout). A real approve/reject verdict is never retried.
reviewerRetry:
  maxRetries: 2
  backoffBaseMs: 5000       # ms, doubles each retry

firstIterationWeightMultiplier: 2

# ── Prompt Templates ─────────────────────────────────────────────────────────
# Agent prompt templates — edit these to customize agent behavior.
# All {placeholders} are substituted at build time with actual runtime paths.

prompts:
  # implementer variables:
  #   {specPath}          - path to spec file (agent reads on demand)
  #   {iteration}         - current loop number
  #   {reviewsDir}        - path to reviews/ folder
  #   {evidenceDir}       - path to evidence/ folder
  #   {learningsFile}     - path to learnings.md
  #   {reviewSummaryPath} - path to previous loop's review-summary.md (loop 2+)
  implementer: |
${indent(DEFAULT_IMPLEMENTER_PROMPT, 4)}
  # reviewer variables:
  #   {specPath}              - path to spec file
  #   {iteration}             - current loop number
  #   {reviewerIndex}         - which reviewer this is
  #   {reviewsDir}            - path to reviews/ folder (write review here)
  #   {verdictsDir}           - path to verdicts/ folder (write verdict here)
  #   {evidenceDir}           - path to evidence/ folder
  #   {learningsFile}         - path to learnings.md
  #   {previousSummaryPath}   - path to previous loop's review-summary.md (loop 2+)
  reviewer: |
${indent(DEFAULT_REVIEWER_PROMPT, 4)}
  # synthesizer — compacts reviews into a structured summary
  #   {specPath}              - path to spec file
  #   {iteration}             - current loop number
  #   {reviewsDir}            - path to reviews/ folder
  #   {verdictsDir}           - path to verdicts/ folder
  #   {previousSummaryPath}   - path to previous loop's review-summary.md
  #   {summaryOutputPath}     - path to write review-summary.md
  #   {learningsFile}         - path to learnings.md
  #   {evidenceDir}           - path to evidence/ folder
  synthesizer: |
${indent(DEFAULT_SYNTHESIZER_PROMPT, 4)}
  # verifier — validates previous issues were fixed using synthesis summary
  #   {specPath}              - path to spec file
  #   {iteration}             - current loop number
  #   {previousSummaryPath}   - path to previous loop's review-summary.md
  #   {reviewsDir}            - path to reviews/ folder
  #   {verdictsDir}           - path to verdicts/ folder
  #   {evidenceDir}           - path to evidence/ folder
  #   {learningsFile}         - path to learnings.md
  #   {verifierIndex}         - which verifier this is
  verifier: |
${indent(DEFAULT_VERIFIER_PROMPT, 4)}
  # reSynthesizer — merges previous synthesis + verifier outputs on verify fail
  #   {specPath}              - path to spec file
  #   {iteration}             - current loop number
  #   {previousSummaryPath}   - path to previous loop's review-summary.md
  #   {verifyDir}             - path to verify/ folder
  #   {verdictsDir}           - path to verdicts/ folder
  #   {summaryOutputPath}     - path to write review-summary.md
  #   {learningsFile}         - path to learnings.md
  reSynthesizer: |
${indent(DEFAULT_RE_SYNTHESIS_PROMPT, 4)}
  # checkpointer — used when compressSpec: false (conflict detection only)
  #   {specPath}                  - path to spec file
  #   {iteration}                 - current loop number
  #   {reviewsDir}                - path to current loop's reviews/
  #   {archivedReviewsPattern}    - glob for all previous loop reviews
  #   {archivedSummariesPattern}  - glob for all loop synthesis summaries
  #   {conflictFile}              - path to conflict.md
  #   {checkpointResultFile}      - path to checkpoint-result.json
  checkpointer: |
${indent(CONFLICT_ONLY_CHECKPOINTER_PROMPT, 4)}
  # checkpointerFull — used when compressSpec: true (conflict detection + spec compression + auto-fix)
  #   Same variables as checkpointer
  checkpointerFull: |
${indent(DEFAULT_CHECKPOINTER_PROMPT, 4)}
`;
}
