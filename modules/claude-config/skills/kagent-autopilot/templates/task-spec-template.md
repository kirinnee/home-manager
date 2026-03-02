# Task Specification: {Ticket Title} ({TICKET_ID})

## Source

- Ticket: {TICKET_ID}
- System: {Jira|ClickUp}
- URL: {ticket-url}

## Objective

{From ticket description - clear statement of what to build, 1-3 sentences}

## Acceptance Criteria

{From ticket or inferred from description}

- [ ] Criterion 1 (specific, measurable)
- [ ] Criterion 2
- [ ] Criterion 3

## Definition of Done

- [ ] All acceptance criteria met
- [ ] Tests pass
- [ ] No lint/type errors
- [ ] Ticket ID included in commit message

## Out of Scope

- {What this task does NOT include}

## Technical Constraints

{Any from ticket or codebase conventions}

- Constraint 1
- Constraint 2

## Context

{Additional context from ticket comments, user clarifications, and answers to clarifying questions}

## Technical Decisions

{From clarification phase - key decisions made with reasoning}

| Decision     | Choice          | Reasoning         |
| ------------ | --------------- | ----------------- |
| {Decision 1} | {Option chosen} | {Why this option} |
| {Decision 2} | {Option chosen} | {Why this option} |

## Edge Cases

{Scenarios identified during clarification that need handling}

- **{Edge case 1}**: {How to handle}
- **{Edge case 2}**: {How to handle}

## Error Handling

{How errors should be handled, identified during clarification}

- {Error scenario}: {Expected behavior}

---

## Domain-Driven Design (Optional)

_Only include this section if a `domain-driven-design` skill exists. Check with:_

```bash
ls ~/.claude/skills/domain-driven-design/SKILL.md 2>/dev/null || \
ls ./.claude/skills/domain-driven-design/SKILL.md 2>/dev/null
```

### Bounded Context(s)

{Identify which bounded context(s) this task touches. If multiple, list primary first.}

- **Primary Context:** {name} — {brief description of this context's responsibility}
- **Secondary Context(s):** {if applicable}

### Ubiquitous Language

{Key domain terms used in this task. Define them consistently with how they're used in the codebase.}

| Term     | Definition                           |
| -------- | ------------------------------------ |
| {Term 1} | {Clear definition in domain context} |
| {Term 2} | {Clear definition in domain context} |

### Domain Events

{Key events that occur within this bounded context, if relevant to the task.}

- `{Event Name}` — {trigger condition and what it signifies}

## Implementation Checklist

**Ensure all relevant skills in skill folders are applied to this implementation.**

### Documentation

- [ ] Update existing documentation if behavior changes
- [ ] Add inline comments for complex logic
- [ ] Update README if setup/usage changes

### Testing

Check all that apply:

- [ ] Unit tests
- [ ] Functional tests
- [ ] Integration tests
- [ ] Bruno system tests (if API changes)

**Test location:** {follow existing pattern, e.g., `__tests__/`, `tests/`, `src/*.test.ts`}

### Observability

Check all that apply:

- [ ] **Metrics**: [OTEL | Prometheus | N/A]
  - Describe what's being measured:
- [ ] **Logging**: Correct levels used (debug/info/warn/error)
  - Logging library: {existing library name | N/A}
- [ ] **Alerts**: Grafana CR + runbook markdown
  - Alert location: `alerts/` or `monitoring/`
- [ ] **Dashboards**: Grafana CR with JSON
  - Dashboard location: `dashboards/` or `monitoring/`

### Notes

{Any additional implementation notes or considerations}
