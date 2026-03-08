# Polish Step: Commit Pending — Team Agent (Haiku)

## Agent Context

- Working directory: {WORKDIR}
- Task ID: {ticketId}

## Agent Report Format

```
RESULT: <committed|no_changes|error>
COMMIT_SHA: <sha or null>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Task

Stage and commit any uncommitted changes before the push cycle begins.

## Step 1: Check for Changes

```bash
git status --short
```

If no changes, report `RESULT: no_changes`.

## Step 2: Detect Commit Conventions

Check for conventions in priority order:

```bash
ls CommitConventions.md CONTRIBUTING.md COMMIT_CONVENTION.md \
   .gitlint .commitlintrc* commitlint.config.* \
   .conventional-commit* .czrc .cz.json 2>/dev/null || true
git log --oneline -10
```

**`CommitConventions.md` is the primary source** — read it fully if present. Also check `.gitlint` for commit message rules.

## Step 3: Stage and Commit

Stage **specific changed files** (never `git add -A`):

```bash
git add src/... tests/...
```

Create commit following detected convention:

```bash
git commit -m "$(cat <<'EOF'
type(scope): description

[{ticketId}]

Why: {brief rationale for these changes}

- Change 1
- Change 2
EOF
)"
```

Include `{ticketId}` in commit messages when available. If null, omit the ticket ID line.

## Important

- **NEVER merge the PR** — no `gh pr merge`, no merging in any way
- Do NOT push (push step handles that)
- Do NOT update state files — all state files live in `.kagent/`
- Stage specific files, never `git add -A`
