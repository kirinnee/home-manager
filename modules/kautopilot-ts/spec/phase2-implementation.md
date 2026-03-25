# Phase 2: Implementation

## Goal

Execute each sub-plan through dev-loop. For each plan: prepare spec, run dev-loop, handle conflicts/iterations, commit.

## State Machine

```
Per sub-plan (loop over subPlans):
  clear_loop → setup_run → running ──┬── exit 0 (completed) ──▶ commit ──▶ next_plan
                                     │
                                     ├── exit 0 (max_iterations) ──▶ resolve ──▶ rewrite_spec ──▶ running (loop)
                                     │
                                     ├── exit 2 (conflict) ──▶ resolve ──▶ rewrite_spec ──▶ running (loop)
                                     │
                                     └── exit 1 (error) ──▶ failed

next_plan ──┬── more plans ──▶ clear_loop
            └── all done ──▶ completed ──▶ Phase 3
```

## Event Log

Same `log.jsonl` from Phase 1, appending Phase 2 events. **All events include `version`.**

```jsonl
{"ts":"...","event":"phase2:started","version":1}
{"ts":"...","event":"clear_loop:started","version":1,"plan":"plan-1"}
{"ts":"...","event":"clear_loop:completed","version":1,"plan":"plan-1"}
{"ts":"...","event":"setup_run:started","version":1,"plan":"plan-1"}
{"ts":"...","event":"setup_run:completed","version":1,"plan":"plan-1"}
{"ts":"...","event":"running:started","version":1,"plan":"plan-1","attempt":1}
{"ts":"...","event":"running:completed","version":1,"plan":"plan-1","attempt":1,"exitCode":0,"status":"completed","runId":"run-abc123"}
{"ts":"...","event":"commit:started","version":1,"plan":"plan-1"}
{"ts":"...","event":"commit:completed","version":1,"plan":"plan-1","commitSha":"abc1234","commitMessage":"feat(auth): plan-1 add JWT validation"}
{"ts":"...","event":"next_plan","version":1,"from":"plan-1","to":"plan-2"}
```

### Resume logic

On re-run into Phase 2:

1. Scan log for `phase2:started` for current version
2. Find the last `commit:completed` or `next_plan` event → that plan is done
3. If `running:started` without `running:completed` → run may still be active, check
4. If `resolve:started` or `rewrite_spec:started` without `:completed` → retry from there
5. If all plans have `commit:completed` → skip to `completed`

---

## States

### `clear_loop`

**Execution:** Pure TypeScript.

Clean up dev-loop state from the previous run.

1. Log: `clear_loop:started`, metadata: `{version, plan}`
2. Check if a run is active: `dev-loop status 2>&1 || true`
3. If active: `dev-loop cancel`
4. Log: `clear_loop:completed`, metadata: `{version, plan, runWasActive}`
5. Transition → `setup_run`

**Idempotent:** Always safe to run. If nothing to clean, it's a no-op.

---

### `setup_run`

**Execution:** Pure TypeScript + subprocess.

Copy current plan to implementation working spec and initialize (first run only).

**First run** (no prior run for this plan):

1. Log: `setup_run:started`, metadata: `{version, plan, firstRun: true}`
2. Copy plan to dev-loop working spec
3. Initialize dev-loop with settings from config
4. Ticket transition: if configured, execute `ticketTransitions.start`
5. Log: `setup_run:completed`, metadata: `{version, plan}`
6. Transition → `running`

**Subsequent runs** (next sub-plan, already initialized):

1. Log: `setup_run:started`, metadata: `{version, plan, firstRun: false}`
2. Copy plan to dev-loop working spec
3. Log: `setup_run:completed`, metadata: `{version, plan}`
4. Transition → `running`

**After rewrite-spec** (re-entering from resolve loop):

- Skip entirely, go directly to `running` (spec already rewritten)

**Idempotent:** If `setup_run:completed` for current plan/version in log, skip to `running`.

---

### `running`

**Execution:** Pure TypeScript + subprocess.

Execute dev-loop and capture the result.

1. Log: `running:started`, metadata: `{version, plan, attempt}`
2. Run dev-loop and capture the result
3. Capture exit code
4. Determine status:
   - Exit 0, status `completed` → all reviewers approved
   - Exit 0, status `max_iterations` → consensus not reached
   - Exit 1 → runtime error
   - Exit 2 → spec conflict
   - Exit 3 → agent failure (crash/timeout)
5. Log: `running:completed`, metadata: `{version, plan, attempt, exitCode, status, runId}`
6. Transition based on exit code:
   - Exit 0, `completed` → `commit`
   - Exit 0, `max_iterations` → `resolve`
   - Exit 2 → `resolve`
   - Exit 1 → `failed`
   - Exit 3 → `failed`

**Idempotent:** If `running:completed` for current plan/attempt/version in log, skip to the transition target.

---

### `resolve`

**Execution:** TTY handoff.

Analyze why dev-loop failed and work with the user to decide how to proceed.

1. Log: `resolve:started`, metadata: `{version, plan, attempt, reason}`

**For conflict (exit 2):**

- Read conflict context: conflict analysis, reviewer feedback, the spec that caused the conflict, original task spec

**For max iterations (exit 0, max_iterations):**

- Read iteration context: reviewer feedback, the spec, original task spec

**TTY handoff:** Spawn Claude interactively with all context. Prompt:

- Present the conflict or iteration failure to the user
- Show relevant reviewer feedback
- Discuss resolution options with the user
- When resolved, write the user's chosen approach to a temp file
- Exit when done

