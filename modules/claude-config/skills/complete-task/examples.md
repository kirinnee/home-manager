# Complete Task Examples

## Example 1: Happy Path with Jira Ticket

```
User: /complete-task

Claude: Let me check for existing task state...
        No .kagent/task-state.json found. Starting fresh.

        Detecting ticket from branch...
        [runs: git branch --show-current]
        Branch: PE-1234-add-auth

        Detected ticket: PE-1234 (Jira)

        Fetching ticket details...
        [runs: acli jira workitem view PE-1234 --fields '*all' --json]

        Ticket: PE-1234 - Add user authentication
        Description: Implement JWT-based authentication for the API...

        [AskUserQuestion: Which binary for implementation?]

User: claude-personal

Claude: [AskUserQuestion: Which binaries for review? (multi-select)]

User: claude-reviewer-anthropic, claude-reviewer-gemini

Claude: [AskUserQuestion: Which binary for conflict checking?]

User: claude-personal

Claude: [AskUserQuestion: Loop parameters?]
        - Max push cycles (outer: push→CI→review→fix rounds): default 5
        - Max iterations (inner: implement→review passes per run): default 10
        - Conflict check threshold (consecutive failures before conflict check): default 3
        - Implementer timeout: default 30 min
        - Reviewer timeout: default 15 min

User: Defaults are fine

Claude: I have a few questions about the requirements:
        [AskUserQuestion: Should this use JWT or session-based auth?]

User: JWT with refresh tokens

Claude: Here's the generated task spec:

        # Task Specification: Add user authentication (PE-1234)
        ## Source
        - Ticket: PE-1234
        - System: Jira
        ## Objective
        Implement JWT-based authentication with refresh tokens...
        ## Acceptance Criteria
        - [ ] Login endpoint returns JWT + refresh token
        - [ ] Protected routes require valid JWT
        ...

        [AskUserQuestion: Approve spec and start autonomous loop?]

User: Approve

Claude: Spec approved. Writing state file and beginning autonomous loop.
        (No further interaction needed unless conflict or push failure)

        [writes .kagent/task-state.json: phase "approved"]
        [writes .kagent/task-spec.md]
        [copies task-spec.md to .kagent/spec.md]
        [runs: dev-loop init --implementer claude-personal --reviewers "claude-reviewer-anthropic,claude-reviewer-gemini" --conflict-checker claude-personal --max-iterations 10 --implementer-timeout 30 --reviewer-timeout 15 --conflict-check-threshold 3]
        [writes state: devLoopInitialized true, phase "running"]
        [runs background: dev-loop run 2>&1 | tee .kagent/run.log]
        [blocks on TaskOutput...]

        Dev-loop running (push cycle 1/5)
          Spec: .kagent/spec.md
          Logs: .kagent/run.log

        [dev-loop completes, exit code 0]
        [reads .kagent/history/ → status: completed]

        Dev-loop completed! All reviewers approved.

        Checking commit conventions...
        [reads CONTRIBUTING.md → conventional commits]

        Creating commit...
        feat(auth): implement JWT authentication with refresh tokens

        [PE-1234]

        Pushing to PE-1234-add-auth...
        [runs: git push -u origin HEAD]

        Creating PR...
        [runs: gh pr create --title "[PE-1234] Add user authentication" ...]
        PR #42 created.

        [writes state: prNumber 42, pushCycle 1, phase "polling"]

        Starting CI/review poll...
        [runs background: dev-loop poll-pr 42]

        Polling CI/reviews for PR #42 (push cycle 1/5)

        [poller exits after 8 minutes]
        STATUS: all_pass
        CI: build passed, test passed, lint passed
        Reviews: @teammate approved

        Task Complete!
          Ticket: PE-1234
          PR: #42 - [PE-1234] Add user authentication
          Push cycles used: 1/5

          To merge: gh pr merge 42
```

## Example 2: CI Failure and Fix Loop

```
[... after first push, poller returns ...]

Claude: STATUS: ci_failed
        CI: build passed, test FAILED, lint passed

        CI failure detected. Generating fix spec...

        [runs: gh run list --branch PE-1234-add-auth --status failure --limit 1 --json databaseId]
        [runs: gh run view 12345 --log-failed]

        Error: AuthService.test.ts - Expected 401, got 403

        Writing fix spec to .kagent/spec.md...

        # Fix Specification: PE-1234 - Push Cycle 2/5
        ## Issues to Address
        ### CI Failures
        - **test**: AuthService.test.ts - Expected 401, got 403

        [runs: dev-loop cancel]
        [writes state: phase "run_spec"]
        [runs background: dev-loop run 2>&1 | tee .kagent/run.log]

        Dev-loop running (push cycle 2/5)

        [dev-loop completes, exit code 0, status completed]

        Creating commit...
        fix(auth): correct status code for unauthorized requests

        [PE-1234]

        Pushing...
        [runs: git push -u origin HEAD]
        Push auto-updates PR #42.

        [runs background: dev-loop poll-pr 42]

        [poller exits]
        STATUS: all_pass

        Task Complete!
          Ticket: PE-1234
          PR: #42 - [PE-1234] Add user authentication
          Push cycles used: 2/5

          To merge: gh pr merge 42
```

