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

### 1. Gather CI Status

```bash
gh pr checks {prNumber} --json name,status,conclusion
```

For each failing check:

```bash
gh run view {runId} --log-failed
```

### 2. Gather Review Status

```bash
gh api repos/{owner}/{repo}/pulls/{prNumber}/reviews --jq '.[] | {user: .user.login, state, body}'
gh api repos/{owner}/{repo}/pulls/{prNumber}/comments --jq '.[] | {id, path, line, body, user: .user.login}'
```

### 3. Gather Thread Status

```bash
gh api graphql -f query='
  query {
    repository(owner: "'$OWNER'", name: "'$REPO'") {
      pullRequest(number: '$PR_NUMBER') {
        state
        mergeable
        mergeStateStatus
        reviewDecision
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

### 4. Gather Merge Status

```bash
gh pr view {prNumber} --json mergeable,mergeStateStatus,headRefName
```

### 5. Check CodeRabbit CI Status

```bash
gh pr checks {prNumber} --json name,status,conclusion --jq '.[] | select(.name | test("coderabbit|CodeRabbit"; "i"))'
```

### 6. Compute Poll Result

Using the data gathered in steps 1-5, determine `poll_exit_code` with this priority:

| Priority | Condition                                              | Exit Code | Status                   |
| -------- | ------------------------------------------------------ | --------- | ------------------------ |
| 1        | PR state is MERGED or CLOSED                           | 6         | `merged` or `closed`     |
| 2        | CI checks still pending/running/queued                 | —         | Wait and re-poll         |
| 3        | mergeable == UNKNOWN                                   | —         | Wait and re-poll         |
| 4        | mergeable == CONFLICTING                               | 4         | `merge_conflict`         |
| 5        | mergeStateStatus == BEHIND                             | 4         | `behind`                 |
| 6        | CI checks have failures                                | 1         | `ci_failed`              |
| 7        | reviewDecision == CHANGES_REQUESTED                    | 2         | `changes_requested`      |
| 8        | mergeStateStatus == BLOCKED AND unresolved threads > 0 | 5         | `conversations_blocking` |
| 9        | mergeStateStatus in (CLEAN, HAS_HOOKS, UNSTABLE)       | 0         | `all_pass`               |
| 10       | mergeStateStatus == BLOCKED (other reason)             | 5         | `blocked`                |
| 11       | Otherwise                                              | —         | Wait and re-poll         |

For "wait and re-poll" cases, sleep for 60 seconds and repeat steps 1-6.

### 7. Determine Actions Needed

Based on gathered data, populate `actions_needed` array.

## Push Cycle Check

If `pushCycle >= maxPushCycles` and issues remain:

- Report with `actions_needed: ["max_cycles_reached"]`
- Orchestrator transitions to `failed`

## Important

- **NEVER merge the PR** — no `gh pr merge`, no merging in any way
- Do NOT make code changes
- Do NOT update state files — all state files live in `.kagent/`
- Do NOT close or resolve threads
- Only gather context and report
