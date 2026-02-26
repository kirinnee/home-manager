# Resolver: Human Review Feedback

Handles review comments from human reviewers (not bots).

## Context

- Working directory: {WORKDIR}
- PR Number: {prNumber}
- Human Comments: {HUMAN_COMMENTS}
- Mode: {MODE} (autopilot/manual)

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
      "body": "Thanks for the question! [answer]",
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
      "body_template": "Addressed in {commit_sha}!",
      "wait_for_fix_id": "review-fix-1"
    }
  ]
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

For questions and clarifications:

```json
{
  "type": "post_reply",
  "comment_id": "r123",
  "body": "Good question! The reason we do X is because Y.\n\nBy Claude Code Kagent Autopilot 🤖",
  "reason": "answering_question"
}
```

### CODE FIXES

For bugs, improvements, nits:

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

For comments where we're fixing code, we'll reply after push:

```json
{
  "type": "post_reply",
  "comment_id": "r123",
  "body_template": "Addressed! [brief explanation]\n\nBy Claude Code Kagent Autopilot 🤖",
  "wait_for_fix_id": "review-fix-1"
}
```

## Priority

Human review fixes are **priority 2**:

- Below CI (must pass first)
- Above CodeRabbit (human > AI)

## Example

```json
{
  "resolver_type": "review",

  "immediate_actions": [
    {
      "type": "post_reply",
      "comment_id": "r100",
      "body": "The `validateUser` function is called before `processPayment` to ensure we have a valid user context. Without it, payment processing could fail silently.\n\nBy Claude Code Kagent Autopilot 🤖",
      "reason": "answering_question"
    }
  ],

  "code_fixes": [
    {
      "id": "review-fix-1",
      "file": "src/checkout.ts",
      "line": 87,
      "description": "Add null check for user.address before accessing zipCode",
      "priority": 2,
      "source": "review",
      "source_detail": "alice: 'This will crash if user.address is null'"
    }
  ],

  "post_push_actions": [
    {
      "type": "post_reply",
      "comment_id": "r101",
      "body_template": "Fixed! Added null check before accessing address.\n\nBy Claude Code Kagent Autopilot 🤖",
      "wait_for_fix_id": "review-fix-1"
    }
  ],

  "summary": {
    "comments_analyzed": 2,
    "immediate_replies": 1,
    "code_fixes": 1
  }
}
```

## Important

- Address ALL human concerns
- Questions can be answered immediately
- Code fixes need post-push reply
- Always include signature in replies
- Priority is 2 (below CI, above CodeRabbit)
