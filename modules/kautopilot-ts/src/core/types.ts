import { z } from 'zod';

// ============================================================================
// Log Entry
// ============================================================================

export interface LogEntry {
  ts: string;
  event: string;
  version?: number;
  attempt?: number;
  plan?: string;
  result?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Session Status — re-exported from status.ts
// ============================================================================

export type { SessionStatus, TaskStatus } from './status';

// ============================================================================
// Kloop Config
// ============================================================================

// Default kloop prompt templates (inlined from kloop)
const DEFAULT_KLOOP_IMPLEMENTER_PROMPT = `# Implementation Task

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
3. **Focus on rejected reviews first.** Read the reviews from the previous loop at {reviewsDir}/. UNANIMOUS approval is required — every reviewer must pass. If any reviewer rejected, address their concerns before moving on to other work. Do NOT treat a minority rejection as optional.
4. Implement the required changes, with special attention to addressing every rejected reviewer's concerns
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

const DEFAULT_KLOOP_REVIEWER_PROMPT = `# Code Review Task

## Specification

Read the spec from: {specPath}
Read CLAUDE.md and any project skills files if they exist.

## Previous Loop Reviews
{archivedReviews}
If previous reviews are available above, read the verdict JSONs to identify which reviewers REJECTED. For each rejected reviewer, specifically verify whether their concerns have been addressed. Do not let previous opinions override your own assessment — but ensure previously raised issues are no longer present.

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

const DEFAULT_KLOOP_CHECKPOINTER_PROMPT = `# Conflict Detection Task

## Context

The dev loop has failed to reach consensus after {iteration} iterations.
You are a **conflict detector** — your ONLY job is to determine if the spec itself is the problem.
You must NOT modify the spec. You must NOT compress the spec.

## Specification

Read the spec from: {specPath}

## Your Task

1. Read ALL reviews: current ({reviewsDir}/reviewer-*.md) and archived ({archivedReviewsPattern})
2. Read ALL verdicts from the review JSON files alongside the reviews
3. Cross-reference the spec's acceptance criteria / Definition of Done against every reviewer's findings
4. Determine if the spec contains a fundamental conflict that makes it impossible to implement

## What IS a Conflict

A conflict is a spec defect where **no possible implementation can satisfy all requirements simultaneously**, regardless of how intelligent or persistent the implementer is.

**The litmus test:** Imagine giving the implementer 10x intelligence and 10x more attempts. Could it eventually fulfil the spec? If the answer is NO, that is a conflict.

Conflicts are often subtle — the spec may look reasonable at a glance, but becomes impossible after implementation reveals ground truth:

- **Contradictory constraints**: Two or more acceptance criteria that cannot coexist. Example: "Do not modify any files in \`src/\`" combined with "Achieve 100% test coverage" — if \`src/\` contains dead code paths that are unreachable, the implementer cannot cover them without modifying \`src/\`. No amount of intelligence or retries solves this.
- **Circular dependencies**: Criterion A requires B done first, but B requires A done first.
- **Impossible environmental constraints**: Spec requires something the environment cannot provide (e.g., a file path that doesn't exist, a library version that lacks the specified API, a Node 14 requirement for a Node 18+ API).
- **Fundamentally ambiguous requirements**: Requirements so vague that reasonable implementers would produce fundamentally different solutions (e.g., "make it fast" with no metric, "improve UX" with no design spec).

**Important**: Reviewer disagreement — even across multiple loops — is NOT a conflict by itself. Use reviewer feedback as a clue for *where to look*, not as evidence of a conflict. Only flag a conflict if you can point to specific spec text that is self-contradictory or impossible to satisfy.

## What is NOT a Conflict

- **Reviewer disagreement**: Reviewers disagree on quality, approach, or interpretation — this is normal and expected
- **Persistent reviewer disagreement**: Even if reviewers keep rejecting across multiple loops, this only means the implementation needs more work, NOT that the spec is broken
- **Incomplete implementation**: The implementer didn't finish, but the spec is achievable
- **Bugs or errors**: Implementation has bugs, but the spec is sound
- **Missing tests/evidence**: Implementation lacks proof, but the spec is achievable
- **Style preferences**: Reviewers have different opinions on code style
- **Hard but possible**: The spec is difficult but achievable with enough effort

## Conflict Confidence Levels

When analyzing, assign a confidence level:

- **HIGH**: Found clear textual contradiction in the spec (quote both parts)
- **MEDIUM**: Cross-referencing reviews reveals systematic impossibility that isn't obvious from the spec alone
- **LOW**: Suspicion based on patterns but could be implementation issues

Only report conflicts at MEDIUM or higher confidence. If only LOW, report no_action.

## Outcomes

### conflict_found
The spec contains impossible, contradictory, or fundamentally ambiguous requirements.
- Write {conflictFile} with:
  1. The exact conflicting requirements (quote the spec)
  2. Why they conflict
  3. Which reviewers flagged this (with quotes)
  4. Suggested resolution (if obvious)
- Write checkpoint result to {checkpointResultFile} with \`"outcome": "conflict_found"\`

### no_action
No spec-level conflict detected. The spec is sound — failures are due to implementation/review issues.
- Write checkpoint result with \`"outcome": "no_action"\`
- Do NOT edit {specPath}

## Checkpoint Result JSON

Write to {checkpointResultFile}:
\`\`\`json
{
  "outcome": "conflict_found" | "no_action",
  "summary": "Brief description of what was found (or why no conflict)",
  "progressPercent": 75,
  "completedCriteria": ["criterion 1"],
  "remainingCriteria": ["criterion 2"],
  "conflictConfidence": "HIGH" | "MEDIUM" | "LOW"
}
\`\`\`

If conflict_found, also write {conflictFile} with detailed conflict analysis.
Do NOT edit {specPath} under any circumstances.`;

const DEFAULT_KLOOP_CHECKPOINTER_FULL_PROMPT = `# Checkpointer Task

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
3. Check for conflicts (see below)
4. Check for auto-fixable issues (e.g., typos) — ONLY if completely unambiguous

## What IS a Conflict

A conflict is a spec defect where **no possible implementation can satisfy all requirements simultaneously**, regardless of how intelligent or persistent the implementer is.

**The litmus test:** Imagine giving the implementer 10x intelligence and 10x more attempts. Could it eventually fulfil the spec? If the answer is NO, that is a conflict.

Conflicts are often subtle — the spec may look reasonable at a glance, but becomes impossible after implementation reveals ground truth:

- **Contradictory constraints**: Two or more acceptance criteria that cannot coexist. Example: "Do not modify any files in \`src/\`" combined with "Achieve 100% test coverage" — if \`src/\` contains dead code paths that are unreachable, the implementer cannot cover them without modifying \`src/\`. No amount of intelligence or retries solves this.
- **Circular dependencies**: Criterion A requires B done first, but B requires A done first.
- **Impossible environmental constraints**: Spec requires something the environment cannot provide (e.g., a file path that doesn't exist, a library version that lacks the specified API, a Node 14 requirement for a Node 18+ API).
- **Fundamentally ambiguous requirements**: Requirements so vague that reasonable implementers would produce fundamentally different solutions (e.g., "make it fast" with no metric, "improve UX" with no design spec).

**Important**: Reviewer disagreement — even across multiple loops — is NOT a conflict by itself. Use reviewer feedback as a clue for *where to look*, not as evidence of a conflict. Only flag a conflict if you can point to specific spec text that is self-contradictory or impossible to satisfy.

## What is NOT a Conflict

- **Reviewer disagreement**: Reviewers disagree on quality, approach, or interpretation — this is normal
- **Persistent reviewer rejection**: Even across many loops, this means the implementation needs more work
- **Incomplete implementation**: The implementer didn't finish, but the spec is achievable
- **Bugs or errors**: Implementation has bugs, but the spec is sound
- **Missing tests/evidence**: Implementation lacks proof, but the spec is achievable
- **Hard but possible**: The spec is difficult but achievable with enough effort

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

export interface KloopPrompts {
  implementer?: string;
  reviewer?: string;
  checkpointer?: string;
  checkpointerFull?: string;
}

const kloopPromptsSchema = z
  .object({
    implementer: z.string().optional(),
    reviewer: z.string().optional(),
    checkpointer: z.string().optional(),
    checkpointerFull: z.string().optional(),
  })
  .optional();

export interface KloopConfig {
  implementers: Record<string, number>;
  reviewPhases: string[][];
  conflictChecker?: string;
  maxIterations: number;
  implementerTimeout: number;
  reviewerTimeout: number;
  conflictCheckThreshold: number;
  compressSpec: boolean;
  firstLoopFullReview: boolean;
  previousReviewPropagation: number;
  prompts?: KloopPrompts;
}

const kloopConfigSchema = z
  .object({
    implementers: z.record(z.string(), z.number()).default({ claude: 1 }),
    reviewPhases: z.array(z.array(z.string())).default([['claude']]),
    conflictChecker: z.string().optional(),
    maxIterations: z.number().min(1).max(100).default(7),
    implementerTimeout: z.number().min(1).max(120).default(30),
    reviewerTimeout: z.number().min(1).max(120).default(15),
    conflictCheckThreshold: z.number().min(1).max(10).default(3),
    compressSpec: z.boolean().default(false),
    firstLoopFullReview: z.boolean().default(true),
    previousReviewPropagation: z.number().min(0).max(1).default(0.7),
    prompts: kloopPromptsSchema,
  })
  .default({});

// ============================================================================
// Config
// ============================================================================

// ============================================================================
// Reviewer Schema
// ============================================================================

export const reviewerSchema = z.object({
  desc: z.string(),
  prompt: z.string(),
  binaries: z.array(z.string()).optional(),
  timeout: z.number().optional(),
});

export type ReviewerConfig = z.infer<typeof reviewerSchema>;

// ============================================================================
// Main Config Schema
// ============================================================================

const agentSchema = z.object({
  prompt: z.string(),
  binary: z.string().optional(),
});

// ============================================================================
// Default Output Templates for Phase 1
// ============================================================================

const DEFAULT_TRIAGE_TEMPLATE = `# Triage: {title}

## Delivery Kind
pr | ticket

## Complexity
straightforward | moderate | complex

## Assessment
[2-5 sentence summary of what needs to happen]

## Clarifications
[Any points clarified with the user, or "None needed"]

## Risks
[Risk factors with specific evidence, or "Low risk" with justification]

## Verification

### Assumptions to Verify
[What assumptions does this task make that must be checked against reality?
 This is domain-dependent and open-ended. Any assumption about external
 behavior that the implementation will depend on belongs here.
 Or "None — all assumptions are grounded in code already read."]

### Access Required
[What access/permissions are needed to verify assumptions above?
 Request it here so the user grants it before spec/plan writing.
 Or "None"]

### Testing Level
none | light | moderate | heavy
[Rationale for this level]

### Validation Matrix
- Automated immediate: [what to check before release, automated]
- Manual immediate: [human checks before release, or "none"]
- Automated post-release: [automated checks after release, or "none"]
- Manual post-release: [human checks after release, or "none"]`;

const DEFAULT_SPEC_TEMPLATE = `# Spec: {title}

## Summary
[What this change does and why. 2-3 sentences.]

## Verification Evidence
[For each assumption the triage listed under "Assumptions to Verify":
 - State the assumption
 - State what you checked (doc URL, file path, command output, live query result)
 - State confirmed or denied, with the evidence
 If you could not verify an assumption, flag it:
 "UNVERIFIED: [assumption] — could not verify because [reason]"
 If triage said "None", write "No assumptions to verify."]

## Requirements

### Functional Requirements
[What the system must do. Each requirement should describe:
 - The observable behavior from the user's or caller's perspective
 - Inputs and expected outputs (or state transitions)
 - Edge cases and error behavior — what happens when input is invalid,
   when a dependency is unavailable, when the operation is interrupted?
 - Boundary conditions — empty lists, max values, concurrent access

 Write each requirement as a testable statement. "The API returns 404
 when the resource does not exist" is testable. "The API handles errors
 gracefully" is not.

 Reference actual files, functions, and types from the codebase.]

### Non-Functional Requirements
[You MUST evaluate every item in the checklist below. For each item:
 - State whether it applies to this task
 - If it applies: describe what is required, concretely
 - If it does not apply: briefly explain why not (one sentence)
 Then add any domain-specific non-functional requirements the checklist missed.

 Checklist:

 1. **Linting** — Does this change introduce code that must pass linters?
    Are there new lint rules needed? Does the existing lint config cover
    the new code patterns?

 2. **Building** — Does this compile/build cleanly? Are there new build
    steps, dependencies, or build config changes? Does it affect build
    time or artifact size?

 3. **Unit Testing** — What unit tests are needed? What functions, modules,
    or components need test coverage? What edge cases must be covered?

 4. **Integration Testing** — Do components interact in ways that need
    integration tests? API contracts, database queries, service
    communication, message queues?

 5. **End-to-End Testing** — Does this change user-facing behavior that
    needs E2E tests? What user flows are affected? What tool is
    appropriate for this project's stack (Playwright, Cypress, Detox,
    XCTest, etc.)?

