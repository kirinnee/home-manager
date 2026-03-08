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

**CodeRabbit threads are handled by `polish/resolvers/coderabbit-resolver.md`.**

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
      "reason": "answering|stale|resolved|outdated"
    }
  ],

  "code_fixes": [],

  "post_push_actions": [],

  "summary": {
    "threads_analyzed": 0,
    "replied": 0,
    "closed": 0
  }
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
      pullRequest(number: {prNumber}) {
        reviewThreads(first: 50) {
          nodes {
            id
            isResolved
            path
            line
            isOutdated
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

Skip threads where `coderabbitai[bot]` is a participant.

## Step 3: Analyze Each Thread

| Type           | Indicators                                         | Action                     |
| -------------- | -------------------------------------------------- | -------------------------- |
| Question       | Ends with ?, asking for info                       | IMMEDIATE: Answer          |
| Answered       | Question was answered, still open                  | IMMEDIATE: Close           |
| Stale          | No activity 7+ days                                | IMMEDIATE: Close with note |
| Outdated       | `isOutdated == true` or code changed significantly | IMMEDIATE: Close with note |
| Needs response | Someone asked us something                         | IMMEDIATE: Reply           |

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

```json
{
  "type": "close_thread",
  "thread_id": "PRRT_...",
  "comment_id": "last_comment_id",
  "body": "This thread refers to code that has since been modified. Closing as outdated.\n\nBy Claude Code Kagent Autopilot 🤖",
  "reason": "outdated"
}
```

## Important

- **NEVER merge the PR** — no `gh pr merge`, no merging in any way
- All actions are IMMEDIATE (no code changes needed)
- Always include signature: `"By Claude Code Kagent Autopilot 🤖"`
- Never close without posting a note first
- Don't handle CodeRabbit threads (those go to coderabbit-resolver)
- If a thread needs code changes, it should have been caught by review-resolver
- Always include `isOutdated` in GraphQL queries