3. On exit, read the temp file for user's chosen resolution
4. Log: `resolve:completed`, metadata: `{version, plan, attempt, reason, resolution}`
5. Transition → `rewrite_spec`

**Idempotent:** If `resolve:completed` for current plan/attempt/version in log, skip to `rewrite_spec`.

---

### `rewrite_spec`

**Execution:** LLM (`--print` mode).

Rewrite the dev-loop working spec to resolve the conflict or address reviewer feedback.

1. Log: `rewrite_spec:started`, metadata: `{version, plan, attempt, reason}`
2. Spawn LLM with:
   - The conflict context or iteration feedback
   - User's chosen resolution (from resolve step)
   - The current working spec
   - `{specDir}/task-spec.md` for full context
   - Instructions: rewrite the spec to be clear, unambiguous, and actionable
3. LLM writes the new working spec
4. Log: `rewrite_spec:completed`, metadata: `{version, plan, attempt, changesSummary}`
5. Transition → `running` (increment attempt)

**Idempotent:** If `rewrite_spec:completed` for current plan/attempt/version in log, skip to `running`.

---

### `commit`

**Execution:** LLM (`--print` mode) + subprocess.

Commit the current sub-plan's changes with proper conventions.

1. Log: `commit:started`, metadata: `{version, plan}`
2. **LLM (`--print`):** Detect commit conventions:
   - Read `CommitConventions.md`, `CONTRIBUTING.md`, `.commitlintrc*`, etc.
   - Read `git log --oneline -10` for recent patterns
   - Generate commit message following detected convention
   - Include ticket ID, plan number, plan title, rationale
3. Stage specific changed files (never `git add -A`):
   ```bash
   git add <specific files from diff>
   ```
4. Commit with generated message, capture SHA
5. Log: `commit:completed`, metadata: `{version, plan, commitSha, commitMessage}`
6. Transition → `next_plan`

**Idempotent:** If `commit:completed` for current plan/version in log, skip to `next_plan`.

---

### `next_plan`

**Execution:** Pure TypeScript.

Advance to the next sub-plan or complete the phase.

1. Increment `currentSubPlanIndex` in config
2. Log: `next_plan`, metadata: `{version, from: "plan-N", to: "plan-M"}`
3. If more plans → transition to `clear_loop`
4. If all plans done → transition to `completed`

**Idempotent:** If `next_plan` event for current plan/version in log, skip to `clear_loop` or `completed`.

---

### `completed`

**Execution:** Pure TypeScript.

Finalize Phase 2 and prepare for Phase 3.

1. Log: `phase2:completed`, metadata: `{version, plansCompleted}`
2. Update config: `runtime.phase` → `polish`
3. Continue to Phase 3

---

### `failed`

**Execution:** Pure TypeScript.

Handle dev-loop error (exit 1 or exit 3).

1. Log: `phase2:failed`, metadata: `{version, plan, attempt, exitCode, status, error}`
2. Update config: `runtime.phase` → `failed`
3. Present error to user with option to retry from current plan or abort

---

## Transitions Summary

| From           | To             | Condition                                      |
| -------------- | -------------- | ---------------------------------------------- |
| `clear_loop`   | `setup_run`    | Always                                         |
| `setup_run`    | `running`      | Spec copied, dev-loop initialized              |
| `running`      | `commit`       | Exit 0, status: completed                      |
| `running`      | `resolve`      | Exit 2 (conflict) or exit 0 max_iterations     |
| `running`      | `failed`       | Exit 1 (error) or exit 3 (agent failure)       |
| `resolve`      | `rewrite_spec` | User chose resolution via TTY handoff          |
| `rewrite_spec` | `running`      | Spec rewritten (loop with incremented attempt) |
| `commit`       | `next_plan`    | Changes committed                              |
| `next_plan`    | `clear_loop`   | More plans remaining                           |
| `next_plan`    | `completed`    | All plans done                                 |
| `completed`    | Phase 3        | —                                              |
| `failed`       | user choice    | Retry or abort                                 |

## Execution Mode Summary

| State          | Mode                 | LLM?              | Why                                   |
| -------------- | -------------------- | ----------------- | ------------------------------------- |
| `clear_loop`   | Pure TS              | No                | Git + file cleanup                    |
| `setup_run`    | Pure TS + subprocess | No                | Copy file, run `dev-loop init`        |
| `running`      | Pure TS + subprocess | No                | Run `dev-loop run`, capture exit code |
| `resolve`      | TTY handoff          | Yes (interactive) | Discuss conflict/failure with user    |
| `rewrite_spec` | LLM (`--print`)      | Yes               | Rewrite spec with resolution          |
| `commit`       | LLM + subprocess     | Yes (`--print`)   | Detect conventions, generate message  |
| `next_plan`    | Pure TS              | No                | Increment index                       |
| `completed`    | Pure TS              | No                | Update state                          |
| `failed`       | Pure TS              | No                | Update state, present error           |

## Notes

- **Phase 2 is mostly deterministic.** Only `resolve`, `rewrite_spec`, and `commit` need LLM. The main loop (clear → setup → run → commit → next) is pure TypeScript + subprocess calls.
- **`resolve` is a TTY handoff** — the user discusses the conflict/failure interactively with Claude. When Claude exits, kautopilot reads the resolution decision from a file and proceeds to rewrite_spec.
- **`commit` uses LLM for convention detection** but could be pure TS if we simplify (regex-based convention detection or just use a default format). Marked as LLM for now to match current behavior.
- **The resolve → rewrite_spec → running loop** is bounded by `maxIterations`. In practice, most plans pass on the first attempt.
- **Ticket transition** happens once per spec version (first `setup_run`), not per plan.
