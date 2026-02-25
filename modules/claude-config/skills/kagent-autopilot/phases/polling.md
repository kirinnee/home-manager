# Phase: Polling

This phase waits for CI/reviews, then dispatches based on result.

**Agent Mode:** When spawned as a polling agent, execute this phase and report findings back to orchestrator. Do NOT update `.kagent/task-state.json`. Do NOT make code changes.

## Step 1: Start Poller

**CRITICAL: ALWAYS use `dev-loop poll-pr`. NEVER use `gh pr watch` or any other command.**

Run as a **background Bash task** and wait:

```bash
dev-loop poll-pr <prNumber>
```

Use `run_in_background: true` with Bash tool, then block with TaskOutput. This costs zero tokens.

**IMPORTANT:** Announce the PR URL:

```
Polling PR #{prNumber}: https://github.com/{owner}/{repo}/pull/{prNumber}
```

Update state: `phase: "polling"`

## Step 2: Handle Exit Code

When poller exits, check the code. **Always include the PR URL in updates.**

| Exit | Meaning                                                                 | Action                              |
| ---- | ----------------------------------------------------------------------- | ----------------------------------- |
| 0    | Ready to merge (CI pass, reviews OK, no conflicts, conversations clear) | **Completed**                       |
| 1    | CI failed                                                               | Enrich → Fix                        |
| 2    | Changes requested                                                       | Enrich → Fix                        |
| 4    | Merge conflict or branch behind                                         | Auto-rebase via `phases/pushing.md` |
| 5    | Unresolved conversations blocking merge                                 | Enrich → Fix                        |
| 6    | PR is closed or merged                                                  | **Failed**                          |

**Before any retry (exits 1, 2, 5):** Check `pushCycle >= maxPushCycles`. If so, go to **Failed**.

## Exit 0: Completed

**Move ticket to "Review" status:**

**Jira (`ticketSystem: "jira"`):**

```bash
acli jira workitem transition {ticketId} --transition "Review"
```

**ClickUp (`ticketSystem: "clickup"`):**
Use ClickUp MCP to update task status to "review".

Skip if `ticketId` is null. Adapt status names to your workspace.

Report success:

```
Task Complete!
  Ticket: {ticketId}
  PR: #{prNumber} - [{ticketId}] {ticketTitle}
  Link: https://github.com/{owner}/{repo}/pull/{prNumber}
  Push cycles used: {pushCycle}/{maxPushCycles}

  To merge: gh pr merge {prNumber}
```

Update state: `phase: "completed"`

## Exit 4: Rebase Required

Read `phases/pushing.md` and follow it (auto-rebase + push).

## Exits 1, 2, 5: Need Fixes

**Next:** Read `phases/polling-enrich.md` and follow it.

## Failed (Exit 6 or Max Cycles)

```
Max push cycles reached ({pushCycle}/{maxPushCycles})
  Ticket: {ticketId}
  PR: #{prNumber}
  URL: https://github.com/{owner}/{repo}/pull/{prNumber}

  Remaining issues:
  - {issue details from poller output}

  Please take over manually.
```

Update state: `phase: "failed"`, store `lastError`

## Resumability

If resuming: restart `dev-loop poll-pr` with stored `prNumber`.

## Agent Report Format

When running as an agent, report back to orchestrator with:

```
EXIT_CODE: <0|1|2|4|5|6>
STATUS: <completed|needs_fix|rebase|failed>

CI_STATUS: <passing|failing|pending>
REVIEW_STATUS: <approved|changes_requested|pending|blocked>

ISSUES:
- <CI error or review comment 1>
- <CI error or review comment 2>

ACTION: <none|enrich_and_fix|rebase|manual_takeover>

PR_URL: https://github.com/{owner}/{repo}/pull/{prNumber}
```

**Important for agents:**

- Do NOT make code changes — just report what needs to be fixed
- Do NOT update ticket status — orchestrator handles that
- Include all actionable feedback in your ISSUES list
