# KAgent Run Examples

## Example 1: Full Flow with Background Task

```
User: /kagent-run "Add input validation to the login form"

Claude: Let me find available claude binaries...
        [runs: compgen -c | grep '^claude' | sort -u]

        Found: claude, claude-personal, claude-reviewer-anthropic,
               claude-reviewer-gemini

        [AskUserQuestion: Which binary should implement?]

User: claude-personal

Claude: [AskUserQuestion: Which binaries should review? (multi-select)]

User: claude-reviewer-anthropic, claude-reviewer-gemini

Claude: Setting up kagent with:
        - Executor: claude-personal
        - Reviewers: claude-reviewer-anthropic, claude-reviewer-gemini

        [runs: dev-loop init --claude claude-personal --reviewers "claude-reviewer-anthropic,claude-reviewer-gemini"]

        [writes spec.md based on task]

        Here's the spec:

        # Specification: Add Login Form Validation

        ## Objective
        Add client-side validation to the login form...

        ## Acceptance Criteria
        - [ ] Email field validates format
        - [ ] Password field requires minimum 8 characters
        - [ ] Error messages display below invalid fields
        - [ ] Submit button disabled until valid

        [AskUserQuestion: Approve spec?]

User: Approve

Claude: [AskUserQuestion: How would you like to start the loop?]
        - "Start now (I'll run it and wait for completion)"
        - "I'll start it myself (show me the command)"

User: Start now (I'll run it and wait for completion)

Claude: Running the loop...

        [runs Bash with run_in_background: true: dev-loop run 2>&1 | tee .kagent/run.log]

        [waits with TaskOutput until completion]

        KAgent run completed!
        - Final iteration: 2
        - All reviewers approved

        [AskUserQuestion: The loop is done. What would you like to do?]
        - "Review changes (git diff)"
        - "Commit the changes"
        - "Run tests"
        - "Start another loop with refined spec"

User: Commit the changes

Claude: [runs git commands to commit the changes]

        Changes committed!
```

## Example 2: User Starts Themselves

````
User: /kagent-run "Fix the broken date parser"

Claude: [discovers binaries...]

        Found: claude, claude-reviewer-anthropic

        [AskUserQuestion: Executor?]

User: claude

Claude: [AskUserQuestion: Reviewers?]

User: claude-reviewer-anthropic

Claude: [initializes with single reviewer]
        [writes spec focusing on the date parser bug]
        [asks for approval...]

User: Approve

Claude: [AskUserQuestion: How would you like to start?]
        - "Start now (I'll run it and wait for completion)"
        - "I'll start it myself (show me the command)"

User: I'll start it myself (show me the command)

Claude: KAgent initialized at `.kagent/`

        Here's the command to run the loop:

        ```bash
        dev-loop run 2>&1 | tee .kagent/run.log
        ```

        - Logs will be written to `.kagent/run.log`
        - Check status anytime with: `dev-loop status`
        - To cancel: `dev-loop cancel`

        Note: Single reviewer means faster iterations but less diverse feedback.
````

## Example 3: Editing Spec Before Approval

```
User: /kagent-run "Refactor the API client"

Claude: [discovers binaries, user selects...]

        Here's the spec:

        # Specification: Refactor API Client

        ## Acceptance Criteria
        - [ ] Extract common HTTP logic
        - [ ] Add retry logic
        - [ ] Improve error handling

        [AskUserQuestion: Approve spec?]

User: Edit spec first

Claude: What changes would you like to make to the spec?

User: Add a criterion for TypeScript types and remove the retry logic -
      we'll do that separately.

Claude: [edits spec.md]

        Updated spec:

        ## Acceptance Criteria
        - [ ] Extract common HTTP logic
        - [ ] Add TypeScript types for all responses
        - [ ] Improve error handling

        [AskUserQuestion: Approve updated spec?]

User: Approve

Claude: [AskUserQuestion: How would you like to start?]

        ...continues as in examples above
```

## Example 4: Max Loops Reached

```
User: /kagent-run "Implement OAuth2 with PKCE"

Claude: [setup happens...]

        [AskUserQuestion: How would you like to start?]

User: Start now

Claude: Running the loop...

        [runs background task, waits...]

        Max loops reached (10/10)

        The reviewers couldn't reach consensus.

        Last rejection reasons (from .kagent/reviews/):
        - Missing PKCE implementation
        - Token refresh not handling edge case

        [AskUserQuestion: What would you like to do?]
        - "Review changes (git diff)"
        - "Start another loop with refined spec"
        - "Take over manually"

User: Start another loop with refined spec

Claude: Let's refine the spec. Based on the rejection feedback, we should:
        1. Focus specifically on PKCE implementation
        2. Handle token refresh edge cases

        [edits spec.md with more specific criteria...]

        [AskUserQuestion: Approve refined spec?]
```

## Example 5: Checking Status Manually

```
User: I started a loop earlier. What's the status?

Claude: Let me check the status for you.

        [runs: dev-loop status]

        Current Status:
        - Iteration: 2/10
        - Phase: reviewing
        - Verdicts:
          - claude-reviewer-anthropic: approved
          - claude-reviewer-gemini: rejected

        The loop is still running. Once it completes or reaches max loops, you can review the changes with `git diff`.
```

## Status Check Format

When checking status, run `dev-loop status` and report:

```
Current Status:
- Iteration: X/Y
- Phase: <phase>
- Verdicts: (if reviewing phase)
  - <reviewer>: <verdict>
- Learnings: (if available)
  - <learning point>
```

## Completion Formats

**Success:**

```
KAgent run completed!
- Final iteration: N
- All reviewers approved

Changes are ready. Run `git diff` to review.
```

**Max Loops:**

```
Max loops reached (N/N)

The reviewers couldn't reach consensus.

Last rejection reasons:
- <reason from review files>

Options:
1. Review changes: git diff
2. Run another kagent-run with refined spec
3. Take over manually
```