## Example 3: Review Changes Requested

```
[... poller returns ...]

Claude: STATUS: changes_requested
        Reviews: @senior-dev changes requested

        Review feedback detected. Gathering comments...

        [runs: gh api repos/org/repo/pulls/42/comments]
        [runs: gh pr view 42 --json reviews]

        @senior-dev: "Missing rate limiting on login endpoint"
        @senior-dev on src/auth.ts:45: "Should use bcrypt, not SHA256"

        Writing fix spec...

        # Fix Specification: PE-1234 - Push Cycle 2/5
        ## Issues to Address
        ### Review Comments
        - **@senior-dev** on src/auth.ts:45: Should use bcrypt, not SHA256
        - **@senior-dev**: Missing rate limiting on login endpoint

        [runs dev-loop with fix spec...]
        [commits, pushes...]
        [runs background: dev-loop poll-pr 42]

        STATUS: all_pass

        Task Complete!
          Push cycles used: 2/5
```

## Example 4: Spec Conflict (Exit 2) — User Clarification Required

```
[... dev-loop running, 3 consecutive failed iterations ...]
[... conflict checker detects spec ambiguity, exits with code 2 ...]

Claude: [dev-loop exits with code 2]

        Reading conflict analysis...
        [reads .kagent/conflict.md]
        [reads .kagent/reviews/a1b2c3d4/review-3-0-claude-reviewer-anthropic.md]
        [reads .kagent/reviews/a1b2c3d4/review-3-1-claude-reviewer-gemini.md]

        The spec contains conflicting requirements.

        Task context:
          Ticket: PE-1234 - Add user authentication
          You're implementing JWT-based auth with refresh tokens
          for the API, including login endpoint and route protection.

        Spec conflict (from conflict analysis):
          The spec says "protect all API routes" but also says
          "health check and public endpoints should be accessible
          without auth." The spec doesn't define which mechanism
          to use for distinguishing protected vs public routes,
          so the implementation keeps oscillating between
          approaches and reviewers reject on different grounds.

        How this manifests in reviews:
          Reviewer 1 (claude-reviewer-anthropic):
            "Auth should be global middleware with a whitelist
            of public routes — the spec says 'protect all routes'
            which implies a default-deny approach."

          Reviewer 2 (claude-reviewer-gemini):
            "The spec mentions specific public endpoints, so auth
            should be opt-in per route with a @RequireAuth decorator
            to keep public routes the default."

        The spec needs clarification on how to apply auth.

        [AskUserQuestion: How should the spec define route protection?]
        Options:
        - "Default-deny: global middleware + whitelist of public routes"
        - "Default-allow: opt-in auth per protected route"
        - "Default-deny with explicit exceptions listed in a config file"

User: Default-deny: global middleware + whitelist of public routes

Claude: Got it. Clarifying the spec with your decision.

        [writes state: conflictContext "Clarify spec: use default-deny
         approach. Apply auth middleware globally with app.use(), and
         maintain a whitelist array of public routes (health, public
         endpoints). All other routes require valid JWT."]
        [removes .kagent/conflict.md]
        [runs: dev-loop cancel]

        Writing fix spec with clarification...

        # Fix Specification: PE-1234 - Push Cycle 2/5
        ## Issues to Address
        ### Spec Clarification
        - **Ambiguity**: Spec didn't define mechanism for protected
          vs public routes
        - **Clarification**: Use default-deny approach. Global auth
          middleware with app.use(), whitelist array of public routes.
          All other routes require valid JWT by default.

        [runs dev-loop with fix spec...]
        [continues autonomously...]
```

## Example 5a: Push Failure — Auto-Resolved

```
[... after dev-loop completes ...]

Claude: Pushing to PE-1234-add-auth...
        [runs: git push -u origin HEAD]

        Push rejected (remote has new commits). Trying fast-forward...
        [runs: git pull --ff-only origin PE-1234-add-auth]
        Fast-forward failed. Trying rebase...
        [runs: git pull --rebase origin PE-1234-add-auth]
        Rebase applied cleanly.

        [runs: git push -u origin HEAD]
        Push successful after rebase.
        [continues to PR creation/polling...]
```

