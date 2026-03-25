# Phase 3: Polish

## Goal

Push code, create PR, poll until mergeable, fix issues in a loop, hand off to user.

## Big Picture

**Part A — Ship it** (runs once):

```
commit_pending → prereview → push → create_pr
```

**Part B — Fix loop** (runs until mergeable, bounded by `maxPushCycles`):

```
poll ──▶ eval ──▶ act ──▶ [TTY?] ──▶ fix ──▶ push ──▶ poll
  ▲                                                    │
  └────────────────────────────────────────────────────┘
```

**Terminal states:**

```
poll says mergeable  → feedback_check → completed
poll says blocked    → fix loop (above)
user has feedback    → Phase 1 (v{N+1})
```

---

## Part A: Ship It

Runs once. Get code committed, pre-reviewed, pushed, and PR created.

### `commit_pending`

**Execution:** LLM (`--print` mode) + subprocess.

Stage and commit any uncommitted changes.

1. Log: `commit_pending:started`, metadata: `{version}`
2. Check for changes: `git status --short`
3. If no changes → log completed with `result: no_changes`, transition → `prereview`
4. **LLM (`--print`):** Detect commit conventions, generate message
5. Stage specific changed files (never `git add -A`)
6. Commit with ticket ID and convention
7. Log: `commit_pending:completed`, metadata: `{version, commitSha, commitMessage}`
8. Transition → `prereview`

---

### `prereview`

**Execution:** LLM (`--print` mode) + subprocess. Skip if `prereviewEnabled` is false.

Run CodeRabbit local review before pushing.

1. Log: `prereview:started`, metadata: `{version}`
2. If `prereviewEnabled` is false → skip, transition → `push`
3. Run `coderabbit review --plain --base {baseBranch} > rb-review.md 2>&1`
4. If coderabbit not installed or fails → skip
5. **LLM (`--print`):** Process findings (true positive → fix, false positive → comment, wrong → ignore)
6. If fixes applied → commit: `fix: address coderabbit local review findings`
7. Cleanup: `rm -f rb-review.md`
8. Log: `prereview:completed`, metadata: `{version, result, fixesApplied, commitSha}`
9. Transition → `push`

---

### `push`

**Execution:** Pure TypeScript + subprocess.

1. Log: `push:started`, metadata: `{version, pushCycle}`
2. Safety check: verify not on main/master
3. **First push:** `git push -u origin HEAD`
4. **Retry:** `git pull --ff-only` → retry, then `git pull --rebase` → retry, then fail
5. **Subsequent:** `git push`
6. **Force push:** never, except `--force-with-lease` after rebase
7. Execute post-push actions from previous cycle (substitute `{commit_sha}`, post replies)
8. Log: `push:completed`, metadata: `{version, pushCycle, commitSha}`
9. Transition → `create_pr` (first push) or `poll` (subsequent)

---

### `create_pr`

**Execution:** Pure TypeScript + subprocess.

1. Log: `create_pr:started`, metadata: `{version}`
2. Check for existing PR: `gh pr list --head "$(git branch --show-current)" --json number,url -q '.[0]'`
3. If exists → set `prNumber`, transition → `poll`
4. Create PR using template: `gh pr create --title "[{ticketId}] {title}" --base {baseBranch} --body "$(cat pr-template)"`
5. Fetch merge policy (see below)
6. Set `prNumber` in config
7. Log: `create_pr:completed`, metadata: `{version, prNumber, prUrl, result: created|exists}`
8. Transition → `poll`

#### Fetch Merge Policy (pure TS, runs at create_pr)

```bash
gh api graphql -f query='
  query {
    repository(owner: "$OWNER", name: "$REPO") {
      branchProtectionRules(first: 10) {
        nodes {
          pattern
          requiredStatusChecks { contexts strict }
          requiredPullRequestReviews { requiredApprovingReviewCount dismissStaleReviews requireCodeOwnerReviews }
          requiredConversationResolution
          requiredSignatures
          requiredLinearHistory
          allowForcePushes
        }
      }
    }
  }'
```

