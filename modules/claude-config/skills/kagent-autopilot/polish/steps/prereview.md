# Polish Step: Pre-Review — Team Agent (Opus)

CodeRabbit local review before pushing. Allows fixing true positives before the actual PR review.

## Agent Context

- Working directory: {WORKDIR}
- Task ID: {ticketId}
- Repo Config: {repoConfig}

## Agent Report Format

```
RESULT: <skip|no_findings|fixed|error>
PREREVIEW_ENABLED: <true|false>
FIXES_APPLIED: <N>
- <brief description of fix 1>
- <brief description of fix 2>
ERROR: <error message if RESULT is error>
COMMIT_SHA: <sha if fixes were committed, or null>
```

**Do NOT update state files.** Report back to orchestrator only.

## Philosophy

**CodeRabbit AI often produces false positives or low-value suggestions.** Evaluate each comment thoughtfully. Accept valid feedback, but don't hesitate to push back when the suggestion doesn't apply or isn't worth the change. Be professional and specific in your reasoning.

## Check if Prereview is Enabled

Read `repoConfig.prereviewEnabled` from context:

- If `prereviewEnabled: false`: Skip. Report `RESULT: skip`.
- If `prereviewEnabled: true`: Proceed below.

## Step 1: Run CodeRabbit Review

```bash
coderabbit review --plain --base {repoConfig.baseBranch} > rb-review.md 2>&1
```

Use `run_in_background: true` with Bash tool, then wait with TaskOutput (block=true, with appropriate timeout).

## Step 2: Wait for Review Completion

If the command fails (exit code != 0):

- Check if `coderabbit` CLI is installed: `which coderabbit`
- If not installed, skip and proceed
- If installed but failed, log error and proceed (don't block on local review failure)

## Step 3: Process Review Findings

Read `rb-review.md` and classify each finding:

### Classification

| Verdict                         | Criteria                             | Action                           |
| ------------------------------- | ------------------------------------ | -------------------------------- |
| **True positive**               | Genuinely valid, applies to our code | Fix directly                     |
| **False positive (reasonable)** | Seems reasonable but not needed      | Add brief comment explaining why |
| **False positive (wrong)**      | Wrong, doesn't apply                 | Ignore or hide comment           |

### For TRUE POSITIVES:

- Fix the issue directly in the code
- Minimal and targeted fixes only

### For FALSE POSITIVES (reasonable):

- Add a brief inline comment explaining the current approach

### For FALSE POSITIVES (clearly wrong):

- For markdown: `<!-- coderabbit: ignore - explanation -->`
- For other files: ignore entirely

## Step 4: Cleanup

```bash
rm -f rb-review.md
```

## Step 5: Commit Any Fixes

If code changes were made:

```bash
git status
```

Stage specific files and commit:

```
fix: address coderabbit local review findings
```

## Important

- Do NOT update state files
- Do NOT push
