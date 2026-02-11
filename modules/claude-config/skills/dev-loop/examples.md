# Dev Loop Examples

## Example 1: Basic Usage

````
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

Claude: ✅ Dev loop initialized at `.kagent/`

        Here's the command to run the loop:

        ```bash
        SESSION_UID=$(date +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)
        tmux new-session -d -s "dev-loop-$SESSION_UID" "zsh -ic 'dev-loop run --dir .kagent; read -q \"?Press Enter to close...\"'"
        ```

        To inspect progress once started:
        - Attach to tmux: `tmux attach -t dev-loop-<UID>`
        - Check status: `dev-loop status --dir .kagent`
        - To cancel: `dev-loop cancel --dir .kagent`
````

## Example 2: Single Reviewer

````
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

Claude: ✅ Dev loop initialized at `.kagent/`

        Here's the command to run the loop:

        ```bash
        SESSION_UID=$(date +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)
        tmux new-session -d -s "dev-loop-$SESSION_UID" "zsh -ic 'dev-loop run --dir .kagent; read -q \"?Press Enter to close...\"'"
        ```

        Note: Single reviewer means faster iterations but less diverse feedback.
````

## Example 3: Editing Spec Before Approval

````
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

Claude: ✅ Dev loop initialized at `.kagent/`

        Here's the command to run the loop:

        ```bash
        SESSION_UID=$(date +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)
        tmux new-session -d -s "dev-loop-$SESSION_UID" "zsh -ic 'dev-loop run --dir .kagent; read -q \"?Press Enter to close...\"'"
        ```
````

## Example 4: Checking Status After User Runs Loop

```
User: I've started the loop. What's the status?

Claude: Let me check the status for you.

        [runs: dev-loop status --dir .kagent]

        📊 Current Status:
        - Iteration: 2/10
        - Phase: reviewing
        - Verdicts:
          - claude-reviewer-anthropic: approved ✅
          - claude-reviewer-gemini: rejected ❌

        The loop is still running. Once it completes or reaches max loops, you can review the changes with `git diff`.
```

## Example 5: Max Loops Reached

```
User: What's the status of the loop?

Claude: Let me check.

        [runs: dev-loop status --dir .kagent]

        ⚠️ Max loops reached (10/10)

        The reviewers couldn't reach consensus.

        Last rejection reasons (from .kagent/reviews/):
        - Missing PKCE implementation
        - Token refresh not handling edge case

        Options:
        1. Review the changes manually: `git diff`
        2. Inspect the session: `tmux attach -t dev-loop-<UID>`
        3. Run another dev-loop with a more specific spec
        4. Take over manually
```

## Status Check Format

When user asks for status, run `dev-loop status --dir .kagent/dev-loop` and report:

```
📊 Current Status:
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
🎉 Dev loop completed!
- Final iteration: N
- All reviewers approved

Changes are ready. Run `git diff` to review.
```

**Max Loops:**

```
⚠️ Max loops reached (N/N)

The reviewers couldn't reach consensus.

Last rejection reasons:
- <reason from review files>

Options:
1. Review changes: git diff
2. Run new dev-loop with refined spec
3. Take over manually
```
