# Resolver: Non-CodeRabbit Threads

Handles unresolved conversations that are NOT from CodeRabbit.

## Context

- Working directory: {WORKDIR}
- PR Number: {prNumber}
- Threads: {OTHER_THREADS}

## Purpose

Handle unresolved review threads from:

- Human reviewers (general conversations, not inline code comments)
- Other bots (not CodeRabbit)
- Any other conversation threads

**CodeRabbit threads are handled by `coderabbit-resolver.md`.**

## Output Format

```json
{
  "resolver_type": "thread",

  "immediate_actions": [
    {
      "type": "post_reply|close_thread",
      "thread_id": "PRRT_...",
      "comment_id": "...",
      "body": "Reply content with signature",
      "reason": "answering|stale|resolved"
    }
  ],

  "code_fixes": [],

  "post_push_actions": []
}
```

**Note:** Thread resolver typically has NO code fixes. All actions are immediate.

## Step 1: Fetch Unresolved Threads

```bash
OWNER=$(git remote get-url origin | sed -E 's|.*[:/]([^/]+)/([^.]+)(\.git)?|\1|')
REPO=$(git remote get-url origin | sed -E 's|.*[:/]([^/]+)/([^.]+)(\.git)?|\2|')

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
            comments(first: 20) {
              nodes {
                id
                author { login }
                body
                createdAt
              }
            }
          }
        }
      }
    }
  }' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)'
```

## Step 2: Filter Out CodeRabbit

Skip threads where `coderabbitai[bot]` is a participant (handled by coderabbit-resolver).

## Step 3: Analyze Each Thread

### Thread Types

| Type           | Indicators                        | Action                     |
| -------------- | --------------------------------- | -------------------------- |
| Question       | Ends with ?, asking for info      | IMMEDIATE: Answer          |
| Answered       | Question was answered, still open | IMMEDIATE: Close           |
| Stale          | No activity 7+ days               | IMMEDIATE: Close with note |
| Outdated       | Code changed, thread irrelevant   | IMMEDIATE: Close with note |
| Needs response | Someone asked us something        | IMMEDIATE: Reply           |

## Step 4: Immediate Actions

### Answering Questions

```json
{
  "type": "post_reply",
  "thread_id": "PRRT_...",
  "comment_id": "last_comment_id",
  "body": "Great question! [Answer]\n\nBy Claude Code Kagent Autopilot 🤖",
  "reason": "answering"
}
```

### Closing Stale Threads

```json
{
  "type": "close_thread",
  "thread_id": "PRRT_...",
  "comment_id": "last_comment_id",
  "body": "This thread has been inactive for over a week. Closing as stale.\n\nIf you have further concerns, please open a new thread.\n\nBy Claude Code Kagent Autopilot 🤖",
  "reason": "stale"
}
```

### Closing Resolved Threads

If the conversation seems complete but thread is still open:

```json
{
  "type": "close_thread",
  "thread_id": "PRRT_...",
  "comment_id": "last_comment_id",
  "body": "This conversation appears resolved. Closing.\n\nBy Claude Code Kagent Autopilot 🤖",
  "reason": "resolved"
}
```

### Closing Outdated Threads

If the code at that location has changed significantly:

```json
{
  "type": "close_thread",
  "thread_id": "PRRT_...",
  "comment_id": "last_comment_id",
  "body": "This thread refers to code that has since been modified. Closing as outdated.\n\nBy Claude Code Kagent Autopilot 🤖",
  "reason": "outdated"
}
```

## Report Format

```json
{
  "resolver_type": "thread",

  "immediate_actions": [
    {
      "type": "post_reply",
      "thread_id": "PRRT_abc123",
      "comment_id": "r456",
      "body": "The reason we use X is because Y.\n\nBy Claude Code Kagent Autopilot 🤖",
      "reason": "answering"
    },
    {
      "type": "close_thread",
      "thread_id": "PRRT_def456",
      "comment_id": "r789",
      "body": "Closing as stale.\n\nBy Claude Code Kagent Autopilot 🤖",
      "reason": "stale"
    }
  ],

  "code_fixes": [],

  "post_push_actions": [],

  "summary": {
    "threads_analyzed": 2,
    "replied": 1,
    "closed": 1
  }
}
```

## Important

- All actions are IMMEDIATE (no code changes needed)
- Always include signature in replies
- Never close without posting a note first
- Don't handle CodeRabbit threads (those go to coderabbit-resolver)
- If a thread needs code changes, it should have been caught by review-resolver
