---
name: fact-fix
description: Fix documentation inaccuracies based on fact-check report. Use when running /fact-fix, fixing docs from fact-check results, or applying corrections to documentation.
argument-hint: '[--agents N] [--mode auto-apply|preview]'
---

# Fact Fix Documentation

Automatically fix documentation inaccuracies identified by fact-check using parallel agents.

## When to Use

- Running `/fact-fix` after `/fact-check`
- Fixing docs from a fact-check report
- Applying corrections to documentation files
- Batch fixing multiple documentation files

## Context Resumption

If context is lost, check whether pending files remain:

```bash
bash .fact-check/next-file.sh .fact-check/fix-state.json
```

If output is non-empty, work remains. Read config to resume:

```bash
jq '{findingsDir, fixesDir, mode, concurrentAgents}' .fact-check/fix-state.json
```

**Resume by running `/fact-fix` again** — the scripts track all progress.

## Prerequisites

1. **Fact-check must have run** — `.fact-check/findings/` must exist with finding files
2. **Scripts must exist** — `/fact-check` creates them; if not present, create per Step 2

### Required Questions

1. **Concurrent Agents**: How many agents can run in parallel?
   - Default recommendation: 3-5 agents

2. **Mode**: Auto-apply or preview?
   - **Auto-apply**: Agents edit documentation files directly
   - **Preview**: Agents write fix plans to `.fact-check/fixes/` for review

## Process

### Step 1: Collect Configuration

Use `AskUserQuestion` to gather parameters:

```
Questions:
1. Number of concurrent agents?
2. Auto-apply or preview mode?
```

### Step 2: Setup Scripts & Initialize

Verify `.fact-check/findings/` exists. If scripts don't exist (e.g., fact-check was run in a previous session), create them per the fact-check skill's Step 2.

Create fixes directory if in preview mode:

```bash
mkdir -p .fact-check/fixes
```

Run the init script:

```bash
bash .fact-check/init-fix-state.sh .fact-check/fix-state.json "<mode>" <N>
```

The script scans `.fact-check/findings/`, extracts original file paths from the `<!-- source: path -->` metadata, and writes `fix-state.json`.

**If resuming**: Skip this step — `fix-state.json` already exists. Read only the config:

```bash
jq '{findingsDir, fixesDir, mode, concurrentAgents}' .fact-check/fix-state.json
```

### Step 3: Agent Loop

**⚠️ CRITICAL RULE: 1 Agent = 1 File**

Loop until `next-file.sh` returns nothing:

1. **Get next batch**:

   ```bash
   bash .fact-check/next-file.sh .fact-check/fix-state.json --batch <N>
   ```

2. **For each file**, compute safe name and spawn an agent:

   ```
   safeName = file with / → _ and .md/.mdx extension removed
   ```

   **Auto-apply mode prompt:**

   ```
   FACT-FIX TASK

   Documentation file: <file>
   Finding file: .fact-check/findings/<safeName>.md

   INSTRUCTIONS:
   1. Read the finding file to understand all issues
   2. Read the original documentation file
   3. For each issue:
      - 🔴 Source Code Inaccuracy: Update docs to match actual code
      - 🟡 Documentation Issue: Fix broken links, typos, outdated refs
      - 🟠 Other Problem: Improve clarity, fix formatting
   4. Apply fixes DIRECTLY to the documentation file using the Edit tool
   5. Respond: "Fixed <file> — applied N corrections"
   ```

   **Preview mode prompt** (add fix plan output path):

   ```
   FACT-FIX TASK

   Documentation file: <file>
   Finding file: .fact-check/findings/<safeName>.md
   Fix plan output: .fact-check/fixes/<safeName>.md

   INSTRUCTIONS:
   1. Read the finding file to understand all issues
   2. Read the original documentation file
   3. For each issue:
      - 🔴 Source Code Inaccuracy: Update docs to match actual code
      - 🟡 Documentation Issue: Fix broken links, typos, outdated refs
      - 🟠 Other Problem: Improve clarity, fix formatting
   4. Write a fix plan to the output file using the Write tool:

      # Fix Plan: <file>
      ## Fixes
      ### 1. <Issue Title>
      - Category: 🔴/🟡/🟠
      - Location: <line/section>
      - Before: <original text>
      - After: <corrected text>
      - Reason: <why>
      ## Summary
      | Category | Count |
      |----------|-------|
      | 🔴 | N |
      | 🟡 | N |
      | 🟠 | N |

   5. Respond: "Fix plan written"
   ```

   Spawn with `run_in_background: true`.

3. **For each spawned agent** (sequentially):

   ```
   a. TaskOutput(agent_id) — wait for completion
   b. bash .fact-check/mark-done.sh .fact-check/fix-state.json mark-fixed <filename>
   c. Verify: fix file exists (preview) or git diff shows changes (auto-apply)
   ```

4. Go back to step 1 if `next-file.sh` returns more files.

### Step 4: Review or Commit

**If preview mode:**

Present fix plans to user for review:

```bash
ls .fact-check/fixes/*.md
```

Use `AskUserQuestion`:

- Header: "Apply"
- Question: "Review the fix plans. Apply all fixes?"
- Options: "Apply all", "Review individually", "Cancel"

If "Apply all": spawn agents to apply each fix plan.

**If auto-apply mode:**

Show summary of changes:

```bash
git diff --stat
```

Use `AskUserQuestion`:

- Header: "Commit"
- Question: "Commit these documentation fixes?"
- Options: "Commit", "Make more changes", "Discard"

### Step 5: Cleanup

Remove only fix-specific artifacts. **Preserve findings** (they're useful for reference).

```bash
rm -rf .fact-check/fixes .fact-check/fix-state.json
```

## Fix Guidelines

### 🔴 Source Code Inaccuracies

| Issue Type             | Fix Approach                            |
| ---------------------- | --------------------------------------- |
| Wrong function name    | Update to match actual function in code |
| Incorrect parameters   | Update param names/types from source    |
| Wrong return type      | Match actual return type                |
| Missing error handling | Document actual error behavior          |
| Outdated behavior      | Update to match current implementation  |

### 🟡 Documentation Issues

| Issue Type         | Fix Approach                   |
| ------------------ | ------------------------------ |
| Broken link        | Fix URL or remove link         |
| Typo               | Correct spelling               |
| Outdated reference | Update to current version/path |
| Missing example    | Add working code example       |
| Wrong file path    | Update to correct path         |

### 🟠 Other Problems

| Issue Type          | Fix Approach                             |
| ------------------- | ---------------------------------------- |
| Empty section       | Add meaningful content or remove section |
| Unclear explanation | Rewrite for clarity                      |
| Missing context     | Add necessary background                 |
| Poor formatting     | Fix markdown structure                   |

## Tips

- **Run fact-check first**: Always have a fresh report before fixing
- **Preview mode first**: For large changes, preview before auto-applying
- **Git is your friend**: Commit before running auto-apply mode
- **Respect code truth**: When in doubt, trust the code over docs
- **Keep it concise**: Don't over-explain in documentation
- **Findings persist**: `.fact-check/findings/` is preserved across fix runs