Store as `MergePolicy` in config — used by every poll cycle to know what's actually required.

```typescript
interface MergePolicy {
  requiredChecks: string[]; // CI checks that must pass
  strict: boolean; // must be up-to-date with base
  requiredApprovals: number; // human approvals needed
  requireConversationResolution: boolean;
  requireCodeOwnerReviews: boolean;
  requireLinearHistory: boolean;
  allowForcePushes: boolean;
}
```

---

## Part B: Fix Loop

### POLL — Three States (Pure TypeScript)

Gather all PR signals and determine one of three states.

#### Gather (parallel API calls)

```typescript
const [checks, mergeStatus, threads, reviews, crCheck] = await Promise.all([
  // All CI checks with status + conclusion
  gh(`pr checks {prNumber} --json name,status,conclusion`),
  // Merge status
  gh(`pr view {prNumber} --json mergeable,mergeStateStatus,headRefName,state`),
  // All unresolved review threads
  ghApiGraphQL(`reviewThreads(resolved: false)`),
  // All reviews (to count approvals)
  gh(`api repos/{owner}/{repo}/pulls/{prNumber}/reviews`),
  // CodeRabbit CI check status
  gh(`pr checks {prNumber} --json name,status,conclusion`).then(checks => checks.find(c => /coderabbit/i.test(c.name))),
]);
```

For failing CI checks, fetch logs in parallel:

```typescript
await Promise.all(failingChecks.map(c => gh(`run view ${c.runId} --log-failed`)));
```

#### Compute state

```typescript
type PollState = 'mergeable' | 'blocked' | 'pending';

function computePollState(signals, policy: MergePolicy): PollState {
  const pr = signals.mergeStatus;

  // PR closed or merged
  if (pr.state === 'MERGED') return 'mergeable';
  if (pr.state === 'CLOSED') return 'blocked';

  // Draft PR
  if (pr.mergeStateStatus === 'DRAFT') return 'pending';

  // Branch behind or conflicting — needs git fix first
  if (pr.mergeStateStatus === 'BEHIND' || pr.mergeStateStatus === 'DIRTY') return 'blocked';

  // CI still running?
  const incomplete = checks.filter(c => c.status !== 'completed');
  if (incomplete.length > 0) return 'pending';

  // CR still running?
  if (crCheck && crCheck.status !== 'completed') return 'pending';

  // Merge queue / hooks in progress
  if (pr.mergeStateStatus === 'HAS_HOOKS') return 'pending';

  // Check required CI (only required ones matter)
  const requiredFailing = checks
    .filter(c => c.status === 'completed' && c.conclusion === 'failure')
    .filter(c => policy.requiredChecks.includes(c.checkName));
  if (requiredFailing.length > 0) return 'blocked';

  // Check approvals (humans only, ignore bots)
  const humanApproved = reviews.filter(r => r.state === 'APPROVED' && !r.user.login.includes('[bot]'));
  const humanBlocked = reviews.some(r => r.state === 'CHANGES_REQUESTED' && !r.user.login.includes('[bot]'));
  if (humanBlocked) return 'blocked';
  if (humanApproved.length < policy.requiredApprovals) return 'pending';

  // Check required conversation resolution
  if (policy.requireConversationResolution && unresolvedThreads.length > 0) return 'blocked';

  // Check mergeability
  if (pr.mergeable === false) return 'blocked';

  return 'mergeable';
}
```

**Key behaviors:**

- `pending` → don't do anything, just wait and poll again. Something is still running.
- `blocked` → something concrete to fix. Enter eval → act → fix cycle.
- `mergeable` → done. Present to user.

#### What POLL outputs

