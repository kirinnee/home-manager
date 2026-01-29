# Complete Task Reference

## Git Commands

### Check Current Branch

```bash
git branch --show-current
```

### Check Worktree (if using wt/worktrunk)

```bash
wt current 2>/dev/null || true
```

### Stage Changes

```bash
# Stage specific files (preferred)
git add src/feature.ts src/feature.test.ts

# Avoid staging sensitive files
# Never: git add -A (can include .env, credentials)
```

### Create Commit

```bash
git commit -m "$(cat <<'EOF'
type(scope): description

[TICKET_ID]

- Detail 1
- Detail 2
EOF
)"
```

### Create Branch

```bash
git checkout -b "PE-1234-short-description"
```

### Push with Upstream

```bash
git push -u origin HEAD
```

## GitHub CLI Commands

### Check for Existing PR

```bash
gh pr list --head "$(git branch --show-current)" --json number -q '.[0].number'
```

### Create PR

```bash
gh pr create --title "[PE-1234] Feature title" --body "$(cat <<'EOF'
## Summary
- Change 1
- Change 2

## Ticket
- [PE-1234](https://jira.example.com/browse/PE-1234)

## Test Plan
- [ ] Unit tests pass
- [ ] Integration tests pass
EOF
)"
```

### Update PR

```bash
gh pr edit <number> --body "$(cat <<'EOF'
Updated body...
EOF
)"
```

### Check CI Status

```bash
gh pr checks
```

### Check Reviews

```bash
gh pr view --json reviews,reviewDecision
```

### Get PR Comments

```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments
```

## Jira Commands (acli)

### View Ticket

```bash
acli jira workitem view PE-1234 --json
```

### View with All Fields

```bash
acli jira workitem view PE-1234 --fields '*all' --json
```

### View Specific Fields

```bash
acli jira workitem view PE-1234 --fields 'summary,description,comment,acceptance-criteria' --json
```

### Setup Auth (one-time)

```bash
acli jira auth
```

## ClickUp (MCP)

Use the official ClickUp MCP server tools. The server must be configured in Claude settings.

If not configured, inform user:

```
ClickUp MCP server is not configured. Please set up the official
ClickUp MCP server in your Claude settings.
```

## Commit Convention Detection

### Files to Check

```bash
ls -la CONTRIBUTING.md COMMIT_CONVENTION.md \
       .commitlintrc* commitlint.config.* \
       .conventional-commit* .czrc .cz.json 2>/dev/null || true

ls -la docs/CONTRIBUTING.md docs/COMMIT_CONVENTION.md \
       docs/developer/CommitConventions.md 2>/dev/null || true
```

### Check Recent History

```bash
git log --oneline -10
```

### Common Conventions

**Conventional Commits:**

```
type(scope): description

Types: feat, fix, docs, style, refactor, test, chore
```

**Angular:**

```
type(scope): subject

body

footer
```

### Default Format (if no convention found)

```
feat(scope): description

[TICKET-ID]

- Detail 1
- Detail 2
```

## Ticket ID Patterns

| System         | Pattern         | Example             |
| -------------- | --------------- | ------------------- |
| Jira (Liftoff) | `PE-\d{4}`      | PE-1234             |
| ClickUp        | `CU-?[a-z0-9]+` | CU-abc123, CUxyz789 |

## Branch Naming

Format: `<ticket-id>-<short-description>`

Examples:

- `PE-1234-add-auth`
- `CU-abc123-fix-login`

## PR Template

```markdown
## Summary

{1-3 bullet points describing changes}

## Ticket

- [{TICKET_ID}]({ticket-url})

## Changes

- Change 1
- Change 2
- Change 3

## Test Plan

- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual verification

## Screenshots

(if applicable)
```

## Fix Spec Template

When CI fails or reviews have comments, generate a fix spec:

```markdown
# Specification: Fix PR Feedback ([TICKET_ID] - Attempt N)

## Original Ticket

[TICKET_ID]

## Issues to Fix

### CI Failures

- [Failure 1]: [error message]
- [Failure 2]: [error message]

### Review Comments

- @reviewer1: [comment]
- @reviewer2: [comment]
- CodeRabbit: [suggestion]

## Acceptance Criteria

- [ ] All CI checks pass
- [ ] All review comments addressed
- [ ] No new issues introduced
```

## Environment Variables

| Variable                | Description                               |
| ----------------------- | ----------------------------------------- |
| `DEV_LOOP_TIMEOUT_MINS` | Timeout for dev-loop agents (default: 20) |

## Status Report Formats

### CI Status

```
📊 PR Status (session: dev-loop-<UID>)
   PR: #42 - [PE-1234] Feature title

CI Checks:
- ✅ build: passed
- ⏳ test: running
- ❌ lint: failed

Reviews:
- CodeRabbit: Changes requested
- @reviewer1: Approved
```

### Success

```
🎉 Task Complete!
   Ticket: PE-1234
   PR: #42 - [PE-1234] Feature title
   Status: Ready to merge

   All CI checks passed
   All reviews approved

   To merge: gh pr merge 42
```

### Max Cycles Reached

```
⚠️ Max push cycles reached (5/5)
   Ticket: PE-1234
   PR: #42

   Remaining issues:
   - CI: lint still failing
   - Review: @reviewer1 has unresolved comment

   Please take over manually.
```
