---
name: per-file-fix
description: 'Two-phase file processor: scan files for issues, then fix them. Use when running /per-file-fix.'
argument-hint: '"INSTRUCTION" [--path TARGET] [--ext EXTENSIONS] [--agents N]'
---

# Per-File Fix

A two-phase file processor that scans files for issues, creates per-file reports, then applies fixes only to files with issues.

## When to Use

- Running `/per-file-fix "check X and fix it"`
- Batch processing files with scan-then-fix workflow
- Applying the same fix instruction across many files

## Context Resumption

If context is lost, check current phase and pending files:

```bash
# Check phase and progress
jq '{phase, instruction, pendingFiles: (.pendingFiles | length), processedFiles: (.processedFiles | length)}' .per-file-fix/state.json

# Resume by running the skill again
```

The scripts track all progress — re-running the skill resumes from where it left off.

## Process

> **`<skill-dir>`** refers to the directory containing this SKILL.md. Resolve it once at the start and reuse throughout.

### Step 0: Parse Arguments

The user invokes with: `/per-file-fix "INSTRUCTION" [--path TARGET] [--ext EXT] [--agents N]`

Parse into:

- **instruction**: The task to perform per file (required)
- **targetPath**: Where to find files (default: `.`)
- **extensions**: File extensions to process (default: `*`)
- **concurrentAgents**: Parallel agents (default: `3`)

If no instruction provided, error with usage example.

### Step 1: Initialize Session

Generate session ID and create working directory:

```bash
SESSION=$(date -u +%Y%m%d-%H%M%S)
mkdir -p ".per-file-fix/reports/${SESSION}"
echo '*' > .per-file-fix/.gitignore
```

### Step 2: Initialize State (Phase 1: Scan)

Discover files matching extensions under target path. Exclude common irrelevant directories (node_modules, .git, build artifacts, etc.).

```bash
# Example file discovery - adjust based on extensions
find "$TARGET_PATH" -type f -name "*.${EXT}" \
  ! -path "*/node_modules/*" \
  ! -path "*/.git/*" \
  ! -path "*/build/*" \
  ! -path "*/dist/*" \
  | bash <skill-dir>/scripts/init-state.sh ".per-file-fix/state.json" \
    '[]' "$CONCURRENT_AGENTS" ".per-file-fix/summary.md"
```

Then add session/instruction to state:

```bash
TEMP=$(mktemp)
jq --arg session "$SESSION" --arg instruction "$INSTRUCTION" --arg phase "scan" \
  '. + {session: $session, instruction: $instruction, phase: $phase, filesWithIssues: [], failedFiles: []}' \
  .per-file-fix/state.json > "$TEMP" && mv "$TEMP" .per-file-fix/state.json
```

**If resuming**: Skip steps 1-2. Read existing state to get session/instruction/phase.

### Step 3: Phase 1 - Scan Loop

**1 Agent = 1 File.** Loop until `next-file.sh` returns nothing:

1. **Get next batch**:

   ```bash
   bash <skill-dir>/scripts/next-file.sh .per-file-fix/state.json --batch $CONCURRENT_AGENTS
   ```

2. **For each file**, spawn an agent with the scan prompt:

   ```typescript
   safeName = file.replace(/\//g, '_').replace(/\.[^.]+$/, '');

   Task({
     subagent_type: 'general-purpose',
     description: `Scan ${file}`,
     prompt: `
   PER-FILE SCAN TASK
   
   File: ${file}
   Session: ${session}
   
   INSTRUCTION:
   ${instruction}
   
   YOUR TASK:
   1. Read the file
   2. Analyze it according to the instruction
   3. If NO ISSUES found: respond "No issues found" and stop
   4. If ISSUES found: write a report to .per-file-fix/reports/${session}/${safeName}.md
   
   REPORT FORMAT (only if issues found):
   ## Issues Found
   
   [List each issue with file location]
   
   ## Recommended Changes
   
   [Specific changes to make]
   
   ## Implementation Notes
   
   [Any additional context needed for the fix]
   
   When done, respond with either:
   - "No issues found" (if clean)
   - "Report written: ${safeName}.md" (if issues)
   `,
     run_in_background: true,
   });
   ```

3. **Collect results** (sequentially):

   ```
   a. TaskOutput(agent_id) — wait for completion
   b. Check agent response:
      - "No issues found" → mark done, no report needed
      - "Report written" → verify report exists, add to filesWithIssues
      - Error/other → add to failedFiles, log warning
   c. bash <skill-dir>/scripts/mark-done.sh .per-file-fix/state.json <filename>
   ```

