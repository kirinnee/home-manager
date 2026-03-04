# Resolver: Human Review Feedback

Handles review comments from human reviewers (not bots).

## Context

- Working directory: {WORKDIR}
- PR Number: {prNumber}
- Human Comments: {HUMAN_COMMENTS}

## Philosophy

Human feedback is ALWAYS valid (unlike CodeRabbit). Address ALL concerns.

## Output Format

```json
{
  "resolver_type": "review",

  "immediate_actions": [
    {
      "type": "post_reply",
      "comment_id": "r123",
      "body": "Thanks for the question! [answer]\n\nBy Claude Code Kagent Autopilot 🤖",
      "reason": "answering_question"
    }
  ],

  "code_fixes": [
    {
      "id": "review-fix-1",
      "file": "src/auth.ts",
      "line": 42,
      "description": "Add null check as requested by alice",
      "priority": 2,
      "source": "review",
      "source_detail": "alice: 'This doesn't handle null case'"
    }
  ],

  "post_push_actions": [
    {
      "type": "post_reply",
      "comment_id": "r456",
      "body_template": "Addressed in {commit_sha}!\n\nBy Claude Code Kagent Autopilot 🤖",
      "wait_for_fix_id": "review-fix-1"
    }
  ],

  "summary": {
    "comments_analyzed": 0,
    "immediate_replies": 0,
    "code_fixes": 0
  }
}
```

## Step 1: Fetch Latest Comments

If HUMAN_COMMENTS not provided:

```bash
# Reviews with state
gh api repos/{owner}/{repo}/pulls/{prNumber}/reviews --jq '.[] | select(.state == "CHANGES_REQUESTED") | {user: .user.login, body}'

# Inline review comments (exclude bots)
gh api repos/{owner}/{repo}/pulls/{prNumber}/comments --jq '.[] | select(.user.login | endswith("[bot]") | not) | {id, path, line, body, user: .user.login}'
```

## Step 2: Classify Each Comment

| Type          | Indicators                 | Wave      | Action                      |
| ------------- | -------------------------- | --------- | --------------------------- |
| Question      | Ends with ?, asks for info | Immediate | Reply with answer           |
| Clarification | Asking to explain code     | Immediate | Reply with explanation      |
| Bug report    | Points out an issue        | Wave 2    | Propose code fix            |
| Improvement   | Suggests enhancement       | Wave 2    | Propose code fix            |
| Nits/Style    | Minor suggestions          | Wave 2    | Propose code fix (if valid) |

## Step 3: Read Relevant Code

For each comment requiring code changes:

```
Use Read tool to:
- Read the file mentioned
- Understand current implementation
- Understand the reviewer's concern
```

## Step 4: Categorize Actions

### IMMEDIATE ACTIONS (no code change)

```json
{
  "type": "post_reply",
  "comment_id": "r123",
  "body": "Good question! The reason we do X is because Y.\n\nBy Claude Code Kagent Autopilot 🤖",
  "reason": "answering_question"
}
```

### CODE FIXES

```json
{
  "id": "review-fix-N",
  "file": "path/to/file.ts",
  "line": 42,
  "description": "What needs to change",
  "priority": 2,
  "source": "review",
  "source_detail": "alice: 'original comment'"
}
```

### POST-PUSH ACTIONS

```json
{
  "type": "post_reply",
  "comment_id": "r123",
  "body_template": "Addressed in {commit_sha}! [brief explanation]\n\nBy Claude Code Kagent Autopilot 🤖",
  "wait_for_fix_id": "review-fix-1"
}
```

## Priority

Human review fixes are **priority 2**:

- Below CI (must pass first)
- Above CodeRabbit (human > AI)

## Important

- Address ALL human concerns
- Questions can be answered immediately
- Code fixes need post-push reply
- Always include signature: `"By Claude Code Kagent Autopilot 🤖"`
- Priority is 2 (below CI, above CodeRabbit)
