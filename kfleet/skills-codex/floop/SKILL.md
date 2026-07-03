---
name: floop
description: Iteratively review-and-resolve the current changes using parallel
  subagent reviewers across multiple lenses (bugs, quality, completion), looping
  until every reviewer is satisfied. Use when running /floop, or when asked to
  deeply review and harden a diff until all critiques are addressed.
---

# Floop — Feedback Loop Review

Drive the current changes to a clean bill of health by repeatedly:

1. Spawning **parallel subagent reviewers**, each looking through a different **lens**.
2. Having the **main agent resolve** every actionable finding (edit the code).
3. Spawning **fresh reviewers** on the updated changes.

Repeat until **all reviewers are happy** (no actionable findings) or the round cap is hit.

The main agent (you) is the orchestrator. Reviewers only review — they never edit. You own all the fixes.

## When to Use

- Running `/floop`
- "Review my changes and keep fixing until it's clean"
- Hardening a diff before opening a PR
- Any review-resolve-rereview loop on the working tree or a branch diff

## Core Loop

```
┌─> spawn N reviewers (parallel, read-only, one per lens)
│      │
│      ▼
│   collect findings
│      │
│      ├─ all reviewers happy? ──> DONE ✅
│      │
│      ▼ (findings exist)
│   main agent resolves each actionable finding (edits code)
│      │
└──────┘  loop with fresh reviewers on the updated diff
```

## Step 0: Parse Arguments & Scope

The user invokes: `/floop [scope] [--max-rounds N]`

- **scope** (optional): what to review and against what. Examples: `vs main`, `the working tree`, `"the kautopilot inversion changes"`. Default: **uncommitted working-tree changes** (staged + unstaged).
- **--max-rounds N** (optional): hard cap on iterations. Default: **5**.

Determine the diff to review:

```bash
# Always: surface untracked (new) files first — they're in scope too
rtk git status --porcelain

# Default: working tree vs HEAD
rtk git diff HEAD

# If scope names a base branch (e.g. "vs main"):
rtk git diff main...HEAD
```

**Untracked files are part of the scope.** `git diff HEAD` never shows them, so either
`git add -N <path>` each one (makes them appear in the diff) or list them explicitly in
the reviewer prompts so reviewers read them directly.

State the scope and base back to the user in one line before starting.

## Step 1: Define the Lenses

Spawn **one reviewer per lens**, in parallel. The three default lenses:

| Lens           | Reviewer's job                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Bugs**       | Correctness: logic errors, edge cases, race conditions, null/None, off-by-one, broken error handling, regressions, security holes.        |
| **Quality**    | Readability, naming, structure, duplication, dead code, missing tests, style consistency with the surrounding code, over-engineering.     |
| **Completion** | Does the change actually fulfil its stated intent? Missing pieces, half-done TODOs, unhandled cases, docs/config not updated, loose ends. |

If the user's scope implies extra concerns (e.g. "perf", "API compat"), add a lens for it. Keep it to 3–5 lenses.

## Step 2: Spawn Reviewers (one round)

**Spawning a fresh-context reviewer:**

- Spawn one **subagent per lens via explicit delegation** (codex's native subagents — say which agents to spawn, how to split the work, and the output shape); codex fans them out in parallel and collects results.
- Equivalently, run one **`codex exec "<reviewer prompt>"`** subprocess per lens as parallel background jobs (`… &` then `wait`). Either way you get a fresh, read-only reviewer context per lens.

Each reviewer gets the same prompt + strict output contract below, and only the orchestrator (you) edits.

Each reviewer prompt must include:

- The **scope** and how to get the diff (the exact `git diff` command).
- The **lens** and exactly what to look for (from the table above).
- This **strict output contract** so you can parse "happy vs not":

```
You are the {LENS} reviewer for a change under review.

SCOPE: {scope description}
Get the diff with: {exact git diff command}
Read surrounding files as needed for context. You are READ-ONLY — do not edit anything.

REVIEW THROUGH THE {LENS} LENS ONLY:
{lens-specific instructions}

Report ONLY real, actionable problems. Do not invent nitpicks to seem thorough.
If the change is clean through your lens, say so.

OUTPUT FORMAT (exactly this):
VERDICT: PASS   (if no actionable findings)
   or
VERDICT: CHANGES_REQUESTED
FINDINGS:
1. [severity: high|med|low] file:line — problem — suggested fix
2. ...
```

## Step 3: Collect & Decide

Gather every reviewer's verdict.

- **All `PASS`** → the loop is done. Go to Step 5.
- **Any `CHANGES_REQUESTED`** → collect all findings, de-duplicate overlapping ones across lenses, and continue to Step 4.

Show the user a tight round summary: round number, each lens's verdict, and the count of findings.

## Step 4: Resolve (main agent)

**You** resolve the findings — reviewers never edit.

For each actionable finding:

1. Decide: fix it, or consciously reject it.
2. If fixing: make the edit yourself with `apply_patch`.
3. If rejecting: note why in one line (e.g. "intentional — matches existing pattern", "out of scope"). A reasoned rejection still counts as resolved.

Rules:

- Resolve **every** finding before the next round — either fixed or explicitly rejected with a reason.
- Don't introduce new scope; stay within the change under review unless a fix genuinely requires it.
- After editing, run the obvious local checks if cheap (build/typecheck/tests for the touched area) so the next round reviews working code.

Then loop back to **Step 2** with **fresh reviewers** on the now-updated diff.

## Step 5: Termination

Stop when any of:

- **All reviewers PASS** in a round → success. ✅
- **Only rejections remain**: every remaining finding is resolved-by-rejection (each with a stated reason) while a reviewer still emits `CHANGES_REQUESTED` → stop as **success-with-rejections**. Report the rejections and reasons; don't burn rounds re-litigating them.
- **Round cap reached** (`--max-rounds`, default 5) → stop and report the remaining open findings honestly. Do not claim clean if it isn't.

Guard against thrash: if the same finding reappears two rounds running and you've chosen to reject it, treat it as resolved-by-rejection — don't loop on it.

## Step 6: Final Report

Give the user a short, scannable summary:

```
Floop complete — {N} rounds

Rounds:
  R1: bugs ✗(3)  quality ✗(2)  completion ✓   → fixed 4, rejected 1
  R2: bugs ✓     quality ✗(1)  completion ✓   → fixed 1
  R3: bugs ✓     quality ✓     completion ✓   → all happy ✅

Result: all reviewers PASS
Key fixes: {1–3 bullets of the most important changes}
Rejected (with reason): {any, or "none"}
```

If it ended on the round cap instead of all-PASS, lead with that and list the still-open findings.

## Notes

- Reviewers are **read-only reviewer subprocesses** — read-only is enforced by the prompt's "You are READ-ONLY — do not edit anything" line. Only the orchestrator edits. This keeps the loop deterministic and avoids parallel edit conflicts.
- Spawn each round's reviewers **together in one message** so they run concurrently.
- Reviewers get **fresh context every round** — they re-read the current diff, so fixes from prior rounds are actually re-checked.
- Keep findings honest: a reviewer with nothing to say should `PASS`, not pad the list.
