# Complete Task Examples

## Example 1: Full Flow with Jira Ticket

```
User: /complete-task

Claude: Let me detect the ticket from your branch/worktree...
        [runs: git branch --show-current]

        Branch: PE-1234-add-auth

        ✅ Detected ticket: PE-1234 (Jira)

        Fetching task details...
        [runs: acli jira workitem view PE-1234 --fields '*all' --json]

        📋 Ticket: PE-1234 - Add user authentication

        Description:
        Implement JWT-based authentication for the API...

        Let me find available claude binaries...
        [runs: compgen -c | grep '^claude' | sort -u]

        [AskUserQuestion: Which binary for implementation?]

User: claude-personal

Claude: [AskUserQuestion: Which binaries for review? (multi-select)]

User: claude-reviewer-anthropic, claude-reviewer-gemini

Claude: [AskUserQuestion: Max push cycles?]

User: 5

Claude: I have a few questions to clarify requirements:

        [AskUserQuestion: Should this use JWT or session-based auth?]

User: JWT

Claude: [AskUserQuestion: Include refresh token support?]

User: Yes

Claude: Here's the generated spec:

        # Specification: Add User Authentication (PE-1234)

        ## Source
        - Ticket: PE-1234
        - System: Jira

        ## Objective
        Implement JWT-based authentication with refresh tokens...

        ## Acceptance Criteria
        - [ ] Login endpoint returns JWT + refresh token
        - [ ] Protected routes require valid JWT
        - [ ] Refresh token endpoint issues new JWT
        - [ ] Invalid tokens return 401

        [AskUserQuestion: Approve spec and start autonomous loop?]

User: Approve and Start

Claude: ✅ Spec approved. Starting autonomous loop...
        (No further interaction needed unless push fails)

        [runs: dev-loop init --claude claude-personal --reviewers "..."]

        📊 Dev-loop started (session: dev-loop-20250115-143022-a1b2c3d4)
           To inspect: tmux attach -t dev-loop-20250115-143022-a1b2c3d4

        [polls every 5 minutes...]

        📊 Dev-loop Progress
        - Iteration: 2/10
        - Phase: reviewing

        [dev-loop completes]

        ✅ Dev-loop completed. Creating commit...

        [checks for commit conventions]
        Found: CONTRIBUTING.md specifies conventional commits

        [creates commit]
        feat(auth): implement JWT authentication with refresh tokens

        [PE-1234]

        - Add login endpoint with JWT generation
        - Add refresh token rotation
        - Protect routes with auth middleware

        Pushing to branch PE-1234-add-auth...
        [runs: git push -u origin HEAD]

        Creating PR...
        [runs: gh pr create ...]

        📊 PR Status (session: dev-loop-20250115-143022-a1b2c3d4)
           PR: #42 - [PE-1234] Add user authentication

        CI Checks:
        - ✅ build: passed
        - ⏳ test: running

        Reviews:
        - CodeRabbit: Pending

        [waits 5 minutes]

        CI Checks:
        - ✅ build: passed
        - ✅ test: passed
        - ✅ lint: passed

        Reviews:
        - CodeRabbit: Approved
        - @teammate: Approved

        🎉 Task Complete!
           Ticket: PE-1234
           PR: #42 - [PE-1234] Add user authentication
           Status: Ready to merge

           To merge: gh pr merge 42
```

## Example 2: Auto-Detection from Worktree

```
User: /complete-task

Claude: Let me detect the ticket...
        [runs: git branch --show-current]
        Branch: main

        [runs: wt current]
        Worktree: PE-5678-fix-parser

        ✅ Detected ticket: PE-5678 (Jira) from worktree

        [continues with normal flow...]
```

## Example 3: Manual Ticket Entry

