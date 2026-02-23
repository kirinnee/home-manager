# Phase: Polling

This phase monitors CI and reviews, then evaluates the outcome to decide the next action.

## Start Poller

Run `dev-loop poll-pr` as a **background Bash task** and block with TaskOutput:

```bash
dev-loop poll-pr <prNumber>
```

Use `run_in_background: true` with Bash tool, then wait with TaskOutput. This costs zero tokens — it polls `gh` CLI + GraphQL API.

**IMPORTANT:** Always remind the user of the PR URL when polling:

```
Polling PR #{prNumber}: https://github.com/{owner}/{repo}/pull/{prNumber}
```

Update state: `phase: "polling"`

## Evaluate Result

When the poller exits, check the exit code. **Always include the PR URL in your status update:**

```
PR #{prNumber}: https://github.com/{owner}/{repo}/pull/{prNumber}
```

| Exit | Meaning                                                                 | Action                                           |
| ---- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| 0    | Ready to merge (CI pass, reviews OK, no conflicts, conversations clear) | **Completed**                                    |
| 1    | CI failed                                                               | Fix from CI logs → retry                         |
| 2    | Changes requested                                                       | Fix from review comments → retry                 |
| 4    | Merge conflict or branch behind                                         | Auto-rebase → retry push via `phases/pushing.md` |
| 5    | Unresolved conversations blocking merge                                 | Fix from thread details → retry                  |
| 6    | PR is closed or merged                                                  | **Failed**                                       |

**Before retrying (exits 1, 2, 5):** Check `pushCycle >= maxPushCycles`. If so, transition to **Failed** instead.

## Fetch All PR Comments

**IMPORTANT:** Before processing any feedback, always fetch ALL PR comments to get complete context:

```bash
# Get all review comments (inline code comments)
gh api repos/{owner}/{repo}/pulls/{prNumber}/comments --jq '.[] | {id, path, line, body, user: .user.login, created_at}'

# Get all issue comments (general PR comments)
gh api repos/{owner}/{repo}/issues/{prNumber}/comments --jq '.[] | {id, body, user: .user.login, created_at}'

# Get all review threads (for conversation resolution status)
gh api repos/{owner}/{repo}/pulls/{prNumber}/reviews --jq '.[] | {id, user: .user.login, state, body}'
```

Consider ALL comments from ALL sources when evaluating what needs to be addressed, not just the poller output.

## CodeRabbitAI Handling

When exit 2 (changes requested) or exit 5 (conversations blocking) involves comments from `@coderabbitai`:

1. **Evaluate each comment critically** — do NOT blindly follow. Ask yourself: is this comment valid? Does it apply to the actual code? Is the suggestion correct?
2. **For invalid comments:** Reply directly to that PR conversation thread explaining why the comment is not applicable or incorrect. This dismisses the concern and helps resolve the thread.
3. **For valid comments only:** Include them in fixes. Ignore invalid ones.

### Replying to PR Comments

When replying to any PR comment (inline or general), **always** include a signature:

```
By Claude Code Kagent Autopilot 🤖
```

Example inline comment reply:

```bash
gh api repos/{owner}/{repo}/pulls/comments/{commentId}/replies -f body="Your response here.

By Claude Code Kagent Autopilot 🤖"
```

After pushing fixes that address coderabbitai feedback (in the pushing phase), a PR comment will be posted to trigger re-review — see `phases/pushing.md`.

## Retry: Autopilot Mode (`mode: "autopilot"`)

For exits 1, 2, 5 with cycles remaining:

Generate a fix spec from the feedback and run dev-loop again.

**Next:** Read `phases/run-spec.md` and follow it.

## Retry: Manual Mode (`mode: "manual"`)

For exits 1, 2, 5 with cycles remaining:

Fix the issues **directly** — no dev-loop, no spec files. Instead:

1. **Gather feedback** from the appropriate source:
   - **CI failures (exit 1):** `gh pr checks {prNumber}` for failed check names, then `gh run list --branch {branch} --status failure --limit 1 --json databaseId -q '.[0].databaseId'` and `gh run view {runId} --log-failed`
   - **Review comments (exit 2):** `gh api repos/{owner}/{repo}/pulls/{prNumber}/comments` (inline) + `gh pr view {prNumber} --json reviews` (top-level)
   - **Conversations (exit 5):** Poller output includes thread details JSON with path, line, author, body
2. **Read the relevant source files** to understand the code around each issue
3. **Fix the code directly** using Edit/Write tools — apply the same critical judgment as you would in any coding task
4. **Do NOT generate spec files or run dev-loop** — you are the implementer

**Next:** Read `phases/pushing.md` and follow it (to commit and push the fixes).

## Completed (Exit 0)

```
Task Complete!
  Ticket: {ticketId}
  PR: #{prNumber} - [{ticketId}] {ticketTitle}
  URL: https://github.com/{owner}/{repo}/pull/{prNumber}
  Push cycles used: {pushCycle}/{maxPushCycles}

  To merge: gh pr merge {prNumber}
```

Include ticket info when available. If `ticketId` is null, omit it from the report.

Update state: `phase: "completed"`

## Failed (Max Cycles or Error)

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

If resuming into this phase: restart `dev-loop poll-pr` with stored `prNumber`.

## Next

- Exit 0: Done. Report success.
- Exit 1/2/5 (autopilot, with cycles): Read `phases/run-spec.md` and follow it.
- Exit 1/2/5 (manual, with cycles): Fix directly, then read `phases/pushing.md`.
- Exit 4: Read `phases/pushing.md` and follow it (for auto-rebase + push).
