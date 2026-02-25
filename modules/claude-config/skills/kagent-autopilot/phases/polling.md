# Phase: Polling

This phase waits for CI/reviews, then dispatches based on result.

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
