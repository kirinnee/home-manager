import type { TypeConfig } from './types';

// ============================================================================
// Common building blocks — shared across types
// ============================================================================

const COMMON_SPEC_REVIEWERS = {
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
  skill_adherence: {
    desc: 'Should existing Claude Code skills be used?',
    prompt: `Read the spec at {spec} and the plans at {plans}.
Check: could any part of this work be handled by an existing Claude Code skill (e.g., per-file-fix for multi-file mechanical changes, research for investigation, fact-check for verification)?
If a skill would be more appropriate than raw implementation, flag it.
Output ONLY the suggestions — one per line. If none, output "No issues found."`,
  },
  proof_of_completion: {
    desc: 'Spec includes programmatic proof of completion',
    prompt: `Read the spec at {spec}.
Check: does the spec include a "Proof of Completion" section with concrete, runnable verification?
Good proofs: test commands, API calls, grep assertions, build commands, tf plan output.
Bad proofs: "manually verify", "visually check", vague assertions.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
  },
};

const COMMON_PLAN_REVIEWERS = {
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
  cost: {
    desc: 'Cost and resource implications',
    prompt: `Read the plans at {plans} and the spec at {spec}.
Check: are there cost implications (compute, storage, API calls, third-party services)?
Flag any plans that could have unexpected cost impact without mentioning it.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
  },
  skill_usage: {
    desc: 'Plans reference appropriate Claude Code skills',
    prompt: `Read the plans at {plans}.
Check: for mechanical multi-file changes, do plans suggest using per-file-fix or similar skills?
For research-heavy steps, do plans suggest the research skill?
Only flag if a skill would clearly be better than raw implementation.
Output ONLY the suggestions — one per line. If none, output "No issues found."`,
  },
};

// ============================================================================
// Spec writer prompt template — debate orchestrator
// ============================================================================

function specWriter(typeFocus: string, sections: string): string {
  return `You are running a specification debate. Your goal: produce a spec that is
unambiguous, conflict-free, and achievable. The spec focuses on WHAT, not HOW.

Context:
- Ticket: {ticket}
- Worktree: {worktree}
- Spec drafts directory: {specDir}

${typeFocus}

## Phase 1: Gather Context — Create a Team

Before writing anything, you MUST create a team to gather context in parallel.
Use Claude Code's team/subagent capabilities to spawn teammates:

- **code-explorer**: Read the ticket at {ticket}. Explore relevant code paths — find the files,
  functions, types, and tests that relate to the ticket requirements. Report back what you found.
- **lib-checker**: Check tool/library versions in package.json / lock files. Look up their docs
  to verify API interfaces. Report any version-specific gotchas or deprecated APIs.
- **pattern-finder**: Find existing patterns and abstractions in the codebase that should be
  reused or extended. Report existing conventions, test patterns, naming schemes.

Wait for all teammates to report back. Synthesize their findings into your understanding.
Do NOT write a separate understanding document — the understanding feeds directly into the spec.

## Phase 2: Debate & De-ambiguate

Discuss with the user:
1. Walk through each requirement from the ticket — are there hidden assumptions?
2. Identify conflicts between requirements (e.g., "full test coverage" + "don't touch source code" — is the code even testable?)
3. Identify risks — what could go wrong? What's the blast radius?
4. For each risk: is it a spec problem (rewrite requirement) or a plan problem (handle during implementation)?
5. Keep clarifying until NOTHING is left ambiguous.

Do NOT proceed to writing the spec until the user confirms the requirements are clear.

## Phase 3: Write Spec

Write spec-draft-1.md with the following sections:

${sections}

The spec must NOT contain:
- Which files to change or implementation details
- Code snippets or internal architecture decisions
- References to specific function names or line numbers

The spec SHOULD contain:
- What the end result looks like (observable behavior)
- Acceptance criteria (testable, concrete, verifiable)
- Constraints and explicit non-goals
- Risks identified during the debate and their mitigations
- Proof of completion (runnable commands that prove every criterion is met)

## Phase 4: Review & Iterate

1. Add a **reviewer** teammate to the team: have it run \`kautopilot spec-review\` and return the summary
2. Evaluate each issue — fix what's real, ask the user about anything uncertain
3. Write a NEW spec-draft-N.md (incremented ordinal) with the fixes
4. Re-run the reviewer teammate after significant changes
5. Repeat until you and the user are satisfied

Be precise and concrete. Avoid vague criteria. Every requirement should be verifiable.`;
}

