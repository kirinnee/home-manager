# Polish Step: Poll — Team Agent (Opus)

Gathers ALL PR context and returns a structured report to the orchestrator.

## Agent Context

- Working directory: {WORKDIR}
- PR Number: {prNumber}
- Repo Config: {repoConfig}

## Agent Report Format

```json
{
  "poll_exit_code": 0,
  "pr_url": "https://github.com/{owner}/{repo}/pull/{prNumber}",

  "ci": {
    "status": "passing|failing|pending",
    "checks": [{ "name": "test", "conclusion": "failure", "run_id": "123", "logs_summary": "..." }]
  },

  "human_reviews": {
    "status": "approved|changes_requested|pending",
    "comments": [{ "id": "r1", "user": "alice", "path": "src/auth.ts", "line": 42, "body": "..." }]
  },

  "coderabbit": {
    "ci_status": "completed|in_progress|not_found",
    "threads": [{ "thread_id": "...", "state": "NEW|OUTDATED|GHOSTED|ACKNOWLEDGED|PENDING", "summary": "..." }]
  },

  "other_threads": [{ "thread_id": "...", "summary": "..." }],

  "merge_status": { "mergeable": true, "merge_state": "CLEAN|BEHIND|CONFLICTING" },

  "actions_needed": ["ci_fix", "human_review", "coderabbit_threads", "other_threads", "rebase"]
}
```

**Do NOT make code changes. Do NOT update state files. Just gather and report.**

## Steps

### 1. Run dev-loop poll-pr

```bash
dev-loop poll-pr {prNumber}
```

Exit codes (**Note:** these are `dev-loop poll-pr` exit codes, different from `dev-loop run` exit codes used in Phase 2/fix cycles):

- 0: Ready to merge
- 1: CI failed
- 2: Changes requested
- 4: Merge conflict/behind
- 5: Unresolved conversations
- 6: PR closed/merged

### 2. Gather CI Status

```bash
gh pr checks {prNumber} --json name,status,conclusion
```

For each failing check:

```bash
gh run view {runId} --log-failed
```

### 3. Gather Review Status

```bash
gh api repos/{owner}/{repo}/pulls/{prNumber}/reviews --jq '.[] | {user: .user.login, state, body}'
gh api repos/{owner}/{repo}/pulls/{prNumber}/comments --jq '.[] | {id, path, line, body, user: .user.login}'
```

### 4. Gather Thread Status

```bash
gh api graphql -f query='
  query {
    repository(owner: "'$OWNER'", name: "'$REPO'") {
      pullRequest(number: '$PR_NUMBER') {
        reviewThreads(first: 50) {
          nodes {
            id
            isResolved
            path
            line
            isOutdated
            comments(first: 20) {
              nodes { id author { login } body createdAt }
            }
          }
        }
      }
    }
  }'
```

### 5. Gather Merge Status

```bash
gh pr view {prNumber} --json mergeable,mergeStateStatus,headRefName
```

### 6. Check CodeRabbit CI Status

```bash
gh pr checks {prNumber} --json name,status,conclusion --jq '.[] | select(.name | test("coderabbit|CodeRabbit"; "i"))'
```

### 7. Determine Actions Needed

Based on gathered data, populate `actions_needed` array.

## Push Cycle Check

If `pushCycle >= maxPushCycles` and issues remain:

- Report with `actions_needed: ["max_cycles_reached"]`
- Orchestrator transitions to `failed`

## Important

- Do NOT make code changes
- Do NOT update state files
- Do NOT close or resolve threads
- Only gather context and report
- Always use `dev-loop poll-pr`, NEVER `gh pr watch`
