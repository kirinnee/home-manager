# Phase: Pre-Review (CodeRabbit Local Review)

This phase runs CodeRabbit CLI review locally before pushing, allowing fixes for true positives before the actual PR review.

**Agent Mode:** When spawned as a prereview agent, execute this phase and report findings back to orchestrator. Do NOT update `.kagent/task-state.json`.

## Agent Context (when spawned)

- Working directory: `{WORKDIR}`
- Task ID: `{ticketId}`
- State file: `.kagent/task-state.json`

## Philosophy

**CodeRabbit is often wrong.** Evaluate EVERY comment critically. Don't blindly accept suggestions.

## Check Repository Type

First, check if this is an atomicloud/atomi-based repository that has CodeRabbit integration:

```bash
git remote -v | grep -E '(atomicloud|atomi)'
```

**If NOT an atomicloud repo:** Skip this phase entirely. Read `phases/pushing.md` and follow it.

**If IS an atomicloud repo:** Proceed with local CodeRabbit review below.

## Step 1: Run CodeRabbit Review

Run the CodeRabbit CLI review as a background task:

```bash
coderabbit review --plain --base main > review.md 2>&1
```

Use `run_in_background: true` with Bash tool, then wait with TaskOutput (block=true, with appropriate timeout).

Update state: `phase: "prereview"`

## Step 2: Wait for Review Completion

Wait for the background task to complete using TaskOutput. The review may take several minutes.

If the command fails (exit code != 0):

- Check if `coderabbit` CLI is installed: `which coderabbit`
- If not installed, skip this phase and proceed to pushing
- If installed but failed, log the error and proceed to pushing anyway (don't block on local review failure)

## Step 3: Process Review Findings

Once review.md is generated, read it and process each finding systematically:

### 3.1: Read and Analyze Review

Read `review.md` and identify all review findings. For each finding:

1. **Classify the finding:**
   - **True positive:** A legitimate issue that should be fixed
   - **False positive:** An incorrect suggestion that should be ignored or addressed with a comment
   - **Opinion/Style:** A subjective suggestion that may or may not be valid

2. **Handle each category:**

   **For TRUE POSITIVES:**
   - Fix the issue directly in the code
   - The fix should be minimal and targeted

   **For FALSE POSITIVES (reasonable):**
   - If the suggestion seems reasonable but not required, add a brief comment explaining why the current approach is correct
   - For markdown files: add a visible note or hidden comment
   - For code files: add a brief inline comment if appropriate

   **For FALSE POSITIVES (clearly wrong):**
   - For markdown files: use hidden HTML comment: `<!-- coderabbit: ignore - explanation here -->`
   - For other file types: ignore the finding entirely (no action needed)

### 3.2: Apply Fixes

For each true positive:

1. Read the relevant file(s)
2. Make targeted edits to fix the issue
3. Verify the fix doesn't break anything

## Step 4: Cleanup

After processing all findings:

```bash
rm -f review.md
```

## Step 5: Commit Any Fixes

If you made code changes during this phase:

```bash
git status
```

If there are uncommitted changes:

1. Stage specific files (never `git add -A`)
2. Commit with message following project conventions:
   ```
   fix: address coderabbit local review findings
   ```

If no changes were needed, proceed without committing.

## Update State

- Keep `phase: "prereview"` until done (for resumability)
- Once complete, update state to prepare for pushing

## Resumability

If resuming into this phase:

- Check if `review.md` exists — if so, resume from Step 3 (processing findings)
- If no `review.md` and no recent coderabbit activity, start from Step 1

## Next

After local review is complete (or skipped): Read `phases/pushing.md` and follow it.

## Agent Report Format

When running as an agent, report back to orchestrator with:

```
RESULT: <skip|no_findings|fixed|error>
REPO_TYPE: <atomicloud|other>

FIXES_APPLIED: <N>
- <brief description of fix 1>
- <brief description of fix 2>

ERROR:
<error message if RESULT is error>

COMMIT_SHA: <sha if fixes were committed, or null>
```