 6. **Documentation** — Do code comments, README, API docs, changelog,
    or user-facing docs need updating? Are there architectural decision
    records (ADRs) to write?

 7. **Observability** — Does this need new or updated: metrics, alerts,
    log statements, dashboard panels, or runbook entries? Will operators
    know if this breaks in production?

 8. **Invariant Checking** — What invariants must hold? Are there runtime
    assertions, type constraints, or data consistency rules that should be
    enforced? Can any invariants be checked at build time vs. runtime?

 9. **Security** — Does this handle user input, authentication, authorization,
    secrets, or data at rest/in transit? Are there OWASP concerns? Does it
    need a security review?

 10. **Performance** — Does this affect latency, throughput, memory usage,
     or startup time? Are there benchmarks to run? Does it need load testing?

 11. **Backwards Compatibility** — Does this change public APIs, config
    formats, database schemas, or wire protocols? Is migration needed?
    Can old clients still work?

 12. **Accessibility** — Does this change UI? Does it meet WCAG guidelines?
    Screen reader support, keyboard navigation, color contrast?

 Additional domain-specific items:
 [Add any non-functional requirements specific to this task's domain
  that the checklist above did not cover.]]

## Acceptance Criteria
[Concrete, testable criteria that prove this task is done. Each criterion
 should be verifiable by running a command, inspecting output, or checking
 a measurable condition. Base the depth on the triage testing level:
 - none: build passes, lints clean
 - light: existing tests pass, no regressions
 - moderate: new test coverage for changed behavior
 - heavy: comprehensive test suite, E2E coverage, performance verification]

