# Spec: Verification-First System with Configurable Templates

## 1. Overview

Add a verification-first system to kautopilot's Phase 1 (triage → spec → plans). The system eliminates hypotheticals by front-loading verification, enforces structured output through configurable templates, adds a mandatory non-functional checklist, and introduces spec-adherence checking with an automated "back to spec" escalation path when plans drift.

## 2. Core Principles

1. **No hypotheticals.** Every assumption must be verified against reality (docs, live systems, source code) before it enters a plan.
2. **Automated-immediate validation first.** Push everything into the "automated + before release" quadrant of the validation matrix. Human time is far more expensive than machine time.
3. **Spec is the contract.** Plans implement the spec. If plans drift, either fix the plans or escalate to a new spec version — never silently diverge.
4. **The non-functional checklist is mandatory.** Every item must be evaluated every time. The LLM decides which apply and adds domain-specific items.

## 3. Configurable Output Templates

### 3.1 Config Schema Addition

Add a `templates` section to the config schema alongside the existing `prompts` section:

```yaml
templates:
  triage: |
    ... (default triage template)
  spec: |
    ... (default spec template)
  plan: |
    ... (default plan template)
```

Each template is a markdown document that defines the required structure for that phase's output. Templates are injected into the MECHANICS constants (the non-negotiable format enforcers) so the LLM must follow them. Users can override templates per-org or per-session config.

### 3.2 Default Triage Template

```markdown
# Triage: {title}

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
- Manual post-release: [human checks after release, or "none"]
```

### 3.3 Default Spec Template

```markdown
# Spec: {title}

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

1.  **Linting** — Does this change introduce code that must pass linters?
    Are there new lint rules needed? Does the existing lint config cover
    the new code patterns?

2.  **Building** — Does this compile/build cleanly? Are there new build
    steps, dependencies, or build config changes? Does it affect build
    time or artifact size?

3.  **Unit Testing** — What unit tests are needed? What functions, modules,
    or components need test coverage? What edge cases must be covered?

4.  **Integration Testing** — Do components interact in ways that need
    integration tests? API contracts, database queries, service
    communication, message queues?

5.  **End-to-End Testing** — Does this change user-facing behavior that
    needs E2E tests? What user flows are affected? What tool is
    appropriate for this project's stack (Playwright, Cypress, Detox,
    XCTest, etc.)?

6.  **Documentation** — Do code comments, README, API docs, changelog,
    or user-facing docs need updating? Are there architectural decision
    records (ADRs) to write?

7.  **Observability** — Does this need new or updated: metrics, alerts,
    log statements, dashboard panels, or runbook entries? Will operators
    know if this breaks in production?

8.  **Invariant Checking** — What invariants must hold? Are there runtime
    assertions, type constraints, or data consistency rules that should be
    enforced? Can any invariants be checked at build time vs. runtime?

9.  **Security** — Does this handle user input, authentication, authorization,
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
planning and implementation.]
```

### 3.4 Default Plan Template

```markdown
# Plan {N}: {title}

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
  Describe the general approach — the dev loop will implement the scripts.]
```

## 4. Triage Prompt Changes

### 4.1 TRIAGE_MECHANICS Update

Replace the hardcoded format section with a `{triageTemplate}` placeholder. The template is injected from `config.templates.triage`. The approval gate section stays hardcoded (non-configurable).

### 4.2 DEFAULT_TRIAGE_PROMPT Update

Add a `## Verification` section before `## User Approval`:

```
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
```

## 5. Spec Writer Prompt Changes

### 5.1 SPEC_MECHANICS Update

Add `{specTemplate}` placeholder: "Each draft MUST follow this template: {specTemplate}"

### 5.2 DEFAULT_SPEC_WRITER_PROMPT Update

Append:

```
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
Then add any domain-specific items the checklist missed. Do not skip any item.
```

## 6. Plan Writer Prompt Changes

### 6.1 PLAN_MECHANICS Update

Add `{planTemplate}` placeholder: "Each plan file MUST follow this template: {planTemplate}"

### 6.2 DEFAULT_PLAN_WRITER_PROMPT Update

Append:

```
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
as specified, flag it — do not silently drop it.
```

## 7. New Reviewers

### 7.1 Spec Reviewer: `nonfunctional_checklist`

```
Read the spec at {spec}.
Check: has every item in the non-functional checklist been evaluated?
The checklist has 12 standard items (linting, building, unit testing, integration testing,
E2E testing, documentation, observability, invariant checking, security, performance,
backwards compatibility, accessibility). For each item, the spec must state whether it
applies and why.
Flag any items that are missing, skipped without justification, or dismissed too quickly.
Also check: did the spec add domain-specific non-functional items beyond the checklist?
Output ONLY the problems found — one per line. If none, output "No issues found."
```

### 7.2 Spec Reviewer: `verification_evidence`

```
Read the spec at {spec} and the triage at {triage}.
Check: if the triage listed assumptions to verify, does the spec provide verification
evidence for each one? Evidence must include a concrete source (doc URL, file path,
command output, live query result).
Flag any assumptions that are unaddressed or claimed as verified without evidence.
Flag any "UNVERIFIED" items and assess whether they are blocking.
Output ONLY the problems found — one per line. If none, output "No issues found."
```

### 7.3 Plan Reviewer: `spec_adherence`

