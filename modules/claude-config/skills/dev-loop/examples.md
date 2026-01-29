# Dev Loop Examples

## Example 1: Basic Usage

```
User: /dev-loop "Add input validation to the login form"

Claude: Let me find available claude binaries...
        [runs: compgen -c | grep '^claude' | sort -u]

        Found: claude, claude-personal, claude-reviewer-anthropic,
               claude-reviewer-gemini

        [AskUserQuestion: Which binary should implement?]

User: claude-personal

Claude: [AskUserQuestion: Which binaries should review? (multi-select)]

User: claude-reviewer-anthropic, claude-reviewer-gemini

Claude: Setting up dev-loop with:
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

Claude: Starting dev-loop in tmux session...

        [runs: SESSION_UID=$(date +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)]
        [runs: tmux new-session -d -s "dev-loop-$SESSION_UID" "..."]

        ✅ Dev loop started in tmux session: dev-loop-20250115-143022-a1b2c3d4

        To inspect: tmux attach -t dev-loop-20250115-143022-a1b2c3d4
        To detach: Ctrl+B, D
        To cancel: dev-loop cancel

        I'll poll for progress every 5 minutes...

        [waits 5 minutes]
        [runs: dev-loop status]

        📊 Progress (session: dev-loop-20250115-143022-a1b2c3d4)
           To inspect: tmux attach -t dev-loop-20250115-143022-a1b2c3d4
        - Iteration: 1/10
        - Phase: implementing

        [waits 5 minutes]
        [runs: dev-loop status]

        📊 Progress (session: dev-loop-20250115-143022-a1b2c3d4)
           To inspect: tmux attach -t dev-loop-20250115-143022-a1b2c3d4
        - Iteration: 1/10
        - Phase: reviewing
        - Verdicts:
          - claude-reviewer-anthropic: approved ✅
          - claude-reviewer-gemini: rejected ❌

        [waits 5 minutes]

        📊 Progress (session: dev-loop-20250115-143022-a1b2c3d4)
           To inspect: tmux attach -t dev-loop-20250115-143022-a1b2c3d4
        - Iteration: 2/10
        - Phase: implementing
        - Learnings from iteration 1:
          - Need to add aria-invalid attribute
          - Error messages need proper contrast ratio

        [continues polling...]

        🎉 Dev loop completed! (session: dev-loop-20250115-143022-a1b2c3d4)
        - Final iteration: 3
        - All reviewers approved

        Changes are ready. Run `git diff` to review, then commit when ready.
```

## Example 2: Single Reviewer

```
User: /dev-loop "Fix the broken date parser"

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

Claude: ✅ Dev loop started: dev-loop-20250115-150000-xyz789

        Note: Single reviewer means faster iterations but less diverse feedback.

        [polling continues with single reviewer verdicts]
```

## Example 3: Editing Spec Before Approval

```
User: /dev-loop "Refactor the API client"

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

Claude: [starts dev-loop...]
```

## Example 4: Max Loops Reached

```
User: /dev-loop "Implement OAuth flow"

[... setup and approval ...]

Claude: 📊 Progress (session: dev-loop-20250115-160000-abc123)
        - Iteration: 9/10
        - Phase: reviewing
        - Verdicts:
          - claude-reviewer-anthropic: rejected ❌
          - claude-reviewer-gemini: approved ✅

        [waits 5 minutes]

        📊 Progress (session: dev-loop-20250115-160000-abc123)
        - Iteration: 10/10
        - Phase: reviewing
        - Verdicts:
          - claude-reviewer-anthropic: rejected ❌
          - claude-reviewer-gemini: approved ✅

        ⚠️ Max loops reached (10/10)

        The reviewers couldn't reach consensus.

        Last rejection reasons (from reviews/claude-reviewer-anthropic.md):
        - Missing PKCE implementation
        - Token refresh not handling edge case

        Options:
        1. Review the changes manually: `git diff`
        2. Inspect the session: `tmux attach -t dev-loop-20250115-160000-abc123`
        3. Run another dev-loop with a more specific spec
        4. Take over manually
```

## Example 5: Inspecting During Execution

```
User: /dev-loop "Add unit tests for utils"

[... starts dev-loop ...]

Claude: 📊 Progress (session: dev-loop-20250115-170000-def456)
        - Iteration: 2/10
        - Phase: implementing

User: Let me check what's happening

Claude: To inspect the live session:

        tmux attach -t dev-loop-20250115-170000-def456

        Once attached, you can see the implementer working in real-time.
        Press Ctrl+B, then D to detach without interrupting.

        Current sessions for iteration 2:
        - 🔨 claude-personal: abc123-session
        - 🔍 claude-reviewer-anthropic: pending
        - 🔍 claude-reviewer-gemini: pending

User: [attaches, watches, detaches]
      Looks good, let it continue

Claude: [continues polling...]

        📊 Progress (session: dev-loop-20250115-170000-def456)
        - Iteration: 2/10
        - Phase: reviewing
```

## Progress Update Format

Always include session name in every update:

```
📊 Progress (session: dev-loop-<SESSION_UID>)
   To inspect: tmux attach -t dev-loop-<SESSION_UID>
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
🎉 Dev loop completed! (session: dev-loop-<SESSION_UID>)
- Final iteration: N
- All reviewers approved

Changes are ready. Run `git diff` to review.
```

**Max Loops:**

```
⚠️ Max loops reached (N/N)

Session: dev-loop-<SESSION_UID>
To inspect: tmux attach -t dev-loop-<SESSION_UID>

Last rejection reasons:
- <reason from review files>

Options:
1. Review changes: git diff
2. Inspect session
3. Run new dev-loop with refined spec
4. Take over manually
```