4. After batch completes, update state with filesWithIssues:

   ```bash
   TEMP=$(mktemp)
   jq --argjson issues '["file1", "file2"]' '.filesWithIssues += $issues | .filesWithIssues |= unique' \
     .per-file-fix/state.json > "$TEMP" && mv "$TEMP" .per-file-fix/state.json
   ```

5. Repeat from step 1 if `next-file.sh` returns more files.

### Step 4: Transition to Phase 2

After Phase 1 completes:

```bash
# List files with issues
REPORTS=$(ls .per-file-fix/reports/${SESSION}/*.md 2>/dev/null | wc -l)
echo "Phase 1 complete: $REPORTS files have issues"

# If no issues, skip Phase 2
if [[ $REPORTS -eq 0 ]]; then
  echo "No issues found. Done."
  exit 0
fi

# Re-init state for Phase 2 with only files that have reports
FILES_WITH_ISSUES=$(ls .per-file-fix/reports/${SESSION}/*.md | xargs -I{} basename {} .md | while read name; do
  # Convert safe name back to path (reverse the safeName transformation)
  echo "$name" | sed 's/_/\//g'
done)

# Reset pending files for Phase 2
echo "$FILES_WITH_ISSUES" | bash <skill-dir>/scripts/init-state.sh ".per-file-fix/fix-state.json" \
  '[]' "$CONCURRENT_AGENTS" ".per-file-fix/summary.md"

# Update fix state with session/instruction
jq --arg session "$SESSION" --arg instruction "$INSTRUCTION" --arg phase "fix" \
  '. + {session: $session, instruction: $instruction, phase: $phase}' \
  .per-file-fix/fix-state.json > /tmp/fix-state.json && mv /tmp/fix-state.json .per-file-fix/fix-state.json
```

### Step 5: Phase 2 - Fix Loop

Same pattern as Phase 1, but:

1. Use `.per-file-fix/fix-state.json`
2. Agent prompt includes reading the report AND applying fixes:

   ```typescript
   Task({
     subagent_type: 'general-purpose',
     description: `Fix ${file}`,
     prompt: `
   PER-FILE FIX TASK
   
   File: ${file}
   Report: .per-file-fix/reports/${session}/${safeName}.md
   
   INSTRUCTION:
   ${instruction}
   
   YOUR TASK:
   1. Read the report to understand the issues
   2. Read the original file
   3. Apply the fixes according to the instruction
   4. Use the Edit tool to make changes (or Write if full rewrite needed)
   
   When done, respond with:
   - "Fixed: ${file}" (if changes made)
   - "No changes needed" (if report was stale)
   - "Failed: [reason]" (if couldn't fix)
   `,
     run_in_background: true,
   });
   ```

3. Track fixed files vs failed fixes in state

### Step 6: Generate Summary Report

After Phase 2 completes (or Phase 1 if no issues):

```bash
# Count results
TOTAL_SCANNED=$(jq '.processedFiles | length' .per-file-fix/state.json)
WITH_ISSUES=$(jq '.filesWithIssues | length' .per-file-fix/state.json)
FIXED=$(jq '.processedFiles | length' .per-file-fix/fix-state.json 2>/dev/null || echo 0)
FAILED=$(jq '.failedFiles | length' .per-file-fix/fix-state.json 2>/dev/null || echo 0)
```

Write summary to `.per-file-fix/summary.md`:

```markdown
# Per-File Fix Report

**Session**: {session}
**Instruction**: {instruction}

## Summary

| Metric            | Count    |
| ----------------- | -------- |
| Files scanned     | {total}  |
| Files with issues | {issues} |
| Files fixed       | {fixed}  |
| Failed fixes      | {failed} |

## Files Fixed

{list of files that were fixed}

## Failed Fixes

{list of files that couldn't be fixed with reasons}

## Scan Reports

Individual reports available at: `.per-file-fix/reports/{session}/`
```

## Example Usage

```bash
# Fix all TODOs in TypeScript files
/per-file-fix "Find all TODO comments and implement them" --ext ts,tsx

# Fix linting issues
/per-file-fix "Fix all eslint warnings" --path src/ --agents 5

# Update imports after refactor
/per-file-fix "Update imports to use new module paths from @/lib/*" --ext ts
```

## Tips

- **Start small**: Use `--path` to target specific directories first
- **Check reports**: Review `.per-file-fix/reports/` before fixes apply
- **Resume safety**: Re-running continues from where it stopped
- **Concurrency**: Lower `--agents` for rate-limited operations
