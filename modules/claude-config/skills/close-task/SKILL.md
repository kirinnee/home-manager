---
name: close-task
description: 'Close a completed task: merge PR, remove Obsidian symlink, delete worktree. Use when running /close-task, finishing a task, merging a PR and cleaning up.'
argument-hint: '[PR_NUMBER]'
---

# Close Task - Merge PR and Clean Up

Merges the PR, removes the Obsidian symlink (if present), and deletes the worktree (if applicable). This is the counterpart to `/complete-task`.

## When to Use

- User runs `/close-task` after `/complete-task` reports success
- User wants to merge a PR and clean up the workspace
- User wants to tear down a worktree after a task is done

## Workflow

### Step 1: Detect PR Number

Check in order:

1. Argument passed to `/close-task 42`
2. `.kagent/task-state.json` → `prNumber` field
3. Current branch: `gh pr list --head "$(git branch --show-current)" --json number -q '.[0].number'`

If not detected, use `AskUserQuestion` to ask user.

### Step 2: Verify PR is Mergeable

```bash
gh pr view <prNumber> --json mergeStateStatus -q '.mergeStateStatus'
```

If `mergeStateStatus` is not `CLEAN`, `HAS_HOOKS`, or `UNSTABLE`, report the issue and ask user whether to proceed anyway or abort.

### Step 3: Ask Merge Strategy

Use `AskUserQuestion`:

- Squash and merge (recommended)
- Merge commit
- Rebase and merge

### Step 4: Merge PR

```bash
gh pr merge <prNumber> --squash|--merge|--rebase
```

If merge fails, report the error and stop.

### Step 5: Remove Obsidian Symlink

Check if `.kagent` is a symlink OR if `task-state.json` has `obsidianLinked: true`:

```bash
# Check if .kagent is a symlink
[ -L ".kagent" ]
```

If symlinked:

1. Read the symlink target: `readlink .kagent`
2. Remove the symlink: `rm .kagent`
3. Remove the Obsidian target directory: `rm -rf <target>`
4. Recreate `.kagent` as a regular directory (so remaining state files are accessible):
   - Not needed if we're about to delete the worktree (Step 6)
   - If staying in the directory, optionally `mkdir -p .kagent`

If `obsidianLinked: true` but `.kagent` is not a symlink (already cleaned up), skip — idempotent.

### Step 6: Delete Worktree (if applicable)

Check if current directory is a worktree:

```bash
wt current 2>/dev/null
```

If this succeeds (returns a worktree name):

1. Inform user: "This is a worktree. Removing it will delete the directory and branch."
2. Run `wtrm` to remove the worktree and delete the branch

If not a worktree, skip this step.

### Step 7: Report

```
Task Closed!
  PR: #{prNumber} — merged ({strategy})
  Obsidian: {cleaned up | not linked}
  Worktree: {removed | n/a}
```

## Rules

1. **ALWAYS verify PR is mergeable** before merging
2. **ALWAYS ask merge strategy** — don't assume
3. **IDEMPOTENT cleanup** — safe to run if symlink already removed
4. **NEVER force merge** — if blocked, report and stop
5. **INFORM before worktree deletion** — user should know the directory will be removed
