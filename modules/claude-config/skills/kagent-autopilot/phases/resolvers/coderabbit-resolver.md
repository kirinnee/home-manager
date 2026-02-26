# Resolver: CodeRabbit Threads

Handles CodeRabbit AI review threads. **FIGHT BACK** - evaluate critically.

## Context

- Working directory: {WORKDIR}
- PR Number: {prNumber}
- Threads: {CODERABBIT_THREADS}

## Philosophy

**CodeRabbit is often wrong.** Evaluate EVERY comment critically. Don't blindly accept suggestions.

## Output Format

```json
{
  "resolver_type": "coderabbit",

  "immediate_actions": [
    {
      "type": "close_thread|post_reply",
      "thread_id": "PRRT_...",
      "comment_id": "...",
      "body": "Reply content with signature",
      "reason": "outdated|ghosted|acknowledged|false_positive|needs_context"
    }
  ],

  "code_fixes": [
    {
      "id": "coderabbit-fix-N",
      "file": "src/utils.ts",
      "line": 10,
      "description": "Fix edge case in validateInput",
      "priority": 3,
      "source": "coderabbit",
      "source_detail": "CodeRabbit: 'This function doesn't handle empty strings'"
    }
  ],

  "post_push_actions": [
    {
      "type": "post_reply",
      "thread_id": "PRRT_...",
      "comment_id": "...",
      "body_template": "Fixed in {commit_sha}. Please re-evaluate.\n\nBy Claude Code Kagent Autopilot 🤖",
      "wait_for_fix_id": "coderabbit-fix-1",
      "request_re_evaluation": true
    }
  ]
}
```

## Step 0: Check CodeRabbit CI Status

```bash
gh pr checks {prNumber} --json name,status,conclusion --jq '.[] | select(.name | test("coderabbit|CodeRabbit"; "i"))'
```

| Status                   | Meaning                                        |
| ------------------------ | ---------------------------------------------- |
| `in_progress` / `queued` | Still reviewing - PENDING threads stay pending |
| `completed`              | Can determine ghosted/settled                  |

Store as `coderabbit_ci_status` in report.

## Step 1: Fetch Thread Details

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
  }'
```

Filter to threads where `coderabbitai[bot]` is a participant.

## Step 2: Classify Each Thread

### State Detection

```
1. isResolved == true?
   → STATE: RESOLVED → Skip

2. isOutdated == true?
   → STATE: OUTDATED → IMMEDIATE: close with note

3. Who commented LAST?

   CodeRabbit last:
     - Contains "added to learnings" / "accepted" / "acknowledged"?
       → STATE: ACKNOWLEDGED → IMMEDIATE: close with note
     - Is a question?
       → STATE: FOLLOW_UP → Evaluate, respond or fix
     - Otherwise:
       → STATE: NEW → Evaluate critically

   We (kagent/claude) last:
     - CodeRabbit CI complete?
       → STATE: GHOSTED → IMMEDIATE: close with note
     - CodeRabbit still running?
       → STATE: PENDING → Skip for now

   Other user last:
     → STATE: OTHER_USER → Skip