```typescript
interface PollResult {
  state: PollState;

  // Only populated when blocked
  rebaseNeeded: boolean;
  conflict: boolean;
  ciFailures: { checkName: string; log: string }[];
  reviewThreads: Thread[]; // unresolved threads (any author)
  prComments: PRComment[]; // top-level PR comments since last commit

  // Stats (for all states, used in summary)
  approvalsCount: number;
  requiredApprovals: number;
}
```

#### Gather PR comments (new since last commit)

Top-level PR comments (not review thread comments) posted since the last push commit:

```typescript
const sinceSha = lastPushSha; // from config/status
const prComments = await gh(`api repos/{owner}/{repo}/pulls/{prNumber}/comments?since=${sinceSha}`);
```

These are standalone comments on the PR — not part of review threads. They can contain feedback, questions, or requests that need evaluation.

#### Transitions from POLL:

- `state === 'mergeable'` → `feedback_check`
- `state === 'pending'` → wait, then poll again
- `state === 'blocked'` → `ensure_branch` (first: fix git state before anything else)

---

### ENSURE_BRANCH — Fix Git State (Pure TS + TTY handoff)

Before evaluating anything, make sure the branch is clean. No point analyzing threads if the branch is behind or conflicting.

```typescript
if (pollResult.rebaseNeeded) {
  await exec('git pull --rebase origin {baseBranch}');
  await exec('git push --force-with-lease');
  // Branch fixed → back to poll (signals may have changed)
  return;
}

if (pollResult.conflict) {
  // 1. Merge main into branch
  await exec('git merge origin/{baseBranch}');
  // 2. If merge has conflicts → TTY handoff
  //    LLM gets: spec + history + conflict markers + file contents
  //    User + LLM resolve conflicts together
  // 3. After resolved: commit merge, push
  await exec('git push');
  // Branch fixed → back to poll
  return;
}
```

**TTY handoff for conflicts:** spawn Claude interactively with:

- The spec (`spec/{ticketId}/v{N}/task-spec.md`)
- The history (all prior plan descriptions and feedback)
- The conflict markers (`git diff --name-only --diff-filter=U`)
- Instructions to resolve each conflict with context from spec+history

After Claude exits, verify all conflicts resolved, commit, push.

---

### EVAL — Fan-out Judgment (Pure TS pre-filter + LLM `--print`, parallel)

**Context for every eval call:** each sub-agent receives:

- The task spec (`spec/{ticketId}/v{N}/task-spec.md`)
- The plan files (`spec/{ticketId}/v{N}/plans/*.md`)
- Feedback history (if v2+)
- The specific unit to evaluate (one thread, one CI log, one PR comment)

This context lets the LLM judge accurately — it knows what the code is supposed to do, what was intentional, what was already considered.

#### Step 1: Deterministic pre-filter (Pure TypeScript)

Before fan-out, filter out threads that can be handled without LLM:

```typescript
function preFilterThreads(
  threads: Thread[],
  crCiStatus: string,
): {
  closed: Array<{ threadId: string; commentId: string; body: string; reason: string }>;
  toEval: Thread[];
} {
  const closed = [];
  const toEval = [];

  for (const thread of threads) {
    // OUTDATED — code has changed, thread is stale
    if (thread.isOutdated) {
      closed.push({
        threadId: thread.id,
        commentId: lastCommentId(thread),
        body: 'This thread is outdated (code has changed). Resolving as no longer applicable.\n\nBy Claude Code Kautopilot',
        reason: 'outdated',
      });
      continue;
    }

    // GHOSTED — we replied, CR CI is done, CR never responded
    const lastByUs = lastCommentAuthor(thread) === 'us';
    if (lastByUs && crCiStatus === 'completed') {
      closed.push({
        threadId: thread.id,
        commentId: lastCommentId(thread),
        body: 'CodeRabbit has completed their review and did not respond to our last comment. Resolving as settled.\n\nBy Claude Code Kautopilot',
        reason: 'ghosted',
      });
      continue;
    }

    // PENDING — we replied, CR CI still running, wait
    if (lastByUs && crCiStatus === 'in_progress') {
      // Don't close, don't eval — skip entirely, check on next poll
      continue;
    }

    // Everything else → LLM evaluates
    // (includes: "accepted"/"acknowledged"/"learnings" from CR,
    //  fresh CR comments, human review threads, bot threads, etc.)
    toEval.push(thread);
  }

  return { closed, toEval };
}
```