## Out of Scope
[What this change explicitly does NOT address. Prevents scope creep during
 planning and implementation.]`;

const DEFAULT_PLAN_TEMPLATE = `# Plan {N}: {title}

## Overview
[What this plan implements and why it is a self-contained, committable unit.
 Reference the spec requirements this plan addresses.]

## Changes
[Files to modify or create, with rationale for each change.
 Reference actual file paths and functions.]

## Spec Adherence
[List which spec requirements (functional and non-functional) this plan
 addresses. Every applicable spec requirement must be covered by at least
 one plan across the full plan set.]

## Acceptance Criteria

### Functional Checks
[What observable behavior proves this plan is correctly implemented.
 Each check should be concrete enough for the dev loop to implement as
 an automated test. Reference specific inputs, outputs, and state changes.]

### Non-Functional Checks
[From the spec's non-functional requirements that apply to this plan:
 which items must be satisfied? How will they be verified?
 Examples: "lint passes on new files", "unit tests cover the new parser",
 "API response time stays under 200ms for N=1000".]

## Validation Approach
[From the triage's validation matrix, what applies to this plan?
 - Immediate automated checks: what the dev loop should verify
 - Post-release checks: what to verify after deployment
 - Manual checks: what a human must review
 Describe the general approach — the dev loop will implement the scripts.]`;

// ============================================================================
// Default prompt constants for Phase 1
// ============================================================================

const DEFAULT_TRIAGE_PROMPT = `You are triaging a ticket for kautopilot. Read the ticket at {ticket} and do **thorough** codebase exploration to assess scope and risk.

Your job is to classify this ticket, NOT to solve it or write implementation details.

## Research Before Assessing

Do NOT guess at risk or complexity. Before writing your assessment:
- **Read the relevant code** — find the files that will be touched, understand the current implementation
- **Trace dependencies** — grep for usages of functions/types/configs being changed; understand blast radius
- **Check for tests** — are there existing tests covering the affected code? Will they break?
- **Look at recent changes** — git log the affected files to understand velocity and stability
- **Identify shared state** — does this touch database schemas, API contracts, shared configs, or public interfaces?

## Evaluate (with evidence)

For each evaluation point, cite specific files, functions, or patterns you found:
- **Complexity** — how many moving parts, how many files likely touched. Name the files.
- **Parallelizability** — can this be split into independent streams of work
- **Risk factors** — blast radius, backward compatibility, data migration. Be specific: "changing X in file Y affects Z callers"
- **Manual work** — infra changes, config deployments, manual verification needed
- **Known/unknown ratio** — is the approach clear or does it need research first
- **Disambiguate with user** — if the ticket is vague or under-specified, firm it up through conversation. If you are unsure about the risk level, ASK the user for input rather than defaulting to low risk.

## Risk Assessment Guidelines

Default to **moderate** risk unless you have concrete evidence otherwise:
- **Low risk**: Only if the change is truly isolated (single file, no callers, has test coverage, no shared state)
- **Moderate risk**: Multiple files, some callers, or any shared state involved
- **High risk**: Database/API changes, many callers, no test coverage, or unclear requirements