// ============================================================================
// Plan writer prompt template — code-aware implementation planning
// ============================================================================

function planWriter(typeFocus: string): string {
  return `You are writing implementation plans derived from the approved spec.

Context:
- Spec: {spec}
- Worktree: {worktree}

Write plans to: {plans}/plan-1.md, plan-2.md, etc.

${typeFocus}

## Before Writing

Read the spec thoroughly. Then explore the codebase to understand:
- Which files and functions will need to change
- What existing patterns and abstractions to follow
- Where tests live and how they're structured
- Any technical constraints not captured in the spec

Use this understanding to **de-conflict**. If the spec asks for something that's not achievable
given the current code (e.g., "add tests without changing source" but the code isn't testable),
FLAG IT to the user before writing plans. The spec may need revision.

## Plan Structure

Each plan should be a self-contained unit of work completable in one dev-loop run. Include:
1. **Objective** — what this plan accomplishes
2. **Files to modify** — specific file paths
3. **Implementation steps** — concrete, ordered steps
4. **Test plan** — how to verify this plan's work
5. **Proof of completion** — command(s) that prove it worked

Order plans by dependency — earlier plans must not depend on later ones.

## Process

1. Read the spec carefully
2. Explore the codebase for each area the spec touches
3. Break the spec into logical, ordered plans
4. Run reviewers: create a sub-teammate to run \`kautopilot plan-review\` and return the summary
5. Fix issues, ask user about uncertainties
6. When satisfied, tell the user to /exit`;
}

// ============================================================================
// Type definitions
// ============================================================================