**What this filters deterministically:**

| State           | Detection                   | Action                    | LLM? |
| --------------- | --------------------------- | ------------------------- | ---- |
| Outdated        | `isOutdated === true`       | Close with template note  | No   |
| Ghosted         | Last by us + CR CI complete | Close with template note  | No   |
| Pending         | Last by us + CR CI running  | Skip (wait for next poll) | No   |
| Everything else | —                           | → fan-out to LLM          | Yes  |

**Why not filter "resolved"/"acknowledged":** CR might say "added to learnings" but the underlying issue might not actually be fixed. The LLM with full spec+history context is better positioned to judge whether the thread is truly settled.

#### Step 2: Execute pre-filtered closings (Pure TypeScript)

```typescript
for (const item of preFilter.closed) {
  await gh(`pr comment {prNumber} --reply-to ${item.commentId} --body "${item.body}"`);
  await ghApiGraphQL(`mutation { resolveReviewThread(input: {threadId: "${item.threadId}"}) }`);
}
```

Log: `eval:prefilter`, metadata: `{version, pushCycle, closed: N, skipped: N, toEval: M}`

#### Step 3: Fan-out eval (LLM `--print`, parallel)

One call per unit — CI failures, remaining threads, PR comments:

```typescript
const evalUnits = [
  ...pollResult.ciFailures.map(ci => ({ type: 'ci' as const, data: ci })),
  ...preFilter.toEval.map(t => ({ type: 'thread' as const, data: t })),
  ...pollResult.prComments.map(c => ({ type: 'comment' as const, data: c })),
];

const results = await Promise.all(evalUnits.map(unit => llm('--print', evaluatorRole, { unit, specContext })));
```

#### Each eval call returns

```typescript
interface EvalResult {
  // What is this?
  unitType: 'ci' | 'thread' | 'comment';

  // The verdict
  verdict: Verdict;

  // For CI failures
  rootCause?: string;
  fixDescription?: string;
  filesToChange?: string[];

  // For threads and comments
  reply?: string; // what to reply (always required)
  resolveThread?: boolean; // resolve the thread after replying
  reactThumbsUp?: boolean; // react 👍 on the comment

  // Code fix needed?
  codeFix?: {
    file: string;
    description: string;
    priority: 1 | 2 | 3; // 1=CI, 2=review, 3=CR
  };

  // Is this ambiguous? Needs user input?
  ambiguous: boolean;
  ambiguityReason?: string; // what's unclear and why
}
```

#### Verdicts per unit type

**CI failure:**
| Verdict | Meaning | Next |
| ------- | ------- | ---- |
| `fixable` | Root cause identified, fix known | → code fix |
| `external` | Not our fault (flaky test, infra) | → reply explaining, no fix |
| `ambiguous` | Can't determine root cause | → TTY handoff |

**Review thread (any author — CR, human, bot):**
| Verdict | Meaning | Next |
| ------- | ------- | ---- |
| `resolved` | Issue was fixed/accepted but thread not closed | → resolve thread via API |
| `false_positive` | Not applicable, wrong, already handled | → reply with reason, do NOT resolve |
| `true_positive` | Valid, needs code change | → thumbs up, code fix |
| `ambiguous` | Unclear, might need user context | → TTY handoff |

**PR comment (top-level, since last commit):**
| Verdict | Meaning | Next |
| ------- | ------- | ---- |
| `false_positive` | Not applicable, misconception | → reply with reason |
| `true_positive` | Valid feedback, needs action | → thumbs up, code fix or reply |
| `acknowledgment` | Info/question, just respond | → reply |
| `ambiguous` | Unclear intent | → TTY handoff |