```
User: /complete-task

Claude: Let me detect the ticket...
        [runs: git branch --show-current]
        Branch: feature/new-thing

        Could not detect ticket ID from branch or worktree.

        [AskUserQuestion: What is the ticket ID?]
        (User can type in "Other")

User: CU-abc123

Claude: ✅ Ticket: CU-abc123 (ClickUp)

        Fetching from ClickUp...
        [uses ClickUp MCP tools]

        [continues with normal flow...]
```

## Example 4: CI Failure and Fix Loop

```
[... after first push ...]

Claude: 📊 PR Status (push cycle 1/5)
           PR: #42

        CI Checks:
        - ✅ build: passed
        - ❌ test: failed
        - ✅ lint: passed

        Reviews:
        - CodeRabbit: Changes requested

        Starting fix loop (push cycle 2/5)...

        Generating fix spec from feedback:

        # Specification: Fix PR Feedback (PE-1234 - Attempt 2)

        ## Issues to Fix

        ### CI Failures
        - test: AuthService.test.ts - Expected 401, got 403

        ### Review Comments
        - CodeRabbit: Missing rate limiting on login endpoint

        ## Acceptance Criteria
        - [ ] Fix status code in auth rejection
        - [ ] Add rate limiting to login
        - [ ] All CI checks pass

        [runs dev-loop with fix spec...]
        [commits and pushes...]

        📊 PR Status (push cycle 2/5)

        CI Checks:
        - ✅ build: passed
        - ✅ test: passed
        - ✅ lint: passed

        Reviews:
        - CodeRabbit: Approved

        🎉 Task Complete!
```

## Example 5: Push Failure (User Intervention)

```
[... after dev-loop completes ...]

Claude: ✅ Dev-loop completed. Creating commit...

        [creates commit]

        Pushing to branch PE-1234-add-auth...
        [runs: git push -u origin HEAD]

        ❌ Push failed:

        error: failed to push some refs to 'origin'
        hint: Updates were rejected because the remote contains work that you do not have locally.

        This is the ONLY intervention point in the autonomous loop.

        [AskUserQuestion: How should I proceed?]
        Options:
        - Pull and rebase
        - Let me handle manually
        - Abort

User: Pull and rebase

Claude: [runs: git pull --rebase origin PE-1234-add-auth]
        [runs: git push -u origin HEAD]

        ✅ Push successful after rebase.

        [continues with PR creation...]
```

## Example 6: Max Push Cycles Reached

```
[... after multiple fix attempts ...]

Claude: 📊 PR Status (push cycle 5/5)

        CI Checks:
        - ✅ build: passed
        - ❌ test: 2 failing
        - ✅ lint: passed

        Reviews:
        - @senior-dev: Changes requested (unresolved)

        ⚠️ Max push cycles reached (5/5)
           Ticket: PE-1234
           PR: #42

           Remaining issues:
           - test: 2 tests still failing in edge cases
           - @senior-dev: Wants different error handling approach

           Please take over manually:
           1. Review failing tests: npm test -- --grep "AuthService"
           2. See review comments: gh pr view 42 --comments
           3. Dev-loop sessions: tmux attach -t dev-loop-...
```

## Progress Update Formats

### During Dev-Loop

```
📊 Dev-loop Progress (session: dev-loop-<UID>)
   To inspect: tmux attach -t dev-loop-<UID>
- Iteration: X/Y
- Phase: implementing/reviewing
```

### During PR Review

```
📊 PR Status (push cycle N/M)
   PR: #<number> - <title>

CI Checks:
- ✅/❌/⏳ <check>: <status>

Reviews:
- <reviewer>: <status>

Comments: N unresolved
```

### Success

```
🎉 Task Complete!
   Ticket: <ID>
   PR: #<number> - <title>
   Status: Ready to merge

   To merge: gh pr merge <number>
```

### Max Cycles

```
⚠️ Max push cycles reached (N/N)
   Ticket: <ID>
   PR: #<number>

   Remaining issues:
   - <issue 1>
   - <issue 2>

   Please take over manually.
```