Err on the side of caution. It is much better to overestimate risk than to underestimate it.

## Verification

Your job is to IDENTIFY what needs verifying — not to do the verification yourself.
The spec and plan phases will perform the actual checks.

**Assumptions** — What does this task take for granted that could be wrong? Think broadly
across whatever domain this task touches. Any assumption about external behavior (libraries,
APIs, platforms, infrastructure, data formats, integrations) that the implementation will
depend on should be listed. For each, note what source could confirm or deny it.

**Access** — If verifying any assumption requires access the user hasn't granted (cluster
credentials, API keys, staging environments, etc.), request it here so it's available before
spec/plan writing begins.

**Testing level** — Set the bar based on blast radius and behavioral impact.

**Validation matrix** — Always push toward automated-immediate. Human time is far more
expensive than machine time. If something CAN be checked before release and CAN be automated,
it MUST be. Describe what to validate, not how.

## User Approval

After writing your triage assessment to the file, present a clear summary to the user showing:
1. The delivery kind and complexity you chose
2. Key risks identified (or why you believe risk is low)
3. Ask the user to confirm before you log the approval event. Do NOT auto-approve.`;

const DEFAULT_SPEC_WRITER_PROMPT = `You are writing a spec for a kautopilot task. Read the ticket at {ticket} and the triage assessment at {triage}.

Based on the triage assessment:
- **If triage says "straightforward"**: write a focused, concise spec. No heavy debate. Cover what to change, acceptance criteria, and proof of completion.
- **If triage says "moderate" or "complex"**: do thorough exploration and debate. Walk through requirements, identify hidden assumptions, conflicts, and risks. Clarify until nothing is ambiguous.
- **If delivery kind is "ticket"**: spec the research or decomposition, NOT the implementation.

Explore the codebase to ground your spec in reality. Reference actual files, functions, and patterns.

## Verification

Check the triage at {triage} for its verification section. If it lists assumptions to verify,
you MUST verify each one before writing the spec. Read docs, query live systems, inspect
package versions — whatever it takes. Cite evidence for each confirmed assumption. Flag
unverifiable ones as "UNVERIFIED: [assumption] — [reason]".

If the triage requested access, use it now to check actual state.

Ground every claim in evidence. No hypotheticals.

## Non-Functional Checklist

You MUST evaluate every item in the non-functional checklist from the spec template. For each:
decide if it applies, state why or why not, and describe the concrete requirement if it does.
Then add any domain-specific items the checklist missed. Do not skip any item.`;

const DEFAULT_PLAN_WRITER_PROMPT = `You are writing implementation plans for a kautopilot task. Read the spec at {spec} and the triage assessment at {triage}.

Rules:
- Plans must be vertically split (by domain/feature, not by layer)
- Each plan is one isolated, committable unit of work
- For "ticket" delivery: plans describe investigation steps or ticket creation, not code changes
- Reference actual files and functions from the codebase

## Verification & Testing

Check the triage at {triage}. Plans MUST NOT be based on unverified assumptions — the spec
should have resolved them. If any remain unverified in the spec, resolve them now or flag
them to the user.

Based on the triage testing level, suggest the general testing approach using tools
appropriate for this project's stack. Front-load automated testing aggressively.

For the validation matrix: describe the general approach in each plan. The dev loop will
implement concrete scripts. Keep it concise — ideas, not implementations.

## Spec Adherence

Every plan must list which spec requirements it addresses. Across the full set of plans,
every functional requirement and every applicable non-functional requirement from the spec
must be covered by at least one plan. If you discover a requirement cannot be addressed
as specified, flag it — do not silently drop it.`;

const phase1AgentsSchema = z.object({
  triage: agentSchema,
  spec_writer: agentSchema,
  plan_writer: agentSchema,
  spec_reviewers: z.record(z.string(), reviewerSchema).default({}),
  plan_reviewers: z.record(z.string(), reviewerSchema).default({}),
});

export const configSchema = z.object({
  claude_binary: z.string().default('claude'),
  agents: z.object({
    init: z.record(z.string(), agentSchema).default({}),
    phase1: phase1AgentsSchema,
    phase2: z.record(z.string(), agentSchema).default({}),
    phase3: z.record(z.string(), agentSchema).default({}),
    generic: z.record(z.string(), agentSchema).default({}),
  }),
  templates: z
    .object({
      triage: z.string().default(DEFAULT_TRIAGE_TEMPLATE),
      spec: z.string().default(DEFAULT_SPEC_TEMPLATE),
      plan: z.string().default(DEFAULT_PLAN_TEMPLATE),
    })
    .default({}),
  kloop: kloopConfigSchema,
  settings: z
    .object({
      maxPushCycles: z.number().min(1).max(20).default(10),
      pollInterval: z.number().min(1).max(300).default(5),
      defaultLlmTimeout: z.number().min(10).max(600).default(300),
      coderabbit: z.boolean().default(true),
      removeSpecOnPush: z.boolean().default(false),
    })
    .default({
      maxPushCycles: 10,
      pollInterval: 5,
      defaultLlmTimeout: 300,
      coderabbit: true,
      removeSpecOnPush: false,
    }),
  repo: z
    .object({
      org: z.string().optional(),
      baseBranch: z.string().default('main'),
      ticketSystem: z.string().nullable().default(null),
      prComment: z.string().nullable().default(null),
    })
    .default({
      baseBranch: 'main',
      ticketSystem: null,
      prComment: null,
    }),
});

export type Config = z.infer<typeof configSchema>;

// ============================================================================
// Default prompt strings (extracted from hardcoded values)
// ============================================================================

const DEFAULT_LOCAL_INIT_PROMPT = `You are setting up a task for kautopilot. Please:
1. Understand what this project needs (look at the codebase)
2. Write the ticket description to ~/.kautopilot/{sessionId}/artifacts/ticket.md
3. Write the task spec to ~/.kautopilot/{sessionId}/artifacts/v1/task-spec.md
4. Write implementation plans to ~/.kautopilot/{sessionId}/artifacts/v1/plans/plan-1.md