---

### ACT — Execute Immediate Actions (Pure TypeScript)

No LLM. Post replies, resolve threads, react. Gather code fixes.

#### 1. Post all replies

```typescript
for (const result of evalResults) {
  if (result.reply) {
    if (result.unitType === 'thread') {
      await gh(`pr comment {prNumber} --reply-to {result.commentId} --body "${result.reply}"`);
    } else if (result.unitType === 'comment') {
      await gh(`pr comment {prNumber} --body "${result.reply}"`);
    }
  }
}
```

#### 2. Resolve threads

```typescript
for (const result of evalResults) {
  if (result.resolveThread) {
    await ghApiGraphQL(`mutation { resolveReviewThread(input: {threadId: "${result.threadId}"}) }`);
  }
}
```

#### 3. React thumbs up

```typescript
for (const result of evalResults) {
  if (result.reactThumbsUp) {
    await gh(`api repos/{owner}/{repo}/pulls/comments/{result.commentId}/reactions -f content=+1`);
  }
}
```

#### 4. Separate into two buckets

```typescript
const ambiguousItems = evalResults.filter(r => r.ambiguous);

const codeFixes = evalResults
  .filter(r => r.codeFix !== null && !r.ambiguous)
  .map(r => r.codeFix)
  .sort((a, b) => a.priority - b.priority);
```

#### 5. Decide next

```
if (ambiguousItems.length > 0) {
  → TTY (user resolves ambiguities)
} else if (codeFixes.length > 0) {
  → WRITE_FIX → RUN_FIX → PUSH → POLL
} else {
  // Everything was replies/resolves, no code changes needed
  → POLL (re-check, threads may have changed)
}
```

---

### TTY — User Input for Ambiguous Items (TTY handoff)

When eval can't confidently determine a verdict, pause and get user input.

1. Log: `eval_tty:started`, metadata: `{version, pushCycle, ambiguousCount}`
2. Spawn Claude interactively with:
   - All ambiguous items (the thread/comment/CI + the LLM's reasoning + why it's unsure)
   - Spec + plans + history for full context
   - Instructions: discuss each item with the user, determine verdict, collect reply text and/or code fix description
3. On exit, read Claude's output — should contain resolved verdicts for each ambiguous item
4. Execute immediate actions for resolved items (reply, resolve, thumbs up)
5. Add any code fixes to the fix list
6. Log: `eval_tty:completed`, metadata: `{version, pushCycle, resolved, newFixes}`
7. Continue to WRITE_FIX (if code fixes) or POLL (if none)

---

### WRITE_FIX — Merge Fixes into One Spec (LLM `--print`)

1. Log: `write_fix:started`, metadata: `{version, pushCycle}`
2. **LLM (`--print`):** Take all `codeFix` items + spec + plans + history. Deduplicate overlapping fixes on same file, merge into one coherent implementation spec. The LLM resolves priority conflicts (e.g., CI fix and CR fix touch same line).
3. Write to dev-loop working spec
4. Log: `write_fix:completed`, metadata: `{version, pushCycle, fixCount}`
5. Transition → `run_fix`

---

### RUN_FIX — Execute dev-loop (Pure TS + subprocess)

1. Log: `run_fix:started`, metadata: `{version, pushCycle}`
2. Run dev-loop and capture the result
3. Capture exit code
4. Log: `run_fix:completed`, metadata: `{version, pushCycle, exitCode, status, runId}`
5. Transition:
   - Exit 0, `completed` → `push`
   - Exit 2 or `max_iterations` → TTY handoff (conflict/max iter, same pattern as Phase 2)
   - Exit 1/3 → `failed`

---

## Terminal States

### `feedback_check`

**Execution:** Inquirer (user interaction).