## Example 5b: Push Failure — Merge Conflicts (User Required)

```
[... after dev-loop completes ...]

Claude: Pushing to PE-1234-add-auth...
        [runs: git push -u origin HEAD]

        Push rejected. Trying fast-forward...
        [runs: git pull --ff-only origin PE-1234-add-auth]
        Fast-forward failed. Trying rebase...
        [runs: git pull --rebase origin PE-1234-add-auth]

        Rebase failed — merge conflicts in src/auth.ts

        [AskUserQuestion: Rebase has conflicts I can't auto-resolve.]
        Options:
        - "Let me resolve the conflicts manually"
        - "Abort"

User: Let me resolve the conflicts manually

Claude: [runs: git rebase --abort]
        Rebase aborted. Please resolve manually and re-run /complete-task.
        [writes state: phase "pushing"]
```

## Example 6: Max Push Cycles Reached

```
[... push cycle 5/5, poller returns ...]

Claude: STATUS: ci_failed
        CI: test still failing (2 tests)

        Push cycle limit reached (5/5). Cannot retry.

        Max push cycles reached (5/5)
          Ticket: PE-1234
          PR: #42

          Remaining issues:
          - CI: 2 tests still failing in AuthService edge cases
          - Review: @senior-dev has unresolved comment on rate limiting

          Please take over manually:
          1. Review failing tests: npm test -- --grep "AuthService"
          2. See review comments: gh pr view 42 --comments

        [writes state: phase "failed"]
```

## Example 7: Resume from Interrupted Session

```
User: /complete-task

Claude: Checking for existing task state...
        Found .kagent/task-state.json

        Resuming task:
          Ticket: PE-1234 (Jira)
          Phase: polling
          PR: #42
          Push cycle: 2/5

        Restarting CI/review poll for PR #42...
        [runs background: dev-loop poll-pr 42]

        [poller exits]
        STATUS: all_pass

        Task Complete!
          Ticket: PE-1234
          PR: #42 - [PE-1234] Add user authentication
          Push cycles used: 2/5

          To merge: gh pr merge 42
```

## Example 8: Resume from Running Phase (dev-loop died)

```
User: /complete-task

Claude: Found .kagent/task-state.json
        Phase: running

        Checking for active dev-loop run...
        [checks .kagent/current/run.json → not found]
        [checks tmux sessions → no devloop sessions]

        Dev-loop is not running. Reading last result...
        [reads .kagent/history/ → latest: a1b2c3d4.json, status: completed]

        Previous run completed (all approved).
        Proceeding to commit and push...

        [continues from pushing phase...]
```

## Example 9: ClickUp Ticket with Auto-Detection

```
User: /complete-task

Claude: Detecting ticket from branch...
        [runs: git branch --show-current]
        Branch: CU-abc123-fix-login

        Detected ticket: CU-abc123 (ClickUp)

        Fetching from ClickUp...
        [uses ClickUp MCP tools to get task details]

        Ticket: CU-abc123 - Fix login page redirect
        Description: The login page redirects to /dashboard instead of /home...

        [continues with normal setup flow...]
```

## Example 10: Manual Ticket Entry

```
User: /complete-task

Claude: Detecting ticket from branch...
        [runs: git branch --show-current]
        Branch: feature/new-thing

        Could not detect ticket ID from branch.

        [AskUserQuestion: What is the ticket ID?]

User: PE-5678

Claude: Detected: PE-5678 (Jira)
        [continues with fetching and setup...]
```

## Example 11: Dev-Loop Max Iterations (Auto-Retry)

```
[... dev-loop running ...]

Claude: [dev-loop exits with code 0]
        [reads .kagent/history/ → status: max_iterations]

        Dev-loop reached max iterations (10) without consensus.
        Push cycle 1/5 — retrying with fix spec.

        Reading reviewer feedback...
        [reads .kagent/reviews/a1b2c3d4/review-10-0-claude-reviewer-anthropic.md]
        [reads .kagent/reviews/a1b2c3d4/verdict-10-0-claude-reviewer-anthropic.json]

        Reviewer 1 rejected: "Edge case handling missing for null input"
        Reviewer 2 approved.

        Generating fix spec from reviewer feedback...

        # Fix Specification: PE-1234 - Push Cycle 1/5
        ## Issues to Address
        ### Review Comments
        - **claude-reviewer-anthropic**: Edge case handling missing for null input

        [runs dev-loop with fix spec...]
        [this time all reviewers approve...]
        [commits, pushes, polls...]
```
