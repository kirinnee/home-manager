# State Agent — Resume + State Management (Team Member)

**Agent Mode:** Spawned as state-agent. Operates in one of two modes based on prompt.

## Mode 1: Resume Assessment

When prompted: "Read state, inspect repo, tell me what to do next"

### Agent Context

- Working directory: {WORKDIR}
- State JSON: {STATE_JSON} (provided in prompt)

### Agent Report Format (Resume)

```
PHASE: <current phase from state>
LAST_COMPLETED_ACTION: <what was last successfully done>
NEXT_STEP: <what should happen next>
CLEANUP_NEEDED: <any cleanup required before proceeding>
```

### Per-Phase Checks

Read `.kagent/task-state.json` (or use the state JSON provided), then inspect the repo:

| Phase          | What to Check                                                                                                             | Next Step                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| No state file  | N/A                                                                                                                       | Spawn setup-agent                                                                   |
| `repo_setup`   | Is `repoConfig` populated (non-empty object)? Is `ticketId` set?                                                          | Re-run repo-setup if incomplete                                                     |
| `planning`     | Does `{specDir}/task-spec.md` exist?                                                                                      | If no spec: orchestrator starts planning. If spec exists: present for approval      |
| `approved`     | Does spec exist?                                                                                                          | Orchestrator starts sub-planning                                                    |
| `sub_planning` | Do plan files exist in `{specDir}/plans/`?                                                                                | If no plans: orchestrator starts sub-planning. If plans exist: present for approval |
| `run_spec`     | Does `.kagent/spec.md` exist? Is `devLoopInitialized` true?                                                               | Re-dispatch to run-spec agent                                                       |
| `running`      | Is dev-loop running? Check `.kagent/current/` for active run. Check `.kagent/history/` for results.                       | Exit 0 → prereview, exit 1/2 → error/conflict, no result → re-run                   |
| `prereview`    | Does `review.md` exist in working dir? Were fixes committed?                                                              | If review.md exists: resume processing. If no review.md: start fresh prereview      |
| `pushing`      | Was latest commit pushed? (`git log origin/{branch}..HEAD`). Does PR exist? (`gh pr view`). Is stale `review.md` present? | Delete review.md if present. If pushed+PR → polling, else re-push                   |
| `polling`      | PR CI status? Review status? Is PR still open?                                                                            | Re-spawn poller                                                                     |
| `completed`    | Is PR merged?                                                                                                             | Report done, offer feedback loop                                                    |
| `failed`       | What was `lastError`?                                                                                                     | Report error, offer retry from appropriate phase                                    |
| `feedback`     | Does `spec/{ticketId}/v{N}/feedback.md` exist?                                                                            | If exists: create new spec version. If not: capture feedback                        |

### Git/PR Status Checks

```bash
# Branch status
git status --short
git log origin/{branch}..HEAD --oneline 2>/dev/null || echo "no remote tracking"

# PR status (if prNumber set)
gh pr view {prNumber} --json state,mergeable,mergeStateStatus,reviewDecision 2>/dev/null

# Dev-loop state
ls .kagent/current/ 2>/dev/null
ls -t .kagent/history/ 2>/dev/null | head -3

# Stale files
ls review.md 2>/dev/null
```

## Mode 2: State Change

When prompted: "Update these fields: {field: value, ...}"

### Agent Context

- Working directory: {WORKDIR}
- Updates: {UPDATES_JSON} (provided in prompt)

### Agent Report Format (State Change)

```
RESULT: <updated|error>
FIELDS_UPDATED: <list of fields changed>
NEW_PHASE: <phase value if changed, or unchanged>
ERROR: <error message if any>
```

### Procedure

1. Read `.kagent/task-state.json`
2. Apply each field update from {UPDATES_JSON}
3. Write back to `.kagent/task-state.json`
4. Report what was changed

### Validation Rules

- `phase` must be one of: `repo_setup`, `planning`, `approved`, `sub_planning`, `run_spec`, `running`, `prereview`, `pushing`, `polling`, `feedback`, `completed`, `failed`
- `pushCycle` must be >= 0
- `specVersion` must be >= 1 when set
- `subPlans` must be an array (never null) — minimum 1 entry when populated
- `currentSubPlanIndex` must be within `subPlans` bounds

## Resumability

This agent is stateless — it reads state, performs its task, and reports back. No special resume logic needed.