1. Present summary:

   ```
   PR #42 is ready for you to merge: https://github.com/org/repo/pull/42
   Ticket: PE-1234

   {approvalsCount}/{requiredApprovals} approvals
   {threadsResolved} conversations resolved
   {threadsRejected} conversations pushed back on
   {pushCycles} push cycles
   ```

2. Options:
   - **"Done"** → `completed`
   - **"I have feedback"** → Phase 1 (v{N+1})
3. On done:
   - Ticket transition: `ticketTransitions.done`
   - Update config: `runtime.phase` → `completed`
4. On feedback:
   - Update config: `runtime.phase` → `plan`, bump `specVersion`
   - Ticket transition: `ticketTransitions.feedback`
   - Transition → Phase 1 (feedback step)

---

### `completed`

1. Log: `phase3:completed`, metadata: `{version, prNumber}`
2. **Do NOT merge the PR.**

---

### `failed`

1. Log: `phase3:failed`, metadata: `{version, step, pushCycle, error}`
2. Present error to user with option to retry or abort.

---

## Event Log

```jsonl
{"ts":"...","event":"phase3:started","version":1}
{"ts":"...","event":"commit_pending:completed","version":1,"commitSha":"abc123"}
{"ts":"...","event":"prereview:completed","version":1,"result":"no_findings"}
{"ts":"...","event":"push:completed","version":1,"pushCycle":1,"commitSha":"def456"}
{"ts":"...","event":"create_pr:completed","version":1,"prNumber":42,"policy":{"requiredChecks":["ci/test","ci/lint"],"requiredApprovals":2}}
{"ts":"...","event":"poll:completed","version":1,"pushCycle":1,"state":"pending"}
{"ts":"...","event":"poll:completed","version":1,"pushCycle":1,"state":"blocked","ciFailures":1,"threads":4,"comments":1}
{"ts":"...","event":"eval:started","version":1,"pushCycle":1,"units":6}
{"ts":"...","event":"eval:completed","version":1,"pushCycle":1,"replies":4,"resolved":1,"thumbsUp":2,"ambiguous":1,"codeFixes":3}
{"ts":"...","event":"eval_tty:started","version":1,"pushCycle":1,"ambiguousCount":1}
{"ts":"...","event":"eval_tty:completed","version":1,"pushCycle":1,"resolved":1,"newFixes":0}
{"ts":"...","event":"write_fix:completed","version":1,"pushCycle":1,"fixCount":3}
{"ts":"...","event":"run_fix:completed","version":1,"pushCycle":1,"exitCode":0}
{"ts":"...","event":"push:completed","version":1,"pushCycle":2}
{"ts":"...","event":"poll:completed","version":1,"pushCycle":2,"state":"mergeable"}
{"ts":"...","event":"feedback_check:completed","version":1,"result":"completed"}
{"ts":"...","event":"phase3:completed","version":1,"prNumber":42}
```

---

## Artifacts

See [artifacts.md](artifacts.md) for the full artifact structure across all phases.

## State Reconstruction (no status.yaml)

