# Phase: Polling

This phase gathers ALL PR context, then executes a three-wave fix process.

**Agent Mode:** When spawned as a poller agent, gather context and report to orchestrator. Do NOT update `.kagent/task-state.json`. Do NOT make code changes.

## Three-Wave Execution Model

```
┌─────────────────────────────────────────────────────────────┐
│  POLLER AGENT                                               │
│  Gathers ALL context → returns structured report            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  WAVE 1: IMMEDIATE ACTIONS (parallel execution)             │
│                                                             │
│  • Close OUTDATED/GHOSTED/ACKNOWLEDGED threads              │
│  • Post replies for questions, FALSE_POSITIVEs              │
│  • Handle non-code thread actions                           │
│                                                             │
│  → No code changes needed                                   │
│  → Execute immediately via gh pr comment / resolve          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  WAVE 2: CODE FIXES (merged into ONE spec)                  │
│                                                             │
│  • Collect all code_fixes from all resolvers                │
│  • Merge by priority: CI (1) > Review (2) > CodeRabbit (3)  │
│  • Dedupe overlapping fixes                                 │
│  • Generate ONE combined spec                               │
│                                                             │
│  → Autopilot: Run dev-loop with combined spec               │
│  → Manual: Apply fixes directly                             │
│  → Commit and push                                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  WAVE 3: POST-PUSH ACTIONS (after commit SHA available)     │
│                                                             │
│  • Post replies with commit SHA for TRUE_POSITIVE fixes     │
│  • Request re-evaluation from CodeRabbit                    │
│  • Post "addressed" replies for review comments             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                         LOOP TO POLLING
```

## Orchestrator Flow

### Step 1: Spawn Poller Agent

````json
{
  "description": "Gather full PR context",
  "prompt": "You are the poller agent. Gather ALL PR context and return a structured report.\n\n## Context\n- Working directory: {WORKDIR}\n- PR Number: {prNumber}\n\n## Your Task\n\n### 1. Run dev-loop poll-pr\n\n```bash\ndev-loop poll-pr {prNumber}\n```\n\nNote the exit code:\n- 0: Ready to merge\n- 1: CI failed\n- 2: Changes requested\n- 4: Merge conflict/behind\n- 5: Unresolved conversations\n- 6: PR closed/merged\n\n### 2. Gather CI Status\n\n```bash\ngh pr checks {prNumber} --json name,status,conclusion\n```\n\nFor each failing check:\n```bash\ngh run view {runId} --log-failed\n```\n\n### 3. Gather Review Status\n\n```bash\ngh api repos/{owner}/{repo}/pulls/{prNumber}/reviews --jq '.[] | {user: .user.login, state, body}'\ngh api repos/{owner}/{repo}/pulls/{prNumber}/comments --jq '.[] | {id, path, line, body, user: .user.login}'\n```\n\n### 4. Gather Thread Status\n\n```bash\ngh api graphql -f query='\n  query {\n    repository(owner: \"'$OWNER'\", name: \"'$REPO'\") {\n      pullRequest(number: '$PR_NUMBER') {\n        reviewThreads(first: 50) {\n          nodes { \n            id \n            isResolved \n            path\n            line\n            isOutdated\n            comments(first: 20) { \n              nodes { id author { login } body createdAt } \n            } \n          }\n        }\n      }\n    }\n  }'\n```\n\n### 5. Gather Merge Status\n\n```bash\ngh pr view {prNumber} --json mergeable,mergeStateStatus,headRefName\n```\n\n### 6. Check CodeRabbit CI Status\n\n```bash\ngh pr checks {prNumber} --json name,status,conclusion --jq '.[] | select(.name | test(\"coderabbit|CodeRabbit\"; \"i\"))'\n```\n\n## Report Format\n\n```json\n{\n  \"poll_exit_code\": 1,\n  \"pr_url\": \"https://github.com/{owner}/{repo}/pull/{prNumber}\",\n  \n  \"ci\": {\n    \"status\": \"failing\",\n    \"checks\": [{\"name\": \"test\", \"conclusion\": \"failure\", \"run_id\": \"123\", \"logs_summary\": \"...\"}]\n  },\n  \n  \"human_reviews\": {\n    \"status\": \"changes_requested\",\n    \"comments\": [{\"id\": \"r1\", \"user\": \"alice\", \"path\": \"src/auth.ts\", \"line\": 42, \"body\": \"...\"}]\n  },\n  \n  \"coderabbit\": {\n    \"ci_status\": \"completed\",\n    \"threads\": [{\"thread_id\": \"...\", \"state\": \"NEW\", ...}]\n  },\n  \n  \"other_threads\": [{\"thread_id\": \"...\", \"summary\": \"...\"}],\n  \n  \"merge_status\": {\"mergeable\": true, \"merge_state\": \"CLEAN\"},\n  \n  \"actions_needed\": [\"ci_fix\", \"human_review\", \"coderabbit_threads\"]\n}\n```\n\n## Important\n- Do NOT make code changes\n- Do NOT update .kagent/task-state.json\n- Just gather and report",
  "subagent_type": "general-purpose"
}
````

### Step 2: Spawn Resolvers in Parallel

Based on `actions_needed`, spawn resolver agents:

