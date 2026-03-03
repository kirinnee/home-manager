# Fix Specification: {TICKET_ID} - Push Cycle {N}/{MAX}

## Original Task

See {specDir}/task-spec.md for the original ticket requirements.
Ticket: {TICKET_ID} - {TICKET_TITLE}

## Previous Cycle Summary

- Run ID: {lastRunId}
- Iterations: {count}
- Final status: {status}

{Brief summary of what the previous dev-loop run accomplished}

## Issues to Address

### CI Failures

{For each failed check - omit section if no CI failures}

- **{check-name}**: {error summary}
  ```
  {key error lines from failure output}
  ```

### Review Comments

{For each reviewer comment - omit section if no review comments}

- **@{author}** on {file}:{line}: {comment text}

### Unresolved Conversations

{For each unresolved review thread blocking merge - omit section if none}

- **@{author}** on {file}:{line}: {comment text}
  - Action: {address the feedback — fix code, reply to resolve, or mark as won't-fix with justification}

### Spec Clarification

{If user clarified a spec ambiguity (exit 2) - omit section if not applicable}

- **Ambiguity**: {which parts of the spec were contradictory or ambiguous}
- **Clarification**: {user's decision on how to resolve the ambiguity}

## Acceptance Criteria

- [ ] All CI checks pass
- [ ] All review comments addressed
- [ ] All blocking conversations resolved
- [ ] No regressions introduced
- [ ] Original task-spec criteria still met

## Constraints

- Keep changes minimal and targeted to the issues above
- Do NOT revert working functionality from previous cycles
- Focus on fixing the specific failures, not refactoring
