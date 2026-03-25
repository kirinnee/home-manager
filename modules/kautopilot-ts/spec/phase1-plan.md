# Phase 1: Plan

## Goal

Take a ticket (or manual request), produce an approved task spec and implementation plans.

## State Machine

> **Phase 0 (init)** — session creation, config, and repo setup are handled by `kautopilot init`. See [cli.md](cli.md#init--phase-0).

```
(v1) ──▶ write_spec
(v2+) ─▶ feedback ──▶ spec_review

write_spec ──▶ spec_review ──┬── pass ──▶ spec_approve ──┬── accept ──▶ write_plans
                            │                           │
                            └── fail ──▶ spec_feedback ─┤── invalid ─▶ spec_approve
                                                         └── valid ──▶ write_spec (loop)

write_plans ──▶ plans_review ──┬── pass ──▶ plans_approve ──┬── accept ──▶ approved
                              │                            │
                              └── fail ──▶ plans_feedback ─┤── invalid ─▶ plans_approve
                                                           └── valid ──▶ write_plans (loop)
```

## Event Log (Source of Truth)

Every state transition appends an event to `~/.kautopilot/{id}/log.jsonl`:

```jsonl
{"ts":"2026-03-23T10:00:00Z","event":"init:started"}
{"ts":"2026-03-23T10:00:15Z","event":"init:completed","id":"a1b2c3d4","ticketId":"PE-1234","local":false}
{"ts":"2026-03-23T10:00:16Z","event":"start:started","phase":"plan"}
{"ts":"2026-03-23T10:01:00Z","event":"write_spec:started","version":1}
{"ts":"2026-03-23T10:05:00Z","event":"write_spec:completed","version":1}
{"ts":"2026-03-23T10:05:01Z","event":"spec_review:started","version":1,"attempt":1}
{"ts":"2026-03-23T10:05:15Z","event":"spec_review:completed","version":1,"attempt":1,"result":"fail","issues":["..."]}
{"ts":"2026-03-23T10:05:20Z","event":"spec_feedback:completed","version":1,"validIssues":["..."],"invalidIssues":["..."]}
{"ts":"2026-03-23T10:06:00Z","event":"write_spec:started","version":1,"attempt":2,"reason":"spec_feedback"}
{"ts":"2026-03-23T10:09:00Z","event":"write_spec:completed","version":1,"attempt":2}
{"ts":"2026-03-23T10:09:01Z","event":"spec_review:started","version":1,"attempt":2}
{"ts":"2026-03-23T10:09:10Z","event":"spec_review:completed","version":1,"attempt":2,"result":"pass"}
{"ts":"2026-03-23T10:09:15Z","event":"spec_approve:completed","version":1,"result":"accepted"}
```

### Why the log, not just state

- **Retry:** On re-run, scan the log. If `write_spec:completed` exists but `spec_review` does not → resume at `spec_review`. If `write_spec:started` exists without `:completed` → that step crashed, retry it.
- **Version detection:** Scan for `phase1:completed` with `version:N`. If v1 fully completed AND `feedback.md` exists → start v2 via `feedback` step. If v1 never completed → resume v1 from last incomplete step.
- **Audit:** Full history of what happened, what decisions were made, how many review loops occurred.
- **Debugging:** When something goes wrong, the log tells exactly where.

### Log-based resume logic

On `kautopilot start` entry:

```
1. Read log.jsonl
2. Find the last event for each step in the current version
3. For each step:
   - If no ":started" event → not yet reached, stop here
   - If ":started" without ":completed" → step crashed, retry it
   - If ":completed" → step is done, move to next
4. Determine version:
   - Find latest "phase1:completed" event → its version is the last completed version
   - If feedback.md exists for that version → next run is v{N+1}, start at `feedback`
   - If no phase1:completed → resume from first incomplete step in current version
```

### Event format

```typescript
interface LogEntry {
  ts: string; // ISO 8601
  event: string; // "{step}:{started|completed|failed}"
  version?: number; // spec version
  attempt?: number; // retry attempt for this step
  result?: string; // completed result: pass/fail/accepted/rejected
  reason?: string; // why this step ran (e.g., "spec_feedback", "user_rejection")
  [key: string]: unknown; // step-specific metadata
}
```

---

## States

> **`setup` and `repo_setup` have been moved to Phase 0 (init).** See [cli.md](cli.md#init--phase-0). The state machine starts at `write_spec` (v1) or `feedback` (v2+).

### `feedback` (v2+ only)

**Execution:** TTY handoff + LLM (non-interactive).

Capture feedback from prior run and create merged spec for next version.

1. Log: `feedback:started`, metadata: `{version: N+1}`
2. Show context: "PR #N is complete. What feedback do you have?"
3. **TTY handoff:** Spawn Claude interactively. Prompt: capture feedback, structure it, write to `spec/{ticketId}/v{N}/feedback.md`
4. On exit, verify `feedback.md` exists
5. **LLM (`--print`):** Merge `v{N}/task-spec.md` + `v{N}/feedback.md` → write `v{N+1}/task-spec.md`
6. Update config: `specVersion`, `specDir` to v{N+1}, clear `subPlans`
7. Execute ticket transition (`ticketTransitions.feedback`) if configured
8. Log: `feedback:completed`, metadata: `{version: N+1}`
9. Transition → `spec_review` (merged spec goes through quality check, same as fresh spec)

**Idempotent:** If `feedback:completed` for v{N+1} in log, skip to `spec_review`.

---

### `write_spec`

**Execution:** TTY handoff.

Research codebase, challenge user, write task spec.

1. Log: `write_spec:started`, metadata: `{version, attempt}`
2. **TTY handoff:** Spawn Claude interactively with prompt that includes:
   - Ticket context (from `ticket.md`)
   - CLAUDE.md files, skills, conventions to read
   - Instructions to research codebase, challenge user, write spec to `{specDir}/task-spec.md`
   - Spec template content
   - **If retry:** previous spec + quality check issues + user feedback
3. On exit, verify `task-spec.md` exists at `{specDir}/`
4. Log: `write_spec:completed`, metadata: `{version, attempt}`
5. Transition → `spec_review`

**Context for Claude:**

- Read `spec/{ticketId}/ticket.md` first
- Read CLAUDE.md files, project conventions
- Challenge the user interactively
- Write spec to the known path when satisfied
- Exit when done

**Idempotent:** If `write_spec:completed` for current version/attempt in log, skip to `spec_review`.

---

### `spec_review`

**Execution:** LLM (non-interactive `--print` mode). Isolated quality check.

Verify the spec meets minimum quality criteria before presenting to user.

1. Log: `spec_review:started`, metadata: `{version, attempt}`
2. Spawn LLM with prompt:
   - The spec from `{specDir}/task-spec.md`
   - Quality criteria: completeness, clarity, testability, no ambiguity, acceptance criteria are specific
   - Ticket context from `ticket.md`
3. Output: structured `{result: "pass"|"fail", issues: string[]}`
4. Log: `spec_review:completed`, metadata: `{version, attempt, result, issues}`
5. If pass → transition to `spec_approve`
6. If fail → transition to `spec_feedback`

**Isolated:** Does not modify any files. Only reads spec and returns verdict.

**Idempotent:** If `spec_review:completed` with `result: pass` in log for this version/attempt, skip to `spec_approve`.

---

### `spec_feedback`

**Execution:** Inquirer (user interaction).

Present quality check issues to user. User decides whether each issue is valid.

1. Present each issue from spec_review (from log or in-memory)
2. For each issue: "Is this a valid concern?"
3. Log: `spec_feedback:completed`, metadata: `{version, validIssues, invalidIssues}`
4. If any valid → transition to `write_spec` (increment attempt, reason: `spec_feedback`)
5. If none valid → transition to `spec_approve`

---

### `spec_approve`

**Execution:** Inquirer (user interaction).

Present the spec to the user for final approval.

1. Read and display `{specDir}/task-spec.md`
2. Prompt: "Does this spec look correct?" (confirm)
3. Log: `spec_approve:completed`, metadata: `{version, result: "accepted"|"rejected"}`
4. If accept → transition to `write_plans`
5. If reject → collect feedback, transition to `write_spec` (increment attempt, reason: `user_rejection`)

---

### `write_plans`

**Execution:** TTY handoff.

Research codebase, write implementation plans.

1. Log: `write_plans:started`, metadata: `{version, attempt}`
2. Discover available Claude binaries: `compgen -c | grep '^claude'`
3. **TTY handoff:** Spawn Claude interactively with prompt that includes:
   - The approved spec from `{specDir}/task-spec.md`
   - Available binaries for config
   - Plan template content
   - Instructions to research codebase, challenge user, write plans to `{specDir}/plans/`
   - **If retry:** previous plans + quality check issues + user feedback
4. On exit, verify plan files exist in `{specDir}/plans/`
5. Update config: `subPlans` array from discovered plan files
6. Log: `write_plans:completed`, metadata: `{version, attempt}`
7. Transition → `plans_review`

**Context for Claude:**

- Read the task spec
- Decide plan count (1-4) based on complexity
- Research codebase per plan area
- Challenge user about boundaries, file conflicts, testing
- Write plan files using the template
- Exit when done

---

### `plans_review`

**Execution:** LLM (non-interactive `--print` mode). Isolated quality check.

Verify plans cover the spec, are consistent, testable, and properly scoped.

1. Log: `plans_review:started`, metadata: `{version, attempt}`
2. Spawn LLM with prompt:
   - The spec from `{specDir}/task-spec.md`
   - All plan files from `{specDir}/plans/`
   - Quality criteria: completeness, consistency, testability, clear scope boundaries
3. Output: structured `{result: "pass"|"fail", issues: string[]}`
4. Log: `plans_review:completed`, metadata: `{version, attempt, result, issues}`
5. If pass → transition to `plans_approve`
6. If fail → transition to `plans_feedback`

---

### `plans_feedback`

**Execution:** Inquirer (user interaction).

Present quality check issues to user. User decides whether each issue is valid.

1. Present each issue from plans_review
2. For each: "Is this a valid concern?"
3. Log: `plans_feedback:completed`, metadata: `{version, validIssues, invalidIssues}`
4. If any valid → transition to `write_plans` (increment attempt, reason: `plans_feedback`)
5. If none valid → transition to `plans_approve`

---

### `plans_approve`

**Execution:** Inquirer (user interaction).

Present plans for final approval.

1. Display all plan files
2. Prompt: "Do these plans cover the task?" (confirm)
3. Log: `plans_approve:completed`, metadata: `{version, result: "accepted"|"rejected"}`
4. If accept → transition to `approved`
5. If reject → collect feedback, transition to `write_plans` (increment attempt, reason: `user_rejection`)

---

### `approved`

**Execution:** Pure TypeScript.

Finalize Phase 1. Single commit for all spec + plan artifacts.

1. Log: `phase1:completed`, metadata: `{version}`
2. Commit all spec artifacts:
   ```bash
   git add spec/{ticketId}/
   git commit -m "docs: add spec and plans for {ticketId} v{N}"
   ```
3. Update config: `runtime.phase` → `implementation`
4. Continue to Phase 2 (or exit if user needs to re-invoke)

---

## Transitions Summary

| From             | To               | Condition                         |
| ---------------- | ---------------- | --------------------------------- |
| `feedback`       | `spec_review`    | Merged spec written               |
| `write_spec`     | `spec_review`    | Spec file written                 |
| `spec_review`    | `spec_approve`   | Quality check passes              |
| `spec_review`    | `spec_feedback`  | Quality check fails               |
| `spec_feedback`  | `write_spec`     | User says issues are valid        |
| `spec_feedback`  | `spec_approve`   | User says issues are invalid      |
| `spec_approve`   | `write_plans`    | User accepts                      |
| `spec_approve`   | `write_spec`     | User rejects (loop with feedback) |
| `write_plans`    | `plans_review`   | Plan files written                |
| `plans_review`   | `plans_approve`  | Quality check passes              |
| `plans_review`   | `plans_feedback` | Quality check fails               |
| `plans_feedback` | `write_plans`    | User says issues are valid        |
| `plans_feedback` | `plans_approve`  | User says issues are invalid      |
| `plans_approve`  | `approved`       | User accepts                      |
| `plans_approve`  | `write_plans`    | User rejects (loop with feedback) |

## Execution Mode Summary

| State            | Mode              | LLM?              | Why                                         |
| ---------------- | ----------------- | ----------------- | ------------------------------------------- |
| `feedback`       | TTY handoff + LLM | Yes (both)        | Capture feedback interactively, merge specs |
| `write_spec`     | TTY handoff       | Yes (interactive) | Research + challenge user + write           |
| `spec_review`    | LLM (`--print`)   | Yes               | Isolated quality check                      |
| `spec_feedback`  | Inquirer          | No                | User decides on issues                      |
| `spec_approve`   | Inquirer          | No                | User confirms spec                          |
| `write_plans`    | TTY handoff       | Yes (interactive) | Research + challenge + write                |
| `plans_review`   | LLM (`--print`)   | Yes               | Isolated quality check                      |
| `plans_feedback` | Inquirer          | No                | User decides on issues                      |
| `plans_approve`  | Inquirer          | No                | User confirms plans                         |
| `approved`       | Pure TS           | No                | Commit, update state, exit                  |
