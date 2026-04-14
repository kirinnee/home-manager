# Implementation Step: Commit — Team Agent (Haiku)

## Agent Context

- Working directory: {WORKDIR}
- Task ID: {ticketId}
- Current sub-plan: {subPlans[currentSubPlanIndex]} (plan-{N} of {total})
- Spec dir: {specDir}

## Agent Report Format

```
RESULT: <committed|no_changes|error>
COMMIT_SHA: <sha or null>
PLAN_ID: <plan-N>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Task

Commit the current sub-plan's changes. Each sub-plan gets its own commit.

## Step 1: Detect Commit Conventions

Check for conventions in priority order:

```bash
ls CommitConventions.md CONTRIBUTING.md COMMIT_CONVENTION.md \
   .gitlint .commitlintrc* commitlint.config.* \
   .conventional-commit* .czrc .cz.json 2>/dev/null || true
git log --oneline -10
```

**`CommitConventions.md` is the primary source** — read it fully if present. Also check `.gitlint` for commit message rules (line length, format enforcement).

Default format (if no convention found):

```
feat(scope): description

[{ticketId}]

Plan {N} of {M}: {plan title}

Why: {brief rationale for these changes — connects the what to the why}

- Change 1
- Change 2
```

Include `{ticketId}` in commit messages when available. If null, omit the ticket ID line.

## Step 2: Read Plan Title

Read the current sub-plan file to extract the plan title for the commit message:

```bash
head -5 {subPlans[currentSubPlanIndex].file}
```

## Step 3: Check for Changes

```bash
git status --short
```

If no changes to commit, report `RESULT: no_changes`.

## Step 4: Stage and Commit

Stage **specific changed files** (never `git add -A`):

```bash
git add src/feature.ts src/feature.test.ts ...
```

Create commit with ticket ID following detected convention:

```bash
git commit -m "$(cat <<'EOF'
type(scope): plan-{N} summary

[{ticketId}]

Plan {N} of {M}: {plan title}

Why: {brief rationale — what problem this solves or why these changes are needed}

- Change 1
- Change 2
EOF
)"
```

## Important

- Do NOT push (pushing happens in Phase 3)
- Do NOT update state files
- Stage specific files, never `git add -A`
- Include ticket ID in commit when available
- Each sub-plan gets exactly ONE commit
- Follow detected commit conventions