The ticket.md should describe the problem. The task-spec should describe the solution. Plans should be concrete steps.`;

const DEFAULT_RESEARCH_TICKET_SYSTEM_PROMPT = `Research this task/ticket system: "{taskSystem}"

Generate a concise research doc covering:

a) What is it? (brief description)

b) Access methods — does it have:
   - A CLI tool? (name, install method)
   - A REST/GraphQL API? (base URL, auth method)
   - An MCP server? (package name, setup)
   - What is the standard/recommended way to interact with it programmatically?
   List ALL options with their pros/cons.

c) Structure/hierarchy:
   - How is work organized? (spaces → folders → lists, or projects → epics → stories, etc.)
   - What is the typical ticket/task hierarchy?

d) Ticket transitions:
   - How do status transitions work?
   - Are they simple (just set status) or complex (must follow workflow, use transition IDs)?
   - What are the typical states?
   - Are there restrictions on which transitions are valid?

Detected CLI tools on this system:
{detectedInfo}

Keep it factual and concise. Output as markdown.`;

const DEFAULT_RESEARCH_SETUP_PROMPT = `The user needs to set up access to "{taskSystem}" but it may be partially configured or not authenticated yet.

Access hint from the user: {accessMethod}

Based on the research above, propose the simplest setup path.

1. What is the recommended access method? (CLI, API token, MCP server)
2. Give step-by-step setup instructions
3. How to verify it works (test command)
4. If the user already has the CLI installed, include auth/context checks before assuming it works

Keep it concise and actionable.`;

const DEFAULT_CREATE_SCRIPTS_PROMPT = `You are creating ticket integration scripts for kautopilot.

## Context
Ticketing system: {taskSystem}
Access method: {accessMethod}
State mapping: {stateMapping}
{transitionNoOp}
Current branch: {branch}
Scripts dir: {scriptsDir}
{quirks}
Setup assessment: {setupAssessment}

## Research Doc (from earlier research)
{researchDoc}

Detected CLI tools:
{detectedInfo}

## Create Scripts

Create these scripts:
{scriptList}
{optionalScripts}