const product: TypeConfig = {
  desc: 'Product feature work — new functionality, enhancements, UI changes',
  spec_writer: {
    prompt: specWriter(
      'This is **product work** — focus on clear acceptance criteria, definition of done, and quality gates.',
      `- **Objective** — what the feature does and why
- **Acceptance Criteria** — numbered, testable criteria (Given/When/Then or similar)
- **Definition of Done** — quality gates: test coverage, performance benchmarks, accessibility
- **Out of Scope** — explicitly list what this does NOT include
- **Technical Constraints** — API contracts, backward compatibility, performance budgets
- **Proof of Completion** — commands/tests that prove every acceptance criterion is met`,
    ),
  },
  spec_reviewers: {
    ...COMMON_SPEC_REVIEWERS,
    quality_gates: {
      desc: 'Acceptance criteria, DoD, and test coverage',
      prompt: `Read the spec at {spec}.
Check: does the spec have clear, testable acceptance criteria (not vague)?
Does the Definition of Done include test coverage requirements?
Are quality gates concrete (e.g., "all tests pass", "< 200ms p95") not aspirational?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
  },
  plan_writer: {
    prompt: planWriter(
      'This is **product work**. Plans should include test coverage for each feature increment. Prefer small, shippable increments.',
    ),
  },
  plan_reviewers: {
    ...COMMON_PLAN_REVIEWERS,
    test_coverage: {
      desc: 'Each plan includes adequate test coverage',
      prompt: `Read the plans at {plans} and the spec at {spec}.
Check: does each plan include tests for the functionality it adds?
Are edge cases considered? Is there integration test coverage?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
  },
  kloopPrompts: {
    reviewer:
      'Focus on: acceptance criteria coverage, test completeness, whether each feature increment is shippable and independently verifiable.',
  },
};

const product_bug: TypeConfig = {
  desc: 'Product bug — user-facing defect requiring reproduction and root cause analysis',
  spec_writer: {
    prompt: specWriter(
      'This is a **product bug fix** — focus on reproduction, root cause, and regression prevention.',
      `- **Problem Statement** — what is broken and who is affected
- **Reproduction Steps** — exact steps to trigger (or "not yet reproduced" with investigation plan)
- **Root Cause Analysis** — what code path causes this and why
- **Fix Approach** — proposed fix with rationale
- **Regression Test** — specific test(s) that prevent this from recurring
- **Proof of Completion** — commands that prove the fix works and regression test passes`,
    ),
  },
  spec_reviewers: {
    ...COMMON_SPEC_REVIEWERS,
    reproducibility: {
      desc: 'Clear reproduction steps and root cause identified',
      prompt: `Read the spec at {spec}.
Check: are reproduction steps concrete and actionable (not "sometimes it happens")?
Is the root cause identified with code references, or is it still speculative?
Does the fix address the root cause, not just a symptom?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
  },
  plan_writer: {
    prompt: planWriter(
      'This is a **bug fix**. First plan should verify reproduction. Last plan should add a regression test. Fix should be minimal and targeted.',
    ),
  },
  plan_reviewers: {
    ...COMMON_PLAN_REVIEWERS,
    regression: {
      desc: 'Plans include regression test',
      prompt: `Read the plans at {plans}.
Check: is there a plan that adds a regression test for this specific bug?
Does the test verify the exact scenario from the reproduction steps?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
  },
  kloopPrompts: {
    reviewer:
      'Focus on: regression risk, minimal scope of change, root cause correctly addressed (not symptom masking), regression test covers exact reproduction scenario.',
  },
};

const infra_bug: TypeConfig = {
  desc: 'Infrastructure bug — infra/platform defect requiring risk-assessed, read-only investigation',
  spec_writer: {
    prompt: specWriter(
      `This is an **infrastructure bug** — ALL investigation must be READ-ONLY. Focus on risk assessment and programmatic proof.

CRITICAL RULES:
- NO write operations during investigation (no terraform apply, no kubectl apply, no helm upgrade)
- Use read-only commands: terraform plan, helm template, kubectl get, kubectl diff
- Every proposed change must have a "dry run" verification step
- Include rollback plan for every write operation in the fix`,
      `- **Problem Statement** — what infrastructure is broken and impact
- **Impact Assessment** — blast radius, affected services, users impacted
- **Root Cause Analysis** — from read-only investigation only
- **Risk Assessment** — risk of the bug vs risk of the fix (matrix)
- **Fix Approach** — with dry-run verification for each step
- **Read-Only Verification Plan** — how to prove the fix will work BEFORE applying (tf plan, helm diff, kubectl diff, etc.)
- **Rollback Plan** — exact steps to revert if the fix causes issues
- **Proof of Completion** — programmatic commands that prove the fix worked (not "check the dashboard")`,
    ),
  },
  spec_reviewers: {
    ...COMMON_SPEC_REVIEWERS,
    risk_assessment: {
      desc: 'Blast radius and risk matrix present',
      prompt: `Read the spec at {spec}.
Check: is there a clear risk assessment comparing bug-risk vs fix-risk?
Is the blast radius documented (what services, how many users)?
Are there any write operations proposed without a dry-run step?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
    read_only_proof: {
      desc: 'All verification is read-only before any write',
      prompt: `Read the spec at {spec}.
Check: does the spec use ONLY read-only verification before writes?
Good: terraform plan, helm template/diff, kubectl get/diff, cloud CLI describe
Bad: terraform apply, helm upgrade, kubectl apply without prior diff
Flag any verification step that involves a write operation.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
  },
  plan_writer: {
    prompt: planWriter(`This is an **infrastructure bug fix**. Plans MUST follow this order:
1. Read-only investigation and state capture
2. Dry-run verification (tf plan, helm diff, etc.)
3. Fix with rollback plan
4. Post-fix verification

NO write operations in investigation plans. Every write plan must have a preceding dry-run plan.`),
  },
  plan_reviewers: {
    ...COMMON_PLAN_REVIEWERS,
    safe_ordering: {
      desc: 'Read-only before writes, dry-run before apply',
      prompt: `Read the plans at {plans}.
Check: do read-only investigation plans come before any write plans?
Does every write plan have a preceding dry-run verification step?
Is there a rollback plan for each write operation?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
  },
  kloopPrompts: {
    reviewer:
      'Focus on: safety of changes, rollback plan present and testable, dry-run verification completed before any write operation, no side effects beyond scope.',
  },
};

const ops: TypeConfig = {
  desc: 'Ops work — upgrades, migrations, infrastructure changes with rollback planning',
  spec_writer: {
    prompt: specWriter(
      `This is **ops work** (upgrade/migration) — focus on risk assessment, read-only verification, and rollback at every step.

CRITICAL RULES:
- Every change must have a "before" state capture and "after" verification
- Read-only verification before any write (tf plan, helm diff, disable autosync, etc.)
- Rollback plan for EVERY step, not just the overall change
- Consider: can we do this with zero downtime?`,
      `- **Objective** — what is being upgraded/migrated and why
- **Current State** — exact versions, config, architecture now
- **Target State** — exact versions, config, architecture after
- **Risk Assessment** — what could go wrong, likelihood, mitigation
- **Pre-Change Verification** — read-only checks before starting (disable autosync, capture state)
- **Migration Steps** — ordered, with dry-run before each write
- **Rollback Plan** — per-step rollback, not just "revert everything"
- **Post-Change Verification** — how to prove the migration succeeded
- **Proof of Completion** — programmatic commands (not "check dashboard")`,
    ),
  },
  spec_reviewers: {
    ...COMMON_SPEC_REVIEWERS,
    risk_assessment: {
      desc: 'Risk matrix with likelihood and mitigation',
      prompt: `Read the spec at {spec}.
Check: is there a risk assessment with specific risks, not just "things might break"?
Does each risk have a mitigation strategy?
Is downtime considered and quantified?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
    rollback_plan: {
      desc: 'Per-step rollback procedure documented',
      prompt: `Read the spec at {spec}.
Check: is there a rollback plan for each migration step (not just overall)?
Can rollback be executed without additional risk?
Are rollback steps concrete commands, not vague instructions?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
    read_only_proof: {
      desc: 'Read-only verification before writes',
      prompt: `Read the spec at {spec}.
Check: does every write step have a preceding read-only verification?
Examples: terraform plan before apply, helm diff before upgrade, kubectl diff before apply.
Flag any write without prior read-only verification.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
  },
  plan_writer: {
    prompt: planWriter(`This is **ops work**. Plans MUST follow this pattern:
1. State capture and pre-checks (read-only)
2. Disable autosync / pause reconciliation if applicable
3. Dry-run verification (tf plan, helm diff)
4. Execute change with monitoring
5. Post-change verification
6. Re-enable autosync / reconciliation

Each plan must include its own rollback procedure.`),
  },
  plan_reviewers: {
    ...COMMON_PLAN_REVIEWERS,
    safe_ordering: {
      desc: 'State capture → dry-run → apply → verify ordering',
      prompt: `Read the plans at {plans}.
Check: do plans follow the safe ordering pattern?
1. State capture first
2. Dry-run before any write
3. Verification after each write
4. Rollback documented for each step
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
  },
  kloopPrompts: {
    reviewer:
      'Focus on: rollback completeness for every step, dry-run executed before apply, state captured before changes, no skipped verification steps.',
  },
};

const incident: TypeConfig = {
  desc: 'Incident investigation and resolution — containment first, then root cause and fix',
  spec_writer: {
    prompt: specWriter(
      `This is an **incident** — containment first, then investigate, then fix.

PRIORITY ORDER:
1. Containment — stop the bleeding (feature flag, rollback, circuit breaker)
2. Investigation — root cause (read-only, don't make it worse)
3. Fix — address root cause
4. Prevention — monitoring, alerts, tests to prevent recurrence`,
      `- **Incident Summary** — what is broken, who is affected, severity
- **Blast Radius** — affected services, users, data, downstream systems
- **Containment Plan** — immediate actions to limit damage (before root cause)
- **Root Cause Analysis** — what caused this (from investigation)
- **Fix Approach** — how to fix the root cause
- **Prevention** — what monitoring/alerts/tests prevent recurrence
- **Proof of Resolution** — commands that prove the incident is resolved and contained`,
    ),
  },
  spec_reviewers: {
    ...COMMON_SPEC_REVIEWERS,
    blast_radius: {
      desc: 'Impact scope fully documented',
      prompt: `Read the spec at {spec}.
Check: is the blast radius clearly documented (not just "users are affected")?
Are downstream dependencies and cascading failures considered?
Is there quantification (how many users, which regions, what data)?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
    containment: {
      desc: 'Containment plan is actionable and immediate',
      prompt: `Read the spec at {spec}.
Check: is there a containment plan that can be executed BEFORE the root cause fix?
Is containment independent of the fix (e.g., feature flag, rollback, rate limit)?
Could containment itself cause additional issues?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
  },
  plan_writer: {
    prompt: planWriter(`This is an **incident**. Plans MUST follow this order:
1. Containment (can be deployed independently)
2. Investigation and root cause verification
3. Fix implementation
4. Prevention (monitoring, alerts, regression tests)

Containment plan must be deployable without the fix.`),
  },
  plan_reviewers: {
    ...COMMON_PLAN_REVIEWERS,
    containment_first: {
      desc: 'Containment plan is independent and first',
      prompt: `Read the plans at {plans}.
Check: is the containment plan the first plan?
Can containment be deployed independently of the root cause fix?
Does the investigation plan come before the fix plan?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
  },
  kloopPrompts: {
    reviewer:
      'Focus on: containment independent of fix, monitoring/alerting in place before fix deployed, blast radius verified after containment, no new risks introduced.',
  },
};

const refactoring: TypeConfig = {
  desc: 'Refactoring — code improvement without behavior changes, extend existing patterns',
  spec_writer: {
    prompt: specWriter(
      `This is a **refactoring** — NO behavior changes. Focus on generalizing existing patterns, not inventing new ones.

CRITICAL RULES:
- Extend existing patterns and abstractions, don't create new ones unless the existing one is fundamentally wrong
- All existing tests must continue to pass unchanged (modulo import path changes)
- No new behavior — if behavior changes, it's a feature, not a refactoring
- Measure before and after (performance, bundle size, etc.)`,
      `- **Objective** — what improvement and why
- **Current State** — what's suboptimal with concrete examples
- **Target State** — what it should look like after
- **Generalization Approach** — which existing patterns are being extended
- **Behavioral Equivalence** — what behavior is preserved, how to verify
- **Performance Impact** — expected impact with measurement plan
- **Proof of Completion** — all existing tests pass + performance comparison`,
    ),
  },
  spec_reviewers: {
    ...COMMON_SPEC_REVIEWERS,
    backward_compat: {
      desc: 'No unintended behavior changes',
      prompt: `Read the spec at {spec}.
Check: does the spec explicitly state what behavior must be preserved?
Is there a plan to verify behavioral equivalence (existing tests, comparison)?
Are there any changes that could subtly alter behavior (error messages, timing, ordering)?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
  },
  plan_writer: {
    prompt: planWriter(`This is a **refactoring**. Plans should:
- Preserve all existing tests (they must pass after each plan)
- Move in small, safe increments (each plan is independently safe)
- Include "before/after" verification for each step
- Never mix behavior changes with structural changes`),
  },
  plan_reviewers: {
    ...COMMON_PLAN_REVIEWERS,
    behavioral_safety: {
      desc: 'Each plan preserves existing behavior',
      prompt: `Read the plans at {plans}.
Check: does each plan maintain all existing tests passing?
Is there a risk of subtle behavior changes in any plan?
Are structural changes separated from any (even minor) behavior changes?
Output ONLY the problems found — one per line. If none, output "No issues found."`,
    },
  },
  kloopPrompts: {
    reviewer:
      'Focus on: behavioral equivalence preserved, no new behavior introduced, all existing tests pass, structural changes not mixed with behavior changes.',
  },
};

// ============================================================================
// Export
// ============================================================================

export const DEFAULT_TYPES: Record<string, TypeConfig> = {
  product,
  product_bug,
  infra_bug,
  ops,
  incident,
  refactoring,
};
