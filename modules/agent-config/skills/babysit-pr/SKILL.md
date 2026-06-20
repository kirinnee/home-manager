---
name: babysit-pr
description: 'Open a pull request for the current branch and babysit it to ready-to-merge: push, create/reuse the PR, then loop — fix failing CI, keep the branch current with base, and triage + answer every review thread (CodeRabbit and human) until CI is green and all threads are resolved. Never merges. Use when running /babysit-pr, or any "create the PR and watch it green up" request, standalone (no kautopilot session needed).'
argument-hint: '[PR number | branch | --base <branch> | --no-create]'
---

# babysit-pr — open a PR and drive it to ready-to-merge

Self-contained PR babysitting. No kautopilot session, no special binary — just
`git` + `gh`. Takes the current branch from "has commits" to **ready to merge**
(CI green + every review thread resolved) and **stops there**. It never merges.

**Ready to merge ≠ merged.** Ready = CI green, all review threads resolved, no
outstanding _change requests_. Required **human approval** is NOT part of the
bar — that's the human's job, and so is the actual merge.

## Preconditions

- Inside a git repo, on a **feature branch** (never `main`/`master`).
- `gh` authenticated; the branch (or its commits) exists locally.
- If the repo uses CodeRabbit, it comments on the PR like any other reviewer —
  handled by the review loop below.

## 0. Orient

1. Resolve the **base branch**: `--base` if given, else the remote default
   (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`).
2. Resolve the **current branch** (`git rev-parse --abbrev-ref HEAD`). If it is
   the base branch, **stop and tell the user** — refuse to PR from base.
3. Find an existing PR for the branch:
   `gh pr list --head <branch> --state open --json number,url -q '.'`
   (or the `PR number` arg). Reuse it if present; otherwise you'll create one.

## 1. Push + create (or reuse) the PR

1. **Sync with base first** so the PR isn't born behind:
   `git fetch origin <base>` then rebase (`git rebase origin/<base>`) or merge.
   - On conflicts you can resolve cleanly, do so. If not, **stop and ask the
     user** — never guess a conflict resolution.
2. **Push** the branch. First push sets upstream
   (`git push -u origin <branch>`). On a rejected non-fast-forward, try
   `git pull --rebase` then push; only ever force with **`--force-with-lease`**,
   never plain `--force`, and **never** push to `main`/`master`.
3. **Create the PR** (skip if reusing, or if `--no-create`):
   - Write a real title + body: summarize the change from the commits/diff
     (`git log origin/<base>..HEAD`, `git diff origin/<base>...HEAD --stat`).
     What changed, why, how to test. Don't dump the diff.
   - `gh pr create --base <base> --head <branch> --title "…" --body "…"`.
   - If reusing an existing PR and the scope changed, update its title/body
     (`gh pr edit`) rather than opening a second PR.

## 2. The babysit loop

Repeat until **ready** (§3) or **stuck** (§4). Each cycle:

### a. Poll the PR state

Use `gh` / `gh api graphql` — **never `gh pr watch`**. Gather:

- **CI checks**: `gh pr checks <pr>` → counts of failing / pending / passing.
  Treat a branch-protection _required_ check that hasn't reported yet as pending.
- **Mergeability**: `gh pr view <pr> --json mergeable,mergeStateStatus,reviewDecision`.
- **Review threads** (unresolved, with bodies) via GraphQL, e.g.:
  ```bash
  gh api graphql -f query='
    query($owner:String!,$repo:String!,$pr:Int!){
      repository(owner:$owner,name:$repo){ pullRequest(number:$pr){
        reviewThreads(first:100){ nodes{ id isResolved isOutdated
          comments(first:20){ nodes{ author{login} body path line } } } }
        comments(first:100){ nodes{ id author{login} body } }
      }}}' -F owner=<owner> -F repo=<repo> -F pr=<pr>
  ```
- **PR-level comments** and **reviews** (`CHANGES_REQUESTED`?).

### b. Classify

- **failing CI** → go to (c).
- **unresolved review threads** OR **actionable human PR comment** OR
  **changes requested** → go to (d).
- **CI still pending** → wait (e.g. 30–60s) and re-poll. Bound your patience;
  if it never settles, treat as stuck (§4).
- **nothing failing/pending/unresolved** → **ready** (§3).

> Don't let un-resolvable PR-level chatter block forever: a **bot summary**
> comment (e.g. CodeRabbit's overview) and **your own already-posted replies**
> are NOT blocking. Only genuinely actionable, not-yet-answered **human**
> comments and unresolved inline threads count.

### c. Fix failing CI

1. Pull the failed run's logs: `gh run list --branch <branch>` →
   `gh run view <id> --log-failed` (or `gh pr checks` links).
2. Diagnose and **fix the real cause** locally. Re-run the relevant
   check/test to confirm.
3. Commit (clear message) and re-push (§1.2). Back to (a).

### d. Triage + answer review feedback

For **each** unresolved thread / actionable comment, first decide if it's a
**genuine issue or a false positive** before acting. A false positive
contradicts the intent, is already satisfied, is out of scope, or is pure style
preference. Then pick one:

- **reply** — post your reasoning or an acknowledgement. (For a false positive,
  explain _why_ you're not changing it.)
- **resolve** — resolve the thread once it's genuinely addressed / N/A
  (`addPullRequestReviewThread` resolve mutation, or resolve via the thread id).
- **code_fix** — make the change in the worktree, run checks, **commit + push**
  (§1.2), then reply/resolve the thread.
- **ambiguous** — if you're unsure or the call is the user's to make, **stop and
  ask the user** (§4) rather than guessing.

Apply the GitHub side-effects yourself (reply/resolve/react) — don't assume a
sub-agent did the I/O. **Sign every reply** with a trailing line:
`By Claude Code 🤖`. After acting, **re-verify**: re-poll the threads to confirm
your resolves actually landed before treating them as done. Back to (a).

### e. Keep the branch current

Whenever the PR shows as behind base or not mergeable for branch-staleness:
`git fetch origin <base>` → rebase/merge → re-push (§1.2). Conflicts you can't
resolve cleanly → ask the user (§4).

## 3. Ready — report and stop

When CI is green, no changes are requested, and every thread is resolved:

- Report: PR URL, check status, that all threads are resolved.
- **Do not merge.** Hand back to the user; the merge is theirs.

## 4. Stuck — ask, don't spin

Stop the loop and ask the user when you hit any of:

- a merge/rebase conflict you can't resolve with confidence,
- review feedback that's genuinely ambiguous or a product/scope decision,
- CI that keeps failing for a cause you can't fix (after a real attempt),
- CI stuck pending well past a reasonable wait.

Explain what you tried, what's blocking, and the options — then wait.

## Hard rules

1. **Never merge.** `gh pr merge` is off-limits — ready-to-merge is the finish line.
2. **Never push to `main`/`master`;** force only with `--force-with-lease`.
3. **Poll with `gh` / `gh api graphql`, never `gh pr watch`.**
4. **Never invent a conflict resolution or an ambiguous-feedback decision** —
   ask the user.
5. **Sign replies** `By Claude Code 🤖`.
6. **Keep the branch current** with base before pushing and before declaring ready.
