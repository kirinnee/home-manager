import {
  DEFAULT_IMPLEMENTER_PROMPT,
  DEFAULT_REVIEWER_PROMPT,
  CONFLICT_ONLY_CHECKPOINTER_PROMPT,
  DEFAULT_CHECKPOINTER_PROMPT,
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
implementers:
  claude: 1

reviewPhases:
  - - claude

conflictChecker: claude
maxIterations: 7
implementerTimeout: 30     # minutes
reviewerTimeout: 15        # minutes
conflictCheckThreshold: 3
compressSpec: false
firstLoopFullReview: true
previousReviewPropagation: 0.7

# Agent prompt templates — edit these to customize agent behavior.
# All {placeholders} are substituted at build time with actual runtime paths.
prompts:
  # implementer variables:
  #   {specPath}          - path to spec file (agent reads on demand)
  #   {iteration}         - current loop number
  #   {reviewsDir}        - path to reviews/ folder
  #   {evidenceDir}       - path to evidence/ folder
  #   {learningsFile}     - path to learnings.md
  implementer: |
${indent(DEFAULT_IMPLEMENTER_PROMPT, 4)}
  # reviewer variables:
  #   {specPath}        - path to spec file
  #   {iteration}       - current loop number
  #   {reviewerIndex}   - which reviewer this is
  #   {reviewsDir}      - path to reviews/ folder (write review here)
  #   {verdictsDir}     - path to verdicts/ folder (write verdict here)
  #   {evidenceDir}     - path to evidence/ folder
  #   {learningsFile}   - path to learnings.md
  reviewer: |
${indent(DEFAULT_REVIEWER_PROMPT, 4)}
  # checkpointer — used when compressSpec: false (conflict detection only, no spec modification)
  #   {specPath}               - path to spec file
  #   {iteration}              - current loop number
  #   {reviewsDir}             - path to current loop's reviews/
  #   {archivedReviewsPattern} - glob for all previous loop reviews
  #   {conflictFile}           - path to conflict.md
  #   {checkpointResultFile}  - path to checkpoint-result.json
  checkpointer: |
${indent(CONFLICT_ONLY_CHECKPOINTER_PROMPT, 4)}
  # checkpointerFull — used when compressSpec: true (conflict detection + spec compression + auto-fix)
  #   Same variables as checkpointer, plus:
  #   {specBackupFile}         - path to spec-backup.md (used during compression)
  checkpointerFull: |
${indent(DEFAULT_CHECKPOINTER_PROMPT, 4)}
`;
}
