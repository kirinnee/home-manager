# Polish Step: Resolve — Orchestrator Inline

**This runs inline with the orchestrator.** Dispatches resolvers and executes Wave 1.

**CRITICAL: NEVER merge the PR. No `gh pr merge`. The user merges manually.**
**CRITICAL: All state files live in `.kagent/`. Always use the `.kagent/` prefix.**

## Entry Condition

- `polish-state.step: "resolve"`
- Poller report available with `actions_needed`

## Resolver Dispatch

### Step 1: Rebase First

If `actions_needed` includes `"rebase"`:

1. Spawn rebase-resolver (sonnet) from `polish/resolvers/rebase-resolver.md`
2. Wait for result
3. If rebase pushed successfully → update `polish-state.step: "poll"` and return to polling
4. If rebase failed with conflicts → report to user, transition to `failed`
5. If no rebase needed → continue to other resolvers

### Step 2: Spawn Other Resolvers in Parallel

Based on remaining `actions_needed`:

| Action               | Resolver            | Model  | File                                      |
| -------------------- | ------------------- | ------ | ----------------------------------------- |
| `ci_fix`             | ci-resolver         | sonnet | `polish/resolvers/ci-resolver.md`         |
| `human_review`       | review-resolver     | opus   | `polish/resolvers/review-resolver.md`     |
| `coderabbit_threads` | coderabbit-resolver | opus   | `polish/resolvers/coderabbit-resolver.md` |
| `other_threads`      | thread-resolver     | opus   | `polish/resolvers/thread-resolver.md`     |

**CodeRabbit resolver:** Only spawn if `repoConfig.coderabbit` is `true`.

Spawn all needed resolvers in parallel using `run_in_background: true`, then collect results with `TaskOutput`.

### Step 3: Execute Wave 1 — Immediate Actions

For each resolver output, execute `immediate_actions`:

```bash
# Post reply
gh pr comment {prNumber} --reply-to {commentId} --body "{body}"

# Resolve thread (GraphQL)
gh api graphql -f query='
  mutation {
    resolveReviewThread(input: {threadId: "{THREAD_ID}"}) {
      thread { isResolved }
    }
  }'
```

For `close_thread` actions: post the note FIRST, then resolve the thread.

### Step 4: Store Results

Store in `polish-state.json`:

- `resolverOutputs`: all code_fixes from all resolvers
- `postPushActions`: all post_push_actions from all resolvers

### Step 5: Decide Next Step

- **If code fixes exist:** → `clear` → `write_fix` → `run_fix` → `push` → `poll`
- **If no code fixes but threads were handled:** → `poll` (re-check)
- **If nothing to do:** → `poll`

## Resolver Output Merging

### Priority Order

| Priority | Source        | Reason                         |
| -------- | ------------- | ------------------------------ |
| 1        | CI failures   | Must pass before anything else |
| 2        | Human reviews | Blocking merge                 |
| 3        | CodeRabbit    | Nice to have, AI feedback      |

### Conflict Resolution

When fixes overlap (same file, overlapping lines):

1. Keep higher priority fix
2. Annotate why lower priority was dropped
3. If same priority, merge descriptions
