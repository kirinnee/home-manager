# Phase: Polling Enrichment

This phase runs AFTER `dev-loop poll-pr` exits with code 1, 2, or 5. It fetches all PR context and determines what to fix.

## Step 1: Fetch All PR Comments

**CRITICAL:** Before analyzing feedback, fetch ALL comments:

```bash
# Get all review comments (inline code comments)
gh api repos/{owner}/{repo}/pulls/{prNumber}/comments --jq '.[] | {id, path, line, body, user: .user.login, created_at}'

# Get all issue comments (general PR comments)
gh api repos/{owner}/{repo}/issues/{prNumber}/comments --jq '.[] | {id, body, user: .user.login, created_at}'

# Get all reviews with state
gh api repos/{owner}/{repo}/pulls/{prNumber}/reviews --jq '.[] | {id, user: .user.login, state, body}'
```

Consider ALL comments from ALL sources, not just the poller output.

## Step 2: Check Unresolved Conversations

For exit 5 (unresolved conversations), get thread details:

```bash
# List unresolved review threads
gh api repos/{owner}/{repo}/pulls/{prNumber}/comments --jq '.[] | select(.pull_request_review_id != null) | {id, path, line, body, user: .user.login, in_reply_to_id}'
```

## Step 3: CodeRabbit Handling (atomi Repos Only)

**Only for atomicloud repos:** Check if CodeRabbit AI has finished reviewing.

### Check CodeRabbit Status

CodeRabbit posts a "summary" comment when done. Check if the action blocking has cleared:

```bash
# Check if CodeRabbit review action is still running
gh pr checks {prNumber} --json name,status,conclusion --jq '.[] | select(.name | contains("coderabbit") or contains("CodeRabbit"))'
```

If the action shows `completed` (not `in_progress` or `queued`), CodeRabbit has finished.

### Resolve Stale Conversations

For each unresolved CodeRabbit conversation, check:

1. **You replied last** — and your reply explains why the comment is not applicable, or provides context
2. **CodeRabbit acknowledged** — they said "added to learnings", "accepted", or similar

If either condition is true, **BEFORE resolving**, you MUST post a comment explaining why the thread can be resolved:

```bash
# Reply to the thread explaining why it can be resolved
gh pr comment {prNumber} --reply-to {commentId} --body "Resolving: [explain why this thread can be resolved - e.g., addressed in commit X, not applicable because Y, acknowledged by reviewer]

By Claude Code Kagent Autopilot 🤖"
```

**Only AFTER posting the explanation**, resolve the conversation:

```bash
# Resolve a review thread (requires GraphQL)
gh api graphql -f query='
  mutation {
    resolveReviewThread(input: {threadId: "'$THREAD_ID'"}) {
      thread { isResolved }
    }
  }'
```

**CRITICAL:** Never resolve a thread without first posting the reason with your signature.

To get thread IDs:

```bash
gh api graphql -f query='
  query {
    repository(owner: "'$OWNER'", name: "'$REPO'") {
      pullRequest(number: '$PR_NUMBER') {
        reviewThreads(first: 50) {
          nodes { id isResolved path line comments(first: 10) { nodes { author { login } body } } }
        }
      }
    }
  }' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)'
```

### Evaluate CodeRabbit Comments Critically

**Do NOT blindly follow CodeRabbit suggestions:**

1. **Evaluate each comment** — is it valid? Does it apply to the actual code? Is the suggestion correct?
2. **For invalid comments:** Reply explaining why it's not applicable
3. **For valid comments only:** Include in your fixes

Reply signature for atomi repos:

```
By Claude Code Kagent Autopilot 🤖
```

## Step 4: Dispatch by Mode

After enrichment, proceed based on mode:

### Autopilot Mode (`mode: "autopilot"`)

Generate a fix spec from the feedback and run dev-loop again.

**Next:** Read `phases/run-spec.md` and follow it.

### Manual Mode (`mode: "manual"`)

Fix issues **directly** — no dev-loop, no spec files:

1. **Gather feedback** from appropriate source:
   - **CI failures (exit 1):** `gh pr checks {prNumber}` for failed checks, then `gh run view {runId} --log-failed`
   - **Review comments (exit 2):** Comments from Step 1 above
   - **Conversations (exit 5):** Thread details from Step 2
2. **Read relevant source files** to understand context
3. **Fix the code directly** using Edit/Write tools
4. **Do NOT generate spec files or run dev-loop**

**Next:** Read `phases/pushing.md` to commit and push fixes.
