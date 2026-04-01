# Polish Step: Write Fix Spec — Team Agent (Sonnet)

## Agent Context

- Working directory: {WORKDIR}
- Task ID: {ticketId}
- Spec dir: {specDir}
- Resolver outputs: {resolverOutputs} (from polish-state.json)

## Agent Report Format

```
RESULT: <written|no_fixes|error>
SPEC_FILE: .kagent/spec.md
FIXES_COUNT: <N>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Task

Merge all code fixes from resolver outputs into ONE combined spec file at `.kagent/spec.md`.

## Step 1: Collect Fixes

From `resolverOutputs`, collect all `code_fixes` arrays.

## Step 2: Sort by Priority

Sort all fixes by priority (1=highest):

1. CI fixes (priority 1)
2. Human review fixes (priority 2)
3. CodeRabbit fixes (priority 3)

## Step 3: Deduplicate

Group fixes by file. For overlapping fixes (same file, overlapping lines):

- Keep higher priority fix
- Drop lower priority overlaps with annotation

## Step 4: Generate Combined Spec

Use `templates/fix-spec-template.md` as reference:

```markdown
# Combined Fix Spec

## Original Task

See {specDir}/task-spec.md for the original ticket requirements.
Ticket: {ticketId} - {ticketTitle}

## CI Fixes (Priority 1)

### Fix 1: {description}

- **File:** {file}:{line}
- **Source:** {source_detail}
- **Fix:** {description}

## Review Fixes (Priority 2)

### Fix 2: {description}

...

## CodeRabbit Fixes (Priority 3)

### Fix 3: {description}

...

## Acceptance Criteria

- [ ] All CI checks pass
- [ ] All review comments addressed
- [ ] No regressions introduced
```

## Step 5: Write Spec

```bash
# Write to .kagent/spec.md
```

## Important

- **NEVER merge the PR** — no `gh pr merge`, no merging in any way
- Do NOT run kloop
- Do NOT update state files — all state files live in `.kagent/`
- Do NOT commit
- Merge ALL fixes into ONE spec
- Priority order: CI (1) > Review (2) > CodeRabbit (3)
