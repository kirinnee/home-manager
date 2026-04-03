---
name: kagent-run
description: 'Run spec-driven code implementation with multi-reviewer consensus. Use when running /kagent-run, starting an implementation loop, needing automated code review cycles, or iterating on code until all reviewers approve.'
argument-hint: '[TASK_DESCRIPTION]'
---

# KAgent Run - Spec-Driven Development with kloop

An iterative development loop: collaboratively write a rigorous spec, then run `kloop` to implement and review until consensus is reached.

## When to Use

- User runs `/kagent-run` with a task description
- User wants automated implement→review→fix cycles
- User needs multiple AI reviewers to reach consensus
- User wants hands-off iteration until code is approved

## Prerequisites

- `tmux` installed (`brew install tmux` / `apt install tmux`)
- `kloop` available in PATH
- `~/.kloop/config.yaml` exists (created automatically on first `kloop init`)

## Workflow

### Step 1: Spec Discussion

**Collaborate with the user to write a comprehensive spec.** Use the template in [templates/spec-template.md](templates/spec-template.md).

Key areas to discuss and nail down:

1. **Objective** — what to build, 1-3 sentences
2. **Risk Assessment** — evaluate blast radius, reversibility, dependency surface area. Rate LOW/MEDIUM/HIGH.
3. **Functional Checks** — what the user wants working:
   - **Programmatic**: specific testable behaviors with exact commands/tests to verify
   - **LLM-as-Judge**: subjective criteria (UI correctness, error message quality, edge cases)
4. **Non-Functional Checks** — quality gates:
   - **Programmatic**: linters, type-checkers, dead code detection, invariant checks, existing tests
   - **LLM-as-Judge**: convention adherence, minimal changes, appropriate error handling
5. **Post-Deployment Validation** — smoke tests, health checks (if applicable)
6. **Acceptance Criteria** — combines all functional + non-functional checks
7. **Out of Scope** / **Technical Constraints** / **Context**

**Guidelines for spec quality:**

- Push for **deterministic, automated validation** wherever possible
- Every check should have a concrete command or test name
- Prefer programmatic checks over LLM-as-judge — use LLM-as-judge only for subjective criteria
- Generate **post-deployment scripts** if the change is deployable
- Risk assessment should drive how thorough the checks need to be

**MANDATORY: Ask user to approve the spec before proceeding.**

Use `AskUserQuestion`:

- Header: "Approve spec"
- Question: "Does this spec look correct?"
- Options: "Approve" / "Edit spec first"

### Step 2: Config Confirmation

Read the user's default kloop config:

```bash
cat ~/.kloop/config.yaml
```

Present it and ask for confirmation. Use `AskUserQuestion`:

- Header: "Config"
- Question: "Using your default kloop config. Proceed or override?"
- Options: "Use defaults" / "Override settings"

If "Override settings" — ask what to change (iterations, timeouts, implementers, reviewers, etc.).

Write the final config to `config.yaml` in the current directory.

### Step 3: Initialize kloop

Write the approved spec to `spec.md` in the current directory, then:

```bash
kloop init --spec ./spec.md --config ./config.yaml
```

Parse the run ID from output (line containing `Run ID:`). Store as `{runId}`.

Clean up temporary files:

```bash
rm -f spec.md config.yaml
```

kloop copies spec and config into its own run directory during init — the local files are no longer needed.

### Step 4: Run kloop

Ask the user how to proceed. Use `AskUserQuestion`:

- Header: "Start"
- Question: "How would you like to start the loop?"
- Options:
  - "Start now (run in background)"
  - "I'll start it myself"

#### If "Start now"

Run as background bash task:

```bash
kloop run -d {runId}
```

Use `run_in_background: true` with Bash tool. When complete, report results:

- **Exit 0 (completed)**: "Run completed! All reviewers approved."
- **Exit 0 (max_iterations)**: "Max iterations reached. Reviewers couldn't reach consensus."
- **Exit 1 (error)**: "Run failed with error."
- **Exit 2 (conflict)**: "Conflict detected — the spec may contain contradictions."
- **Exit 3 (agent_failure)**: "Agent failure — a crash or timeout occurred."

Offer follow-up via `AskUserQuestion`:

- Header: "Next"
- Question: "The loop is done. What would you like to do?"
- Options:
  - "Review changes (git diff)"
  - "Commit the changes"
  - "Run tests"
  - "Start another loop with refined spec"

#### If "I'll start it myself"

Provide the command:

```bash
kloop run -d {runId}
```

Tell the user:

- Check status anytime with: `kloop status {runId}`
- View logs with: `kloop logs {runId}`

## Rules

1. **Spec quality is paramount** — push for deterministic, automated checks
2. **Read user's default config** — don't ask about binaries, use `~/.kloop/config.yaml`
3. **Ask before proceeding** — spec approval, config confirmation, start method
4. **NEVER modify spec after approval**
5. **NEVER commit without asking**
6. **Clean up temp files** after `kloop init`