```
Read the plans at {plans} and the spec at {spec}.
Check: across all plans, is every functional requirement from the spec addressed by at
least one plan? Is every applicable non-functional requirement addressed?
List any spec requirements that are not covered by any plan.
List any plan content that introduces scope not present in the spec (scope creep).
If you find drift — plans that contradict or ignore spec requirements — flag each instance
with the specific spec requirement and the conflicting plan content.
Output ONLY the problems found — one per line. If none, output "No issues found."
```

## 8. Spec Amendment Escalation from Plans

### 8.1 The Problem

During plan writing, the LLM or user may discover the spec is wrong or incomplete. Currently there is no way to go back to spec writing within the same version — the only path is forward.

### 8.2 The Solution: Version Escalation

Use the existing version escalation mechanism. When plan writing detects spec drift that requires a spec change:

1. The plan writer TTY logs a `spec_amendment:requested` event with metadata describing what needs changing
2. The plan writer tells the user to `/exit`
3. `handleWritePlans` detects this event (no `plans:approved` event, but `spec_amendment:requested` present)
4. Returns a special signal (e.g., the string `'amend_spec'`) instead of `null` or `'finalize_plans'`
5. The Phase 1 state machine handles `'amend_spec'` by:
   - Incrementing the version (v1 → v2)
   - Calling `supersedEpoch` to mark the old version
   - Re-entering phase 1 at `write_spec` state (skip `pull_ticket` and `triage` — ticket and triage carry forward)
   - The triage.md from the previous version is copied to the new version directory so the spec writer has context

### 8.3 State Machine Changes

Add `'amend_spec'` as a recognized return value from `handleWritePlans`. In the phase 1 runner (`src/phases/phase1/index.ts`), handle this by:

```typescript
// In the state machine or post-machine logic:
if (result === 'amend_spec') {
  const nextVersion = ctx.version + 1;
  supersedEpoch(session.id, ctx.version, nextVersion);
  // Copy triage.md to new version dir so it carries forward
  copyTriageToNewVersion(session, ctx.version, nextVersion);
  // Re-run phase 1 starting from write_spec with new version
  return runPhase1(session, config, { versionOverride: nextVersion, forceStartState: 'write_spec' });
}
```

### 8.4 What Carries Forward vs. What Resets

On spec amendment escalation:

- **Carries forward:** ticket.md, triage.md (copied to new version dir)
- **Resets:** spec drafts (start fresh), plan drafts (start fresh)
- **Skipped:** pull_ticket (ticket unchanged), triage (assessment unchanged)

The spec writer gets the previous spec as context (the latest draft from the old version is prepended to the prompt with a note: "Previous spec v{N} is below for reference. It needs amendment because: {reason}").

## 9. parseTriage() Extension

Extend the return type to include verification flags:

```typescript
export type TestingLevel = 'none' | 'light' | 'moderate' | 'heavy';

export interface TriageResult {
  deliveryKind: 'pr' | 'ticket';
  complexity: string;
  verification: {
    hasAssumptions: boolean;
    testing: TestingLevel;
    hasValidators: boolean;
  };
}
```

Parse from triage.md:

- `### Assumptions to Verify` → `hasAssumptions` (true if not "None")
- `### Testing Level` → `testing` (enum, default `'none'`)
- `### Validation Matrix` → `hasValidators` (true if any cell is not "none")

Default all to false/none for backward compatibility with old triage files.

## 10. Phase1Context Extension

```typescript
export interface Phase1Context extends PhaseContext {
  deliveryKind?: DeliveryKind;
  verification?: {
    hasAssumptions: boolean;
    testing: TestingLevel;
    hasValidators: boolean;
  };
}
```

Set from `parseTriage` result in `handleTriage`. Include in `triage:completed` event metadata.

## 11. Template Injection Mechanics

Each handler resolves the template into the mechanics before combining with the user prompt:

```typescript
// In handleTriage:
const mechanicsWithTemplate = TRIAGE_MECHANICS.replace('{triageTemplate}', config.templates.triage);
const mechanics = resolvePromptVars(mechanicsWithTemplate, vars);
const userPrompt = resolvePromptVars(config.prompts.triage, vars);
const prompt = mechanics + userPrompt;
```

Same pattern for write-spec and write-plans handlers.

## 12. Files Modified

| File                                  | Change                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/core/types.ts`                   | Add template constants, `templates` config schema, update default prompts, add new reviewers |
| `src/phases/phase1/triage.ts`         | Template in TRIAGE_MECHANICS, extend parseTriage with TriageResult, verification propagation |
| `src/phases/phase1/write-spec.ts`     | Template in SPEC_MECHANICS                                                                   |
| `src/phases/phase1/write-plans.ts`    | Template in PLAN_MECHANICS, detect `spec_amendment:requested`, return `'amend_spec'`         |
| `src/phases/phase1/types.ts`          | Add `verification` to Phase1Context                                                          |
| `src/phases/phase1/index.ts`          | Handle `'amend_spec'` return — escalate version, copy triage, re-enter at write_spec         |
| `src/phases/__tests__/triage.test.ts` | Tests for verification parsing, backward compat                                              |

## 13. Verification

1. `bun test` — all existing tests pass
2. parseTriage with new verification sections → flags parsed correctly
3. parseTriage with old triage files (no verification section) → backward compat defaults
4. Template override via config.yaml → custom template appears in resolved prompts
5. spec_amendment:requested event → version escalates, triage carries forward, spec restarts
