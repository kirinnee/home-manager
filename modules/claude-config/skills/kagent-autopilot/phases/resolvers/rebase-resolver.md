# Resolver: Rebase/Merge Conflicts

Handles branch behind and merge conflict situations.

## Context

- Working directory: {WORKDIR}
- PR Number: {prNumber}
- Branch: {BRANCH}
- Merge Status: {MERGE_STATUS}

## Output Format

```json
{
  "resolver_type": "rebase",

  "immediate_actions": [],

  "code_fixes": [],

  "post_push_actions": [],

  "rebase_action": {
    "status": "success|conflict|push_failed",
    "conflict_files": [],
    "error": null
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
| `CLEAN`          | Ready to merge     | Nothing to do                   |
| `BEHIND`         | Branch behind base | Rebase                          |
| `CONFLICTING`    | Has conflicts      | Attempt rebase, may need manual |
| `UNSTABLE`       | Failing CI         | Not our concern here            |
| `DRAFT`          | PR is draft        | Nothing to do                   |

## Step 2: Handle BEHIND

If `mergeStateStatus == "BEHIND"`:

```bash
# Fetch latest
git fetch origin

# Detect base branch from PR
BASE_BRANCH=$(gh pr view {prNumber} --json baseRefName --jq '.baseRefName')

# Rebase
git rebase origin/$BASE_BRANCH

# Push with force-with-lease
git push --force-with-lease
```

## Step 3: Handle CONFLICTING

```bash
# Attempt rebase
git fetch origin
BASE_BRANCH=$(gh pr view {prNumber} --json baseRefName --jq '.baseRefName')
git rebase origin/$BASE_BRANCH
```

### If Conflicts Occur

```bash
# List conflicting files
git diff --name-only --diff-filter=U
```

For each conflict:

| Conflict Type                | Resolution                     |
| ---------------------------- | ------------------------------ |
| Simple (imports, whitespace) | Resolve automatically          |
| Complex (logic, semantic)    | Report for manual intervention |

```bash
# After resolving simple conflicts
git add .
git rebase --continue

# Push
git push --force-with-lease
```

## Step 4: Report Results

### Success

```json
{
  "resolver_type": "rebase",

  "immediate_actions": [],

  "code_fixes": [],

  "post_push_actions": [],

  "rebase_action": {
    "status": "success",
    "conflict_files": [],
    "error": null
  }
}
```

### Conflicts Resolved

```json
{
  "resolver_type": "rebase",

  "immediate_actions": [],

  "code_fixes": [],

  "post_push_actions": [],

  "rebase_action": {
    "status": "success",
    "conflict_files": [],
    "conflicts_resolved": [{ "file": "src/auth.ts", "resolution": "Kept our changes to validateUser" }],
    "error": null
  }
}
```

### Complex Conflicts Need Manual

```json
{
  "resolver_type": "rebase",

  "immediate_actions": [],

  "code_fixes": [],

  "post_push_actions": [],

  "rebase_action": {
    "status": "conflict",
    "conflict_files": ["src/auth.ts", "src/user.ts"],
    "error": "Complex semantic conflicts require manual resolution",
    "manual_needed": true
  }
}
```

### Push Failed

```json
{
  "resolver_type": "rebase",

  "immediate_actions": [],

  "code_fixes": [],

  "post_push_actions": [],

  "rebase_action": {
    "status": "push_failed",
    "conflict_files": [],
    "error": "Push rejected: remote has new commits"
  }
}
```

## Important

- Execute rebase directly (not through code_fixes)
- Use `--force-with-lease`, never `--force`
- Attempt simple conflict resolution
- Don't guess on complex semantic conflicts
- Report clearly if manual intervention needed
- This resolver runs independently of code fixes