```bash
# Map actions to resolver files
ACTION_MAP = {
  "ci_fix": "resolvers/ci-resolver.md",
  "human_review": "resolvers/review-resolver.md",
  "coderabbit_threads": "resolvers/coderabbit-resolver.md",
  "other_threads": "resolvers/thread-resolver.md",
  "rebase": "resolvers/rebase-resolver.md"
}

# Spawn all needed resolvers in parallel
for action in actions_needed:
  Task(
    description: "{action} for PR #{prNumber}",
    prompt: "<resolver content with context substituted>",
    subagent_type: "general-purpose",
    run_in_background: true
  )

# Wait for all resolvers
resolver_outputs = [TaskOutput(task_id) for task_id in task_ids]
```

### Step 3: Execute Wave 1 - Immediate Actions

```python
def execute_immediate_actions(resolver_outputs):
    """Execute all immediate thread/comment actions."""

    for output in resolver_outputs:
        for action in output.immediate_actions:
            if action.type == "close_thread":
                # Post note first
                gh_pr_comment(prNumber, action.comment_id, action.body)
                # Then resolve
                resolve_thread(action.thread_id)

            elif action.type == "post_reply":
                gh_pr_comment(prNumber, action.comment_id, action.body)
```

**Immediate actions execute directly via `gh` commands:**

```bash
# Post reply
gh pr comment {prNumber} --reply-to {commentId} --body "{body}"

# Resolve thread (GraphQL)
gh api graphql -f query='
  mutation {
    resolveReviewThread(input: {threadId: "'$THREAD_ID'"}) {
      thread { isResolved }
    }
  }'
```

### Step 4: Execute Wave 2 - Code Fixes

```python
def execute_code_fixes(resolver_outputs, mode):
    """Merge all code fixes, execute via dev-loop or direct."""

    # 1. Collect all fixes
    all_fixes = []
    for output in resolver_outputs:
        all_fixes.extend(output.code_fixes)

    if not all_fixes:
        return None  # No code changes needed

    # 2. Sort by priority (1=highest)
    all_fixes.sort(key=lambda f: f.priority)

    # 3. Group by file
    fixes_by_file = group_by(all_fixes, lambda f: f.file)

    # 4. Detect and resolve conflicts
    for file, fixes in fixes_by_file.items():
        # Remove lower-priority fixes that overlap with higher-priority
        fixes = dedupe_overlapping(fixes)

    # 5. Generate combined spec
    combined_spec = generate_combined_spec(all_fixes)

    # 6. Execute
    if mode == "autopilot":
        # Run dev-loop with combined spec
        write_file("spec/fix-combined.md", combined_spec)
        run_id = run_dev_loop("spec/fix-combined.md")
        commit_sha = get_commit_from_run(run_id)
    else:
        # Apply fixes directly
        for fix in all_fixes:
            apply_fix(fix)
        commit_sha = commit_and_push("fix: address review and CI feedback")

    return commit_sha
```

**Combined Spec Format:**

```markdown
# Combined Fix Spec

## CI Fixes (Priority 1)

### Fix 1: {description}

- **File:** {file}:{line}
- **Source:** {source_detail}
- **Fix:** {description}

## Review Fixes (Priority 2)

### Fix 2: {description}

...

## CodeRabbit Fixes (Priority 3)

### Fix 3: {description}

...
```

### Step 5: Execute Wave 3 - Post-Push Actions

```python
def execute_post_push_actions(resolver_outputs, commit_sha):
    """Post replies after code is pushed."""

    for output in resolver_outputs:
        for action in output.post_push_actions:
            # Replace placeholder with actual commit SHA
            body = action.body_template.replace("{commit_sha}", commit_sha)

            # Post reply
            gh_pr_comment(prNumber, action.comment_id, body)

            # If requesting re-evaluation, the reply should mention it
            # (CodeRabbit will pick it up on next CI run)
```

### Step 6: Loop Decision

```python
def decide_next_step(poll_exit_code, commit_sha, push_cycle, max_push_cycles):
    """Decide what to do after completing all waves."""

    if poll_exit_code == 0:
        # Ready to merge
        return "completed"

    if commit_sha:
        # We made changes, loop back to polling
        return "poll_again"

    # No changes made but still issues
    if push_cycle >= max_push_cycles:
        return "failed"

    return "poll_again"
```

## Exit Conditions

| Condition                       | Action                             |
| ------------------------------- | ---------------------------------- |
| `poll_exit_code == 0`           | Move to `completed` phase          |
| Code pushed                     | Loop to polling (new push cycle)   |
| No code needed, threads handled | Loop to polling                    |
| Max push cycles reached         | Move to `failed` phase             |
| Manual takeover needed          | Move to `failed` phase, alert user |

## Resolver Output Merging

### Priority Order

| Priority | Source        | Reason                         |
| -------- | ------------- | ------------------------------ |
| 1        | CI failures   | Must pass before anything else |
| 2        | Human reviews | Blocking merge                 |
| 3        | CodeRabbit    | Nice to have                   |

### Conflict Resolution

When fixes overlap (same file, overlapping lines):

1. Keep higher priority fix
2. Annotate why lower priority was dropped
3. If same priority, merge descriptions

```python
def dedupe_overlapping(fixes):
    """Remove overlapping lower-priority fixes."""
    result = []
    for fix in fixes:
        overlapping = [f for f in result if overlaps(fix, f)]
        if overlapping:
            # All overlapping are higher priority (sorted)
            continue
        result.append(fix)
    return result
```

## Resumability

If resuming: read `.kagent/task-state.json` and restart from poller with stored `prNumber`.