See [artifacts.md](artifacts.md#state-reconstruction-no-statusyaml) for how `kautopilot status` reconstructs state from `log.jsonl`.

---

## Transitions Summary

| From             | To               | Condition                                   |
| ---------------- | ---------------- | ------------------------------------------- |
| `commit_pending` | `prereview`      | Always                                      |
| `prereview`      | `push`           | Always                                      |
| `push`           | `create_pr`      | First push                                  |
| `push`           | `poll`           | Subsequent push                             |
| `create_pr`      | `poll`           | PR created or exists                        |
| `poll`           | `feedback_check` | `state === 'mergeable'`                     |
| `poll`           | (wait)           | `state === 'pending'`                       |
| `poll`           | `ensure_branch`  | `state === 'blocked'`                       |
| `ensure_branch`  | `poll`           | Branch fixed (rebased or conflict resolved) |
| `eval`           | `tty`            | Ambiguous items exist                       |
| `eval`           | `write_fix`      | Code fixes, no ambiguity                    |
| `eval`           | `poll`           | No code fixes (replies only)                |
| `tty`            | `write_fix`      | Code fixes after user input                 |
| `tty`            | `poll`           | No code fixes after user input              |
| `write_fix`      | `run_fix`        | Spec written                                |
| `run_fix`        | `push`           | Exit 0 completed                            |
| `run_fix`        | `eval_tty`       | Exit 2 or max_iterations                    |
| `run_fix`        | `failed`         | Exit 1 or 3                                 |
| `feedback_check` | `completed`      | User chose done                             |
| `feedback_check` | Phase 1          | User chose feedback                         |

## Execution Mode Summary

| State            | Mode                    | LLM?              | Why                                        |
| ---------------- | ----------------------- | ----------------- | ------------------------------------------ |
| `commit_pending` | LLM + subprocess        | Yes (`--print`)   | Detect conventions                         |
| `prereview`      | LLM + subprocess        | Yes (`--print`)   | Evaluate local CR findings                 |
| `push`           | Pure TS + subprocess    | No                | Git push, post actions                     |
| `create_pr`      | Pure TS + subprocess    | No                | `gh pr create`, fetch policy               |
| `poll`           | Pure TS + subprocess    | No                | `gh` queries, state computation            |
| `ensure_branch`  | Pure TS + TTY           | Only for conflict | Rebase is pure TS, conflict needs LLM+user |
| `eval`           | LLM (`--print`) fan-out | Yes               | One call per unit, spec+history context    |
| `act`            | Pure TS + subprocess    | No                | Post replies, resolve, react               |
| `tty`            | TTY handoff             | Yes (interactive) | User resolves ambiguity                    |
| `write_fix`      | LLM (`--print`)         | Yes               | Merge fixes into spec                      |
| `run_fix`        | Pure TS + subprocess    | No                | Run dev-loop                               |
| `feedback_check` | Inquirer                | No                | User chooses done or feedback              |
| `completed`      | Pure TS                 | No                | Finalize                                   |
| `failed`         | Pure TS                 | No                | Report error                               |

## Notes

- **Poll has 3 states, not exit codes.** `pending` = wait, `mergeable` = done, `blocked` = work to do. Simple.
- **MergePolicy fetched once** at `create_pr`. Tells us which CI checks matter, how many approvals needed, whether conversation resolution is required. Avoids false positives from optional checks.
- **Every eval call gets spec + history.** This is critical — the LLM needs to know what the code is supposed to do to judge whether feedback is valid.
- **Deterministic pre-filter for obvious cases.** Outdated and ghosted threads are closed in pure TS — no LLM needed. Pending threads (CR still running) are skipped until next poll. Only remaining threads go to LLM.
- **"Resolved"/"acknowledged" is NOT deterministic.** Just because CR said "added to learnings" doesn't mean the issue is fixed. The LLM with spec+history context judges whether the thread is truly settled.
- **Two eval outputs:** immediate actions (reply/resolve/react — pure TS) and code fixes (collected for spec). Clean separation.
- **Ambiguity → TTY before spec.** If the LLM can't confidently judge, pause for the user. Never guess on ambiguous feedback.
- **One unified implementation spec.** All code fixes (CI + threads + comments) merged into one spec. The implementation loop handles them together, which avoids partial-fix problems.
- **Branch state fixed first.** No point evaluating threads if the branch is behind or conflicting. Rebase is pure TS, conflicts get LLM + user.
- **Artifacts stored globally.** Every output (reviews, logs, specs, results) goes to `~/.kautopilot/{id}/artifacts/v{N}/{phase}/...`. Addressable by version + cycle for debugging.
- **No status.yaml.** State is reconstructed from `log.jsonl` + what's currently running. Every event has a timestamp, so durations are computed on demand. Snapshots go stale; the log doesn't.
- **NEVER merge the PR.** The user merges manually.
- **Bot signature:** all replies include `"By Claude Code Kautopilot"`.