Script requirements:
- All scripts must be executable bash scripts (#!/usr/bin/env bash)
- Use set -euo pipefail for robustness
- extract-ticket: parse branch name to extract ticket ID
  - Current branch: "{branch}"
- get-ticket: output markdown content of the ticket
- Transition scripts:
  - Research how transitions work for this specific system
  - If transitions are complex (e.g., Jira workflows), use the correct transition IDs
  - Verify auth and project/site context are working before using API/CLI calls
  - For Jira/Atlassian CLI, do not guess workflow names or transition IDs; discover them first or fall back to a clear no-op with explanation

## Test

IMPORTANT: Test each script for real.

1. Test extract-ticket:
   echo "{branch}" | {scriptsDir}/extract-ticket
2. Test get-ticket with the extracted ID:
   {scriptsDir}/get-ticket <ticket-id>
3. Test transition scripts (if not no-ops):
   - Transition the ticket, verify it moved, then revert it back
   - Do NOT leave tickets in a wrong state

## Report

Output a SUMMARY with:
- Script name, Status (CREATED / NO-OP / FAILED), what you tried, test result
- If failed: why and how the user can fix it

NEVER leave a broken script — either it works or it is a no-op.`;

// ============================================================================
// Shared Commit Agent Prompt
// ============================================================================

/**
 * Generic commit agent prompt used across phases.
 * Variable: {context} — optional context to include (e.g., plan content).
 * If no context needed, pass empty string or omit.
 */
const DEFAULT_COMMIT_PROMPT = `You are committing code changes in a repository. Your task:

1. Discover commit conventions:
   - Search for any .md file whose name contains "commit" (case-insensitive), e.g. COMMIT_CONVENTIONS.md, commit-guide.md
   - Check for .commitlintrc, .commitlintrc.json, .commitlintrc.yml, .commitlintrc.yaml, .commitlintrc.js, commitlint.config.js, commitlint.config.ts
   - Check package.json for a "commitlint" config section
   - Read git log --oneline -10 to see existing commit message style

2. Stage all changes (git add the specific changed files, never git add -A)

3. Commit with a message that follows the discovered conventions. If no conventions found, use conventional commits style (e.g. "feat: ...", "fix: ...", etc.) matching the style of recent commits.

4. If pre-commit hooks fail:
   - Read the error output carefully
   - Fix the underlying issues (formatting, lint, type errors, etc.)
   - Re-stage the fixed files and retry the commit

5. When done, output ONLY the commit SHA (the output of git rev-parse HEAD), nothing else.

{context}`;

// Legacy export for backward compatibility - prefer getAgentPrompt('generic', 'commit')
export const COMMIT_AGENT_PROMPT = DEFAULT_COMMIT_PROMPT;

export const DEFAULT_CONFIG: Config = {
  claude_binary: 'claude',
  agents: {
    init: {
      localInit: {
        // Available vars: {sessionId}
        prompt: DEFAULT_LOCAL_INIT_PROMPT,
      },
      researchTicketSystem: {
        // Available vars: {taskSystem}, {detectedInfo}
        prompt: DEFAULT_RESEARCH_TICKET_SYSTEM_PROMPT,
      },
      researchSetup: {
        // Available vars: {taskSystem}, {accessMethod}
        prompt: DEFAULT_RESEARCH_SETUP_PROMPT,
      },
      createScripts: {
        // Available vars: {taskSystem}, {accessMethod}, {stateMapping}, {transitionNoOp}, {branch}, {scriptsDir}, {quirks}, {setupAssessment}, {researchDoc}, {detectedInfo}, {scriptList}, {optionalScripts}
        prompt: DEFAULT_CREATE_SCRIPTS_PROMPT,
      },
    },
    phase1: {
      // Available vars: {ticket} — file path, NOT inlined content
      // Mechanics prepended by handler: TRIAGE_MECHANICS (output file, approval gate)
      triage: { prompt: DEFAULT_TRIAGE_PROMPT },
      // Available vars: {ticket}, {triage} — file paths, NOT inlined content
      // Mechanics prepended by handler: SPEC_MECHANICS (ordinal drafts, approval protocol)
      spec_writer: { prompt: DEFAULT_SPEC_WRITER_PROMPT },
      // Available vars: {spec}, {triage} — file paths, NOT inlined content
      // Mechanics prepended by handler: PLAN_MECHANICS (ordinal drafts, approval protocol, spec amendment escalation)
      plan_writer: { prompt: DEFAULT_PLAN_WRITER_PROMPT },
      spec_reviewers: {
        // All reviewers: Available vars {spec}, {ticket} — file paths, NOT inlined content
        completeness: {
          desc: 'All requirements from ticket covered',
          prompt: `Read the spec at {spec} and the ticket at {ticket}.
Check: does the spec address every requirement in the ticket?
List any requirements that are missing or insufficiently addressed.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
        },
        docs_accuracy: {
          desc: 'Referenced tool/lib versions and interfaces are correct',
          prompt: `Read the spec at {spec} and the ticket at {ticket}.
Check: are all referenced tool versions, API interfaces, and method signatures accurate?
Cross-reference with the codebase — grep for referenced functions, check package versions.
Flag anything that looks hallucinated or version-incorrect.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
        },
        generalization: {
          desc: 'Extends existing patterns rather than inventing new ones',
          prompt: `Read the spec at {spec}. Explore the codebase.
Check: does the spec propose new patterns, paths, or abstractions when existing ones could be extended?
Flag any "reinventing the wheel" — new utilities when similar ones exist, new conventions when the codebase already has one.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
        },
        complexity: {
          desc: 'Is there a simpler or faster approach?',
          prompt: `Read the spec at {spec}.
Check: is the proposed approach unnecessarily complex?
Consider: could fewer files be changed? Could an existing tool/command handle this? Is there a more direct path?
Don't flag reasonable complexity — only flag when there's a clearly simpler alternative.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
        },
        security: {
          desc: 'Security and compliance implications',
          prompt: `Read the spec at {spec}.
Check for security concerns: injection risks, auth/authz gaps, secrets handling, data exposure, OWASP top 10.
Only flag genuine issues, not theoretical concerns in internal code paths.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
        },
        proof_of_completion: {
          desc: 'Spec includes testable acceptance criteria',
          prompt: `Read the spec at {spec}.
Check: does the spec include an "Acceptance Criteria" section with concrete, testable criteria?
Good criteria: test commands, API calls, grep assertions, build commands, measurable conditions.
Bad criteria: "manually verify", "visually check", vague assertions, unmeasurable claims.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
        },
        nonfunctional_checklist: {
          desc: 'All non-functional checklist items evaluated',
          prompt: `Read the spec at {spec}.
Check: has every item in the non-functional checklist been evaluated?
The checklist has 12 standard items (linting, building, unit testing, integration testing,
E2E testing, documentation, observability, invariant checking, security, performance,
backwards compatibility, accessibility). For each item, the spec must state whether it
applies and why.
Flag any items that are missing, skipped without justification, or dismissed too quickly.
Also check: did the spec add domain-specific non-functional items beyond the checklist?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
        },
        verification_evidence: {
          desc: 'All triage assumptions have verification evidence',
          prompt: `Read the spec at {spec} and the triage at {triage}.
Check: if the triage listed assumptions to verify, does the spec provide verification
evidence for each one? Evidence must include a concrete source (doc URL, file path,
command output, live query result).
Flag any assumptions that are unaddressed or claimed as verified without evidence.
Flag any "UNVERIFIED" items and assess whether they are blocking.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
        },
      },
      plan_reviewers: {
        // All reviewers: Available vars {plans}, {spec} — file paths, NOT inlined content
        coverage: {
          desc: 'Plans fully cover the spec',
          prompt: `Read the plans at {plans} and the spec at {spec}.
Check: do the plans together cover every requirement in the spec?
List any spec items that are not addressed by any plan.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
        },
        ordering: {
          desc: 'Plan dependencies ordered correctly',
          prompt: `Read the plans at {plans}.
Check: are plans ordered so that earlier plans don't depend on later ones?
Flag any circular or incorrect dependency ordering.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
        },
        vertical_split: {
          desc: 'Plans split by domain/feature, not by layer',
          prompt: `Read the plans at {plans}.
Check: are plans split vertically by domain/feature (each plan = complete slice with types+logic+tests)?
Flag any plan that is a horizontal layer (e.g., "add types" or "write tests" as standalone plans).
Each plan should produce an isolated working commit.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
        },
        cost: {
          desc: 'Cost and resource implications',
          prompt: `Read the plans at {plans} and the spec at {spec}.
Check: are there cost implications (compute, storage, API calls, third-party services)?
Flag any plans that could have unexpected cost impact without mentioning it.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
        },
        spec_adherence: {
          desc: 'Plans address all spec requirements, no drift',
          prompt: `Read the plans at {plans} and the spec at {spec}.
Check: across all plans, is every functional requirement from the spec addressed by at
least one plan? Is every applicable non-functional requirement addressed?
List any spec requirements that are not covered by any plan.
List any plan content that introduces scope not present in the spec (scope creep).
If you find drift — plans that contradict or ignore spec requirements — flag each instance
with the specific spec requirement and the conflicting plan content.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
        },
      },
    },
    phase2: {
      resolve: {
        // Available vars: {task_spec_path}, {plan_path}, {plans_dir}, {kloop_evidence}, {feedback_path},
        //   {plan_name}, {completed_plans_list}, {incomplete_plans_list}, {planTemplate}
        prompt: `## Context Paths
- Task spec: {task_spec_path}
- Current plan: {plan_path}
- Plans directory: {plans_dir}

Read these files to understand the original intent.

## Kloop Evidence

{kloop_evidence}

## What Happened

The implementation loop for {plan_name} could not complete within its iteration limit.
Review the kloop evidence above to understand what went wrong.

## Decision Required

Based on your analysis, you MUST choose one of these rewrite strategies.
Discuss each option with the user and decide together:

1. **refine_local** — The current plan is mostly correct but needs targeted fixes.
   Choose when: the kloop was close to passing, issues are localized to this plan.
   Effect: you rewrite the current plan, then a second review pass iterates on it.

2. **patch_downstream** — Completed plans are fine, but remaining plans need updates
   to account for what was learned. Choose when: earlier plans changed the approach
   and downstream plans are now out of date.
   Effect: you patch remaining plans, then a second review pass iterates on them.

3. **regenerate_remaining** — Too much has changed; remaining plans should be
   regenerated from scratch against the spec. Choose when: fundamental assumptions
   shifted and incremental patches won't suffice.
   Effect: you regenerate incomplete plans, then a second review pass iterates on them.

4. **revisit_spec** — The spec itself has a contradiction or fundamental issue that
   makes it impossible for ANY plan to succeed.
   Choose when: the problem isn't the plans, it's what they're implementing.
   Effect: you write feedback explaining what's wrong, then a second review pass
   validates the feedback before escalating to a full replan.

## After Deciding — You MUST Do All Three Steps

### Step 1: Write the amendment

For **refine_local**: Rewrite ONLY {plan_name} ({plan_path}). Each plan file MUST follow the template: {planTemplate}

For **patch_downstream**: Rewrite INCOMPLETE plan files only.
Completed plans (DO NOT edit):
{completed_plans_list}
Incomplete plans to update:
{incomplete_plans_list}
Each plan file MUST follow the template: {planTemplate}

For **regenerate_remaining**: Rewrite ALL incomplete plan files from scratch.
Completed plans (DO NOT edit):
{completed_plans_list}
Incomplete plans to regenerate:
{incomplete_plans_list}
Each plan file MUST follow the template: {planTemplate}

For **revisit_spec**: Write feedback to {feedback_path} explaining what went wrong and what spec changes are needed.

### Step 2: Snapshot the amendment

\`\`\`bash
kautopilot snapshot plans
\`\`\`
For revisit_spec, use: \`kautopilot snapshot spec\`

The epoch version is auto-detected. This step is COMPULSORY — exit without a snapshot
and this step will restart from scratch.

### Step 3: Log your decision

\`\`\`bash
kautopilot log-event context:updated --metadata '{"rewriteDecision": "<your_choice>"}'
\`\`\`

Replace \`<your_choice>\` with one of: refine_local, patch_downstream, regenerate_remaining, revisit_spec.

After all three steps are done, tell the user the draft is ready for review and /exit.
A second TTY will open so you and the user can iterate on the amendment before it's finalized.

### If You Want to Abandon

If the situation is unsalvageable and you want to give up entirely:
\`\`\`
kautopilot log-event resolve:abandoned
\`\`\`
Then /exit. The session will be marked as failed.`,
      },
      rewrite_spec: {
        // Available vars: {decision_title}, {decision_specific_review_section}, {kloop_evidence},
        //   {task_spec_path}, {plans_dir}, {snapshot_type}, {approval_event}, {feedback_path}
        prompt: `## Review Amendment: {decision_title}

{decision_specific_review_section}

## Kloop Evidence

{kloop_evidence}

## Context Paths
- Task spec: {task_spec_path}
- Plans directory: {plans_dir}

Read these files to understand the original intent and verify the amendment.

## CRITICAL: Iteration & Approval Mechanics

### Working Copies

Edit files directly in their directories. Each version MUST be a complete, standalone
document — NOT a diff or changelog.

### Snapshot Workflow (COMPULSORY)

After each edit cycle, you MUST create a snapshot:
\`\`\`bash
kautopilot snapshot {snapshot_type}
\`\`\`

This copies the working copies to a versioned snapshot. It outputs:
- SNAPSHOT_VERSION=N
- SNAPSHOT_PATH=...

The epoch version is auto-detected from the session — you do not need to specify it.

This step is COMPULSORY.

### Approval Protocol

When the user approves the amendment, you MUST do these things IN ORDER:
1. Write the approval event:
   \`\`\`bash
   kautopilot log-event {approval_event}
   \`\`\`
2. THEN tell the user to /exit

**CRITICAL**: Do NOT tell the user to /exit before writing the approval event.
If the session crashes or the user Ctrl+C's before the approval event is logged,
the amendment will NOT be considered approved and this step will re-run.

### If You Want to Abandon

\`\`\`
kautopilot log-event resolve:abandoned
\`\`\`
Then /exit. The session will be marked as failed.`,
      },
      // NOTE: 'commit' uses shared COMMIT_AGENT_PROMPT directly (not in config)
      // Handlers import COMMIT_AGENT_PROMPT and build prompt with {context} var
    },
    phase3: {
      eval: {
        // Available vars: {spec_path}, {plan_paths} — file paths, NOT inlined content
        prompt: `Analyze PR feedback and decide what action to take.
Be precise: only suggest code_fix for genuine issues.
Mark items as ambiguous when you're unsure rather than guessing.`,
      },
      write_fix: {
        // Available vars: none — context is prepended by handler
        prompt: `Merge all pending code fixes into a single coherent implementation spec.
Deduplicate overlapping fixes on the same file.
Output the complete spec (not just the changes).`,
      },
      // NOTE: 'commit_pending' uses shared COMMIT_AGENT_PROMPT directly (not in config)
      // Handlers import COMMIT_AGENT_PROMPT and build prompt with {context} var
      prereview_classify: {
        // Available vars: none — content is prepended by handler
        prompt: `Classify CodeRabbit findings as fix/comment/ignore.
Be conservative — only mark as "fix" if it's a genuine issue.`,
      },
      prereview_fix: {
        // Available vars: none — content is prepended by handler
        prompt: `Apply the classified fixes to the codebase.
Be precise and minimal — only change what's needed.`,
      },
      create_pr: {
        // Available vars: {baseBranch}, {ticketId}, {spec_path} — file path, NOT inlined content
        prompt: `You are creating a GitHub Pull Request. Your task:

1. Discover PR conventions:
   - Check for PR templates: .github/PULL_REQUEST_TEMPLATE.md, .github/pull_request_template.md, or any template in .github/PULL_REQUEST_TEMPLATE/
   - Check CONTRIBUTING.md for PR guidelines
   - Look at recent merged PRs for title/body style: gh pr list --state merged --limit 5 --json title,body

2. Create a PR against the "{baseBranch}" branch using gh pr create:
   - Title must start with "[{ticketId}]" followed by a concise summary of what was implemented
   - Body should follow the discovered template/conventions, or include a summary, what changed, and how to test

3. Output ONLY a JSON object with the PR number and URL:
   {"number": <int>, "url": "<string>"}`,
      },
      tty_resolve_ambiguous: {
        // Available vars: none — context is prepended by handler
        prompt: `Help resolve ambiguous items from the PR review.
For each item, decide: reply, code fix, or skip.`,
      },
      tty_resolve_conflict: {
        // Available vars: none — context is prepended by handler
        prompt: `Help resolve merge conflicts from the rebase.
Resolve conflicts while preserving the intent of both changes.`,
      },
      tty_resolve_failure: {
        // Available vars: none — context is prepended by handler
        prompt: `The dev-loop execution failed. Help investigate and determine next steps.
Options: fix the issue and retry, skip and move on, or escalate.`,
      },
      feedback: {
        // Available vars: {task_spec_path}, {plans_dir}, {pr_url}, {checks_status}, {thread_count}, {feedback_path}
        prompt: `## Context Paths
- Task spec: {task_spec_path}
- Plans directory: {plans_dir}

Read these files to understand the original intent.

## PR State
- URL: {pr_url}
- Checks status: {checks_status}
- Open threads: {thread_count}

## Discussion

Discuss with the user:
1. What about the PR needs improvement?
2. Is this an implementation issue or a spec issue?
3. What should change in the spec to address this?

## Feedback

When ready, write the feedback to {feedback_path}
The feedback will be used to guide the next iteration.

After writing feedback, return the revisit_spec signal.`,
      },
    },
    generic: {
      // Available vars: {context} — optional context (e.g., plan path, reason for commit)
      commit: { prompt: DEFAULT_COMMIT_PROMPT },
    },
  },
  templates: {
    triage: DEFAULT_TRIAGE_TEMPLATE,
    spec: DEFAULT_SPEC_TEMPLATE,
    plan: DEFAULT_PLAN_TEMPLATE,
  },
  kloop: {
    implementers: { claude: 1 },
    reviewPhases: [['claude']],
    conflictChecker: 'claude',
    maxIterations: 7,
    implementerTimeout: 30,
    reviewerTimeout: 15,
    conflictCheckThreshold: 3,
    compressSpec: false,
    firstLoopFullReview: true,
    previousReviewPropagation: 0.7,
    prompts: {
      implementer: DEFAULT_KLOOP_IMPLEMENTER_PROMPT,
      reviewer: DEFAULT_KLOOP_REVIEWER_PROMPT,
      checkpointer: DEFAULT_KLOOP_CHECKPOINTER_PROMPT,
      checkpointerFull: DEFAULT_KLOOP_CHECKPOINTER_FULL_PROMPT,
    },
  },
  settings: {
    maxPushCycles: 10,
    pollInterval: 60,
    defaultLlmTimeout: 300,
    coderabbit: true,
    removeSpecOnPush: false,
  },
  repo: {
    baseBranch: 'main',
    ticketSystem: null,
    prComment: null,
  },
};

