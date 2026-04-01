# KAgent Run Examples

## Example 1: Full Flow with Background Task

```
User: /kagent-run "Add input validation to the login form"

Claude: Let me find available claude binaries...
        [runs: compgen -c | grep '^claude' | sort -u]

        Found: claude, claude-personal, claude-auto-anthropic

        [AskUserQuestion: Which claude binaries should implement? (weighted)]
        Default: claude-auto-zai:2,claude-auto-mm:1

User: claude-personal:1,claude:1

Claude: [AskUserQuestion: Which reviewers in which phases?]
        Default: claude-auto-zai:1,claude-auto-mm:1,claude-auto-seed:0|...

User: claude-auto-anthropic:1

Claude: Setting up kagent with:
        - Implementers: claude-personal:1,claude:1 (weighted random per iteration)
        - Review phase 1: claude-auto-anthropic:1

        [writes spec.md with task spec]
        [writes config.yaml with implementers, reviewPhases, etc.]
        [runs: kloop init --spec ./spec.md --config ./config.yaml]
        [parses Run ID from output]
        [runs: rm -f spec.md config.yaml]

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

        [runs Bash with run_in_background: true: kloop run -d {runId} 2>&1 | tee .kagent/run.log]

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

## Example 2: Multi-Phase Review with Short-Circuit

```
User: /kagent-run "Implement OAuth2 with PKCE"

Claude: [discovers binaries...]
        Found: claude, claude-auto-anthropic, claude-auto-codex

        [AskUserQuestion: Implementers?]

User: claude

Claude: [AskUserQuestion: Reviewers by phase?]

User: I want 3 phases:
  Phase 1: claude-auto-anthropic:1
  Phase 2: claude-auto-codex:1
  Phase 3: claude-auto-anthropic:1 (final gate)

Claude: Setting up:
        - Implementer: claude
        - Phase 1: claude-auto-anthropic (strict)
        - Phase 2: claude-auto-codex (strict)
        - Phase 3: claude-auto-anthropic (strict — final gate)

        [writes spec.md and config.yaml]
        [runs: kloop init --spec ./spec.md --config ./config.yaml]
        [runs: rm -f spec.md config.yaml]

        ...spec written and approved...

        Running the loop...

        Iteration 1 (first loop — full review, all phases run):
          Phase 1: anthropic=approved
          Phase 2: codex=rejected (missing PKCE implementation)
          Phase 3: skipped (short-circuit)

        Iteration 2 (subsequent — short-circuit active):
          Phase 1: anthropic=approved
          Phase 2: codex=approved
          Phase 3: anthropic=approved

        KAgent run completed! All phases approved in iteration 2.
```

## Example 3: Conflict Detection

```
User: /kagent-run "Make the API both RESTful and GraphQL"

Claude: [...setup happens...]

        [writes spec with contradictory requirements]

User: Approve

Claude: Running the loop...

        [runs background task, waits...]

        Iteration 1: anthropic=rejected
        Iteration 2: anthropic=rejected
        Iteration 3: anthropic=rejected
          → consecutiveFailures (3) ≥ conflictCheckThreshold (3)
          → Running conflict checker (claude-personal)...
          → Conflict detected!
          → Exit code 2 (conflict)

        Conflict detected — the spec may contain contradictions.

        Conflict checker analysis:
        "The spec requires the API to be both RESTful and GraphQL
         simultaneously. These are competing architectural patterns
         that typically require separate endpoints/services."

        Suggested fix: "Choose one primary pattern and optionally
         add the other as a separate API surface."

        [AskUserQuestion: What would you like to do?]
        - "Edit spec to resolve conflict"
        - "Start another loop with new spec"
        - "Take over manually"

User: Edit spec to resolve conflict

Claude: Let's resolve the contradiction. Based on the conflict
        checker's suggestion, I'll update the spec to focus on
        one pattern.

        [edits spec with clarified requirements...]

        [AskUserQuestion: Approve updated spec?]
```

## Example 4: Agent Failure

```
User: /kagent-run "Refactor the database layer"

Claude: [...setup happens...]

        Running the loop...

        [runs background task, waits...]

        Agent failure — a crash or timeout occurred.

        The implementer (claude) timed out after 30 minutes
        during iteration 1. This typically means:
        - The task is too large for a single iteration
        - The agent got stuck in a loop

        [AskUserQuestion: What would you like to do?]
        - "Increase timeout and retry"
        - "Break the task into smaller sub-tasks"
        - "Take over manually"
```

## Example 5: User Starts Themselves

````
User: /kagent-run "Fix the broken date parser"

Claude: [discovers binaries...]

        Found: claude, claude-auto-anthropic

        [AskUserQuestion: Implementers?]

User: claude

Claude: [AskUserQuestion: Reviewers?]

User: claude-auto-anthropic

Claude: [initializes with single-phase review]
        [writes spec.md and config.yaml]
        [runs: kloop init --spec ./spec.md --config ./config.yaml]
        [parses Run ID: {runId}]
        [runs: rm -f spec.md config.yaml]

        [asks for approval...]

User: Approve

Claude: [AskUserQuestion: How would you like to start?]
        - "Start now (I'll run it and wait for completion)"
        - "I'll start it myself (show me the command)"

User: I'll start it myself (show me the command)

Claude: KAgent initialized.

        Here's the command to run the loop:

        ```bash
        kloop run -d {runId} 2>&1 | tee .kagent/run.log
        ```

        - Logs will be written to `.kagent/run.log`
        - Check status anytime with: `kloop status {runId}`
        - To cancel: `kloop cancel {runId}`
        - To view metrics: `kloop metrics --run {runId}`

        Note: Single-phase review means faster iterations.
````

## Example 6: Editing Spec Before Approval

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

Claude: [edits spec]

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

## Checking Status Manually

```
User: I started a loop earlier. What's the status?

Claude: Let me check the status for you.

        [runs: kloop ps]
        [finds active runId, then runs: kloop status {runId}]

        Current Status:
        - Iteration: 2/10
        - Phase: reviewing (phase 1 of 3)
        - Verdicts:
          - claude-auto-zai: approved (phase 0, iteration 1)
          - claude-auto-mm: rejected (phase 0, iteration 1)
        - Learnings: Fixed import order

        The loop is still running. Once it completes or reaches max loops, you can review the changes with `git diff`.
```

## Status Check Format

When checking status, run `kloop status {runId}` and report:

```
Current Status:
- Iteration: X/Y
- Phase: <phase> (phase N of M, if reviewing)
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

**Max Iterations:**

```
Max iterations reached (N/N)

The reviewers couldn't reach consensus.

Last rejection reasons (from kloop review {runId}):
- <reason from review files>

Options:
1. Review changes: git diff
2. Run another kagent-run with refined spec
3. Take over manually
```

**Conflict:**

```
Conflict detected — the spec may contain contradictions.

Analysis: <reasoning from conflict checker>
Suggested fix: <suggestedFix if available>

Options:
1. Edit spec to resolve conflict
2. Start another kagent-run with new spec
3. Take over manually
```

**Agent Failure:**

```
Agent failure — a crash or timeout occurred.

The <role> (<binary>) failed during iteration N.
Check logs: kloop logs {runId}

Options:
1. Increase timeout and retry
2. Break the task into smaller sub-tasks
3. Take over manually
```
