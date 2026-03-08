# Polish Step: Push — Team Agent (Sonnet)

## Agent Context

- Working directory: {WORKDIR}
- Task ID: {ticketId}
- PR Number: {prNumber}
- Repo Config: {repoConfig}
- Post-push actions: {postPushActions} (from polish-state.json, may be null)

## Agent Report Format

```
RESULT: <pushed|error>
COMMIT_SHA: <sha>
POST_PUSH_EXECUTED: <true|false|skipped>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Step 1: Clean Up Stale Review Files

```bash
rm -f rb-review.md
```

## Step 2: Pre-Push Safety Checks

- Verify not on main/master
- **NEVER force push** (exception: `--force-with-lease` after rebase-resolver only)

## Step 3: Push

```bash
git push -u origin HEAD
```

**If push fails:**

1. Auto-attempt fast-forward: `git pull --ff-only origin {branch}`
   - If works → retry push
2. Auto-attempt rebase: `git pull --rebase origin {branch}`
   - If applies cleanly → retry push
3. Only if both fail (merge conflicts): report error
   - Orchestrator will `AskUserQuestion`:
     - "Let me resolve the conflicts manually" → stop
     - "Abort" → transition to `failed`

## Step 4: Execute Post-Push Actions (Wave 3)

If `postPushActions` is not null (from previous resolve cycle):

For each action in `postPushActions`:

1. Substitute `{commit_sha}` with the actual commit SHA from the push
2. Execute:

```bash
# Post reply
gh pr comment {prNumber} --reply-to {commentId} --body "{body with commit_sha}"
```

If `postPushActions` is null: skip this step (first push or no pending actions).

## Step 5: Re-Review Comment

**After every push that addresses polling feedback** (not the first push):

If `repoConfig.reReviewComment` is not null:

```bash
gh pr comment {prNumber} --body "$(cat <<'EOF'
{repoConfig.reReviewComment}
EOF
)"
```

If `repoConfig.reReviewComment` is null: skip.

## Resumability

If resuming: check `git log origin/{branch}..HEAD`. If unpushed commits exist, retry push. If nothing to push, push already succeeded — proceed.

## Important

- **NEVER merge the PR** — no `gh pr merge`, no merging in any way
- NEVER push to main/master
- NEVER force push (exception: after rebase-resolver with `--force-with-lease`)
- Do NOT update state files — all state files live in `.kagent/`
- Do NOT create PR (that's create-pr step)