// ============================================================================
// Session Row (index.db)
// ============================================================================

export type SessionState = 'init' | 'ready' | 'running' | 'done';

export interface SessionRow {
  id: string;
  repo_path: string;
  worktree: string;
  git_root: string;
  git_root_host: string;
  ticket_id: string | null;
  branch: string | null;
  local: number;
  state: SessionState;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Phase 3 Types
// ============================================================================

export type PollState = 'pending' | 'blocked' | 'mergeable';

export interface PollThread {
  id: string;
  isOutdated: boolean;
  author: string;
  body: string;
  firstCommentId: string;
  replies: PollReply[];
}

export interface PollReply {
  id: string;
  author: string;
  body: string;
  isBot: boolean;
}

export interface CheckStatus {
  name: string;
  status: 'pending' | 'passing' | 'failing';
}

// ============================================================================
// Delivery Kind & Contract Model
// ============================================================================

export type DeliveryKind = 'pr' | 'ticket';

export interface ContractManifest {
  version: number;
  deliveryKind: DeliveryKind;
  specFile: string;
  planCount: number;
  createdAt: string;
  supersededBy?: number;
  supersededAt?: string;
}

export interface PlanManifest {
  plans: Array<{
    ordinal: number;
    activeRewrite: number;
    file: string;
    completed: boolean;
    commitSha?: string;
  }>;
}

export interface DeliveryManifest {
  kind: DeliveryKind;
  prNumber?: number;
  prUrl?: string;
  prRolloverHistory?: Array<{
    fromPr: number;
    toPr: number;
    reason: string;
    timestamp: string;
  }>;
  ticketArtifacts?: string[];
  publishedAt?: string;
}

// ============================================================================
// Phase Constants
// ============================================================================

export const PHASES = ['plan', 'implementation', 'polish'] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_ALIASES: Record<string, Phase> = {
  plan: 'plan',
  impl: 'implementation',
  implementation: 'implementation',
  polish: 'polish',
};

// ============================================================================
// Lock File
// ============================================================================

export interface LockInfo {
  locked: boolean;
  pid: number;
  alive: boolean;
}
