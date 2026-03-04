# Resolver: Rebase/Merge Conflicts

Handles branch behind and merge conflict situations.

## Context

- Working directory: {WORKDIR}
- PR Number: {prNumber}

## Output Format

```json
{
  "resolver_type": "rebase",

  "immediate_actions": [],

  "code_fixes": [],

  "post_push_actions": [],

  "rebase_action": {
    "status": "success|conflict|push_failed|not_needed",
    "conflict_files": [],
    "conflicts_resolved": [],
    "manual_needed": false,
    "pushed": false,
    "error": null
  },

  "summary": {
    "action_taken": "none|rebase|conflict_resolution",
    "status": "success|conflict|push_failed|not_needed"
  }
}
```

**Note:** Rebase resolver executes git commands directly, not through the code_fixes mechanism.

## Step 1: Check Merge Status

```bash
gh pr view {prNumber} --json mergeable,mergeStateStatus,headRefName
```

| mergeStateStatus | Meaning            | Action                          |
| ---------------- | ------------------ | ------------------------------- |
| `CLEAN`          | Ready to merge     | Nothing to do (`not_needed`)    |
| `BEHIND`         | Branch behind base | Rebase                          |
| `CONFLICTING`    | Has conflicts      | Attempt rebase, may need manual |
| `UNSTABLE`       | Failing CI         | Not our concern (`not_needed`)  |
| `DRAFT`          | PR is draft        | Nothing to do (`not_needed`)    |

## Step 2: Handle BEHIND

```bash
git fetch origin
BASE_BRANCH=$(gh pr view {prNumber} --json baseRefName --jq '.baseRefName')
git rebase origin/$BASE_BRANCH
git push --force-with-lease
```

## Step 3: Handle CONFLICTING

```bash
git fetch origin
BASE_BRANCH=$(gh pr view {prNumber} --json baseRefName --jq '.baseRefName')
git rebase origin/$BASE_BRANCH
```

### If Conflicts Occur

```bash
git diff --name-only --diff-filter=U
```

| Conflict Type                | Resolution                     |
| ---------------------------- | ------------------------------ |
| Simple (imports, whitespace) | Resolve automatically          |
| Complex (logic, semantic)    | Report for manual intervention |

```bash
# After resolving simple conflicts, stage only the resolved files
git add {resolved-file-1} {resolved-file-2} ...
git rebase --continue
git push --force-with-lease
```

## Reporting

### Success (rebased and pushed)

```json
{
  "rebase_action": {
    "status": "success",
    "pushed": true,
    "conflict_files": [],
    "error": null
  }
}
```

### Complex Conflicts Need Manual

```json
{
  "rebase_action": {
    "status": "conflict",
    "conflict_files": ["src/auth.ts", "src/user.ts"],
    "error": "Complex semantic conflicts require manual resolution",
    "manual_needed": true,
    "pushed": false
  }
}
```

### Push Failed

```json
{
  "rebase_action": {
    "status": "push_failed",
    "conflict_files": [],
    "error": "Push rejected: remote has new commits",
    "pushed": false
  }
}
```

## Important

- Execute rebase directly (not through code_fixes)
- Use `--force-with-lease`, never `--force` (exception to Rule 22 for rebase only)
- Attempt simple conflict resolution
- Don't guess on complex semantic conflicts
- Report clearly if manual intervention needed
- If pushed successfully, orchestrator goes back to `poll` (skip other resolvers)
