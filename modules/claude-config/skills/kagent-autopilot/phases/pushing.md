# Phase: Pushing

**Agent Mode:** Spawned as pushing-agent (sonnet). Commits, pushes, creates/updates PR.

## Agent Context (when spawned)

- Working directory: {WORKDIR}
- Ticket ID: {ticketId}
- PR Number: {prNumber} (null if first push)
- Repo Config: {repoConfig}

This phase commits changes, pushes to remote, and creates/updates the PR.

## Step 1: Detect Commit Conventions

```bash
ls CONTRIBUTING.md COMMIT_CONVENTION.md \
   .commitlintrc* commitlint.config.* \
   .conventional-commit* .czrc .cz.json 2>/dev/null || true
git log --oneline -10
```

Default format (if no convention found):

```
feat(scope): description

[TICKET-ID]

- Detail 1
- Detail 2
```

Include `ticketId` in commit messages when available. If null, omit the ticket ID line — it is not mandatory.

## Step 2: Stage and Commit

Stage **specific changed files** (never `git add -A`):

```bash
git add src/feature.ts src/feature.test.ts
```

Create commit with ticket ID following detected convention:

```bash
git commit -m "$(cat <<'EOF'
type(scope): description

[TICKET_ID]

- Detail 1
EOF
)"
```

## Step 2.5: Clean Up Stale Review Files

Delete any leftover `review.md` from prereview phase:

```bash
rm -f review.md
```

## Step 3: Push

**Pre-push safety checks:**

- Verify not on main/master
- **NEVER force push**

```bash
git push -u origin HEAD
```

**If push fails:**

1. Auto-attempt fast-forward: `git pull --ff-only origin <branch>`
   - If works → retry push
2. Auto-attempt rebase: `git pull --rebase origin <branch>`
   - If applies cleanly → retry push
3. Only if both fail (merge conflicts): `AskUserQuestion`
   - "Let me resolve the conflicts manually" → `git rebase --abort`, set `phase: "pushing"`, stop
   - "Abort" → transition to `failed`

## Step 4: Create or Update PR

Check for existing PR:

```bash
gh pr list --head "$(git branch --show-current)" --json number -q '.[0].number'
```

**If no PR exists:** Create using [templates/pr-template.md](../templates/pr-template.md):

```bash
gh pr create --title "[TICKET_ID] Title" --base {repoConfig.baseBranch} --body "$(cat <<'EOF'
{PR body from template}
EOF
)"
```

Include `[TICKET_ID]` prefix in the title when available. If null, use a descriptive title without prefix.

**If PR exists:** Push auto-updates it. No action needed.

## Step 5: PR Re-Review Comment

**REQUIRED** after every push that addresses polling feedback. Post based on `repoConfig.reReviewComment`:

If `repoConfig.reReviewComment` is not null:

```bash
gh pr comment {prNumber} --body "$(cat <<'EOF'
{repoConfig.reReviewComment}
EOF
)"
```

If `repoConfig.reReviewComment` is null: skip this step.

## Update State

- Store `prNumber` in state
- Increment `pushCycle`
- Update `phase: "pushing"` (for resumability — set before push attempt)

## Resumability

If resuming into this phase: check `git log origin/{branch}..HEAD`. If unpushed commits exist, retry push. If nothing to push, the push already succeeded — proceed to polling. On resume into pushing, also check for and delete stale `review.md`.

## Next

After successful push + PR: Read `phases/polling.md` and follow it.

## Agent Report Format

```
RESULT: <pushed|pr_created|pr_updated|error>
PR_NUMBER: <number>
COMMIT_SHA: <sha>
RE_REVIEW_POSTED: <true|false>
ERROR: <error message if any>
```
