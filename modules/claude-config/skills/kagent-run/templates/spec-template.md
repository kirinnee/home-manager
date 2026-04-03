# Specification: {Title}

## Objective

{Clear, concise description of what to build - 1-3 sentences}

## Risk Assessment

**Risk Level:** {LOW | MEDIUM | HIGH}

- {Why: blast radius, reversibility, dependency surface area}
- {What could go wrong and how likely}
- {Mitigations built into the plan}

## Functional Checks

What the user wants working — the actual behavior/change.

### Programmatic Validation

- [ ] {Specific testable behavior with command or test name}
      `bash
{command to verify}
`
- [ ] {Another testable behavior}
      `bash
{command to verify}
`

### LLM-as-Judge Criteria

- [ ] {Subjective behavior that needs human-like evaluation, e.g. "UI renders correctly per design"}
- [ ] {Edge case handling, e.g. "error messages are helpful and actionable"}

## Non-Functional Checks

Quality gates — not what it does, but how well it's built.

### Programmatic Validation

- [ ] No lint errors: `{linter command}`
      `bash
{command to verify}
`
- [ ] No type errors: `{type-check command}`
      `bash
{command to verify}
`
- [ ] No dead code introduced (check for unused exports, unreachable paths)
      `bash
{command to verify if available}
`
- [ ] Existing tests still pass
      `bash
{test command}
`
- [ ] Invariant check: {project-specific invariant, e.g. "bundle size < N", "no circular deps"}
      `bash
{command to verify}
`

### LLM-as-Judge Criteria

- [ ] Code follows project conventions (CLAUDE.md, existing patterns)
- [ ] No unnecessary abstractions or over-engineering
- [ ] Error handling is appropriate (not over-handled, not under-handled)
- [ ] Changes are minimal and focused on the objective

## Post-Deployment Validation

_If applicable — skip for non-deployable changes._

- [ ] {Smoke test / health check}
      `bash
{command to run post-deploy}
`
- [ ] {Monitoring / metric check}

## Acceptance Criteria

- [ ] All functional programmatic checks pass
- [ ] All non-functional programmatic checks pass
- [ ] All LLM-as-judge criteria satisfied
- [ ] Post-deployment validation passes (if applicable)

## Out of Scope

- {What this task does NOT include}

## Technical Constraints

- {Framework/library constraints}
- {Performance requirements}
- {Compatibility requirements}

## Context

{Any additional context that helps the implementer understand the task}