```

## Step 3: Actions by State

### STATE: OUTDATED → IMMEDIATE ACTION

```json
{
  "type": "close_thread",
  "thread_id": "PRRT_...",
  "comment_id": "last_comment_id",
  "body": "This thread is outdated (code has changed).\n\nResolving as no longer applicable.\n\nBy Claude Code Kagent Autopilot 🤖",
  "reason": "outdated"
}
```

### STATE: GHOSTED → IMMEDIATE ACTION

CodeRabbit CI complete, we replied last, no response:

```json
{
  "type": "close_thread",
  "thread_id": "PRRT_...",
  "comment_id": "last_comment_id",
  "body": "CodeRabbit has completed their review and did not respond to our last comment.\n\nResolving as settled.\n\nBy Claude Code Kagent Autopilot 🤖",
  "reason": "ghosted"
}
```

### STATE: ACKNOWLEDGED → IMMEDIATE ACTION

```json
{
  "type": "close_thread",
  "thread_id": "PRRT_...",
  "comment_id": "last_comment_id",
  "body": "CodeRabbit acknowledged this feedback.\n\nResolving as no further action needed.\n\nBy Claude Code Kagent Autopilot 🤖",
  "reason": "acknowledged"
}
```

### STATE: FOLLOW_UP → Evaluate & Respond

Read the follow-up question carefully:

1. **If clarifying question** → IMMEDIATE: Reply with answer
2. **If reveals real issue** → CODE_FIX + POST_PUSH: reply after fix

### STATE: NEW → Evaluate Critically

Read the original comment and relevant code.

**EVALUATION:**

| Verdict             | Criteria                              | Action               |
| ------------------- | ------------------------------------- | -------------------- |
| TRUE_POSITIVE       | Genuinely valid, applies to our code  | CODE_FIX + POST_PUSH |
| FALSE_POSITIVE      | Wrong, doesn't apply, already handled | IMMEDIATE: reply     |
| NEEDS_CLARIFICATION | Unclear what they want                | IMMEDIATE: ask       |

#### TRUE_POSITIVE → Code Fix + Post-Push

```json
// In code_fixes:
{
  "id": "coderabbit-fix-1",
  "file": "src/utils.ts",
  "line": 10,
  "description": "Add validation for empty string input",
  "priority": 3,
  "source": "coderabbit",
  "source_detail": "CodeRabbit: 'This function doesn't handle empty strings'"
}

// In post_push_actions:
{
  "type": "post_reply",
  "thread_id": "PRRT_...",
  "comment_id": "...",
  "body_template": "Good catch! Fixed in {commit_sha}.\n\nPlease re-evaluate when convenient.\n\nBy Claude Code Kagent Autopilot 🤖",
  "wait_for_fix_id": "coderabbit-fix-1",
  "request_re_evaluation": true
}
```

#### FALSE_POSITIVE → Immediate Action

```json
{
  "type": "close_thread",
  "thread_id": "PRRT_...",
  "comment_id": "...",
  "body": "This suggestion doesn't apply because:\n\n[Specific detailed reason]\n\nBy Claude Code Kagent Autopilot 🤖",
  "reason": "false_positive"
}
```

Note: Can also use `post_reply` instead of `close_thread` if you want to leave it open for CodeRabbit to respond.

#### NEEDS_CLARIFICATION → Immediate Action

```json
{
  "type": "post_reply",
  "thread_id": "PRRT_...",
  "comment_id": "...",
  "body": "Could you clarify what you mean by [X]? I'm not sure I understand the concern.\n\nBy Claude Code Kagent Autopilot 🤖",
  "reason": "needs_context"
}
```

### STATE: PENDING → Skip

CodeRabbit still running. Don't close or reply yet.

## Priority

CodeRabbit fixes are **priority 3** (lowest):

- Below CI (must pass first)
- Below human reviews (human > AI)

## Report Format

```json
{
  "resolver_type": "coderabbit",
  "coderabbit_ci_status": "completed|in_progress|not_found",

  "immediate_actions": [
    { "type": "close_thread", "thread_id": "...", "reason": "outdated" },
    { "type": "close_thread", "thread_id": "...", "reason": "ghosted" },
    { "type": "close_thread", "thread_id": "...", "reason": "acknowledged" },
    { "type": "close_thread", "thread_id": "...", "reason": "false_positive" }
  ],

  "code_fixes": [
    {
      "id": "coderabbit-fix-1",
      "file": "src/utils.ts",
      "line": 10,
      "description": "Fix edge case",
      "priority": 3,
      "source": "coderabbit",
      "source_detail": "..."
    }
  ],

  "post_push_actions": [
    {
      "type": "post_reply",
      "thread_id": "...",
      "comment_id": "...",
      "body_template": "Fixed in {commit_sha}.\n\nBy Claude Code Kagent Autopilot 🤖",
      "wait_for_fix_id": "coderabbit-fix-1",
      "request_re_evaluation": true
    }
  ],

  "pending_threads": ["thread_id_1", "thread_id_2"],

  "summary": {
    "total_threads": 5,
    "immediate_closed": 3,
    "code_fixes": 1,
    "pending": 1
  }
}
```

## Important Rules

1. **Never blindly accept** - always evaluate critically
2. **Always include signature** in replies
3. **Never close without posting a note first**
4. **Check CI status before determining ghosted**
5. **Request re-evaluation after TRUE_POSITIVE fixes**
6. **Priority is 3** - lowest priority, human > AI
