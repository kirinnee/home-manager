---
name: fact-check
description: Fact-check documentation against source code. Use when running /fact-check, verifying docs accuracy, or checking documentation against implementation.
argument-hint: '[DOCS_PATH] [SOURCE_PATHS] [--output OUTPUT_FILE] [--agents N]'
---

# Fact Check Documentation

Systematically verify documentation accuracy against source code using parallel agents.

## When to Use

- Running `/fact-check`
- Verifying documentation matches implementation
- Auditing docs for accuracy across multiple files
- Multi-repo documentation validation

## Context Resumption

If context is lost, check whether pending files remain:

```bash
bash .fact-check/next-file.sh .fact-check/state.json
```

If output is non-empty, work remains. Read config (without the file lists) to resume:

```bash
jq '{docsPath, sourcePaths, outputFile, concurrentAgents}' .fact-check/state.json
```

**Resume by running `/fact-check` again** — the scripts track all progress, so the orchestrator picks up where it left off.

## Prerequisites

Before starting, you MUST gather this information from the user:

### Required Questions

1. **Documentation Path**: Where are the docs to fact-check?
   - Example: `content/docs/`, `docs/`, `./README.md`

2. **Source Code Paths**: Where is the source code to verify against?
   - For multi-repo: List all relevant paths
   - Example: `src/`, `../backend/src/`, `~/projects/api/src/`

3. **Concurrent Agents**: How many agents can run in parallel?
   - ⚠️ **CRITICAL**: You MUST use **1 agent per file** - do not batch multiple files to one agent
   - Consider API rate limits and system resources
   - Default recommendation: 3-5 agents

4. **Output File**: Where should the report be saved?
   - Default: `fact-check-report.md`

## Process

### Step 1: Collect Configuration

Use `AskUserQuestion` to gather all required parameters:

```
Questions:
1. Docs path?
2. Source paths (comma-separated for multi-repo)?
3. Number of concurrent agents?
4. Output file location?
```

### Step 2: Create Scripts

Create the `.fact-check/` directory and helper scripts:

```bash
mkdir -p .fact-check/findings
```

Write the following four scripts, then `chmod +x` them all.

#### .fact-check/init-state.sh

```bash
#!/usr/bin/env bash
# Usage: init-state.sh <state-file> <docs-path> <extensions> <source-paths-json> <concurrent> <output-file>
# extensions: comma-separated, e.g. "md,mdx"
set -euo pipefail
STATE_FILE="$1"; DOCS_PATH="$2"; EXTENSIONS="$3"
SOURCE_PATHS="$4"; CONCURRENT="$5"; OUTPUT_FILE="$6"

FIND_ARGS=()
IFS=',' read -ra EXTS <<< "$EXTENSIONS"
for i in "${!EXTS[@]}"; do
  [[ $i -gt 0 ]] && FIND_ARGS+=("-o")
  FIND_ARGS+=("-name" "*.${EXTS[$i]}")
done

FILES_JSON=$(find "$DOCS_PATH" -type f \( "${FIND_ARGS[@]}" \) | sort | jq -R -s 'split("\n") | map(select(. != ""))')

jq -n \
  --arg docsPath "$DOCS_PATH" \
  --argjson sourcePaths "$SOURCE_PATHS" \
  --arg outputFile "$OUTPUT_FILE" \
  --argjson concurrent "$CONCURRENT" \
  --argjson files "$FILES_JSON" \
  --arg startTime "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    docsPath: $docsPath,
    sourcePaths: $sourcePaths,
    outputFile: $outputFile,
    concurrentAgents: $concurrent,
    filesToCheck: $files,
    checkedFiles: [],
    pendingFiles: $files,
    startTime: $startTime
  }' > "$STATE_FILE"

echo "Initialized with $(echo "$FILES_JSON" | jq length) files"
```

#### .fact-check/next-file.sh

```bash
#!/usr/bin/env bash
# Usage: next-file.sh <state-file> [--batch N]
# Prints next pending file(s), one per line. Exit 1 if none remain.
set -euo pipefail
STATE_FILE="$1"; shift
BATCH=1
while [[ $# -gt 0 ]]; do
  case "$1" in --batch) BATCH="$2"; shift 2 ;; *) shift ;; esac
done
PENDING=$(jq -r ".pendingFiles[:$BATCH][]" "$STATE_FILE")
[[ -z "$PENDING" ]] && exit 1
echo "$PENDING"
```

#### .fact-check/mark-done.sh

```bash
#!/usr/bin/env bash
# Usage: mark-done.sh <state-file> <action> <filename>
# Actions: mark-checked, mark-fixed
set -euo pipefail
STATE_FILE="$1"; ACTION="$2"; FILENAME="$3"
TEMP=$(mktemp "${STATE_FILE}.XXXXXX")
case "$ACTION" in
  mark-checked)
    jq --arg f "$FILENAME" \
      '.pendingFiles -= [$f] | .checkedFiles += [$f] | .checkedFiles |= unique' \
      "$STATE_FILE" > "$TEMP" ;;
  mark-fixed)
    jq --arg f "$FILENAME" \
      '.pendingFiles -= [$f] | .fixedFiles += [$f] | .fixedFiles |= unique' \
      "$STATE_FILE" > "$TEMP" ;;
  *) echo "Unknown action: $ACTION" >&2; rm -f "$TEMP"; exit 1 ;;
esac
mv "$TEMP" "$STATE_FILE"
```

#### .fact-check/init-fix-state.sh

Created here so fact-fix can use it later. Scans findings to build fix state.

```bash
#!/usr/bin/env bash
# Usage: init-fix-state.sh <state-file> <mode> <concurrent>
# mode: auto-apply or preview
set -euo pipefail
STATE_FILE="$1"; MODE="$2"; CONCURRENT="$3"

FINDINGS_DIR=".fact-check/findings"
[[ ! -d "$FINDINGS_DIR" ]] && echo "No findings. Run /fact-check first." >&2 && exit 1

# Extract original paths from <!-- source: path --> metadata line
FILES_JSON=$(for f in "$FINDINGS_DIR"/*.md; do
  sed -n 's/^<!-- source: \(.*\) -->$/\1/p' "$f"
done | jq -R -s 'split("\n") | map(select(. != ""))')

jq -n \
  --arg findingsDir "$FINDINGS_DIR" \
  --arg mode "$MODE" \
  --argjson concurrent "$CONCURRENT" \
  --argjson files "$FILES_JSON" \
  --arg startTime "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    findingsDir: $findingsDir,
    fixesDir: ".fact-check/fixes",
    mode: $mode,
    concurrentAgents: $concurrent,
    filesToFix: $files,
    fixedFiles: [],
    pendingFiles: $files,
    startTime: $startTime
  }' > "$STATE_FILE"

echo "Initialized with $(echo "$FILES_JSON" | jq length) files to fix"
```

Make all scripts executable:

```bash
chmod +x .fact-check/init-state.sh .fact-check/next-file.sh .fact-check/mark-done.sh .fact-check/init-fix-state.sh
```

### Step 3: Initialize State

Run the init script with user-provided config:

```bash
bash .fact-check/init-state.sh .fact-check/state.json \
  "<docs-path>" "md,mdx" '["<source1>","<source2>"]' <N> "<output-file>"
```

The script discovers all doc files and writes `state.json`. The main agent **never loads the file list**.

**If resuming**: Skip Steps 2-3. The state file and scripts already exist. Read only the config:

```bash
jq '{docsPath, sourcePaths, outputFile, concurrentAgents}' .fact-check/state.json
```

### Step 4: Agent Loop

**⚠️ CRITICAL RULE: 1 Agent = 1 File**

Loop until `next-file.sh` returns nothing:

1. **Get next batch**:

   ```bash
   bash .fact-check/next-file.sh .fact-check/state.json --batch <N>
   ```

2. **For each file**, compute safe name and spawn an agent:

   ```
   safeName = file with / → _ and .md/.mdx extension removed
   ```

   ```typescript
   Task({
     subagent_type: 'general-purpose',
     description: `Fact-check ${file}`,
     prompt: `
   FACT-CHECK TASK
   
   Documentation file: ${file}
   Source paths: ${sourcePaths}
   Findings output: .fact-check/findings/${safeName}.md
   
   INSTRUCTIONS:
   1. Read the documentation file completely
   2. Identify all factual claims, code references, API descriptions
   3. Verify each claim against source code in the source paths
   4. Write findings to the output file using the Write tool
   5. DO NOT report findings back to me — just write to the file
   
   OUTPUT FORMAT (write this exactly to the output file):
   <!-- source: ${file} -->
   # 📄 File: ${file}
   
   > <brief summary of findings>
   
   ### 🔴 Source Code Inaccuracies
   (for each: Documented | Actual | file:line evidence)
   
   ### 🟡 Documentation Issues
   (for each: Problem | Location | Fix)
   
   ### 🟠 Other Problems
   (for each: Problem | Recommendation)
   
   ## Summary
   | Category | Count |
   |----------|-------|
   | 🔴 | <n> |
   | 🟡 | <n> |
   | 🟠 | <n> |
   
   When done, respond: "Done"
   `,
     run_in_background: true,
   });
   ```

3. **For each spawned agent** (sequentially):

   ```
   a. TaskOutput(agent_id) — wait for completion
   b. bash .fact-check/mark-done.sh .fact-check/state.json mark-checked <filename>
   ```

4. Go back to step 1 if `next-file.sh` returns more files.

### Step 5: Aggregate Findings

After all agents complete, read finding files and build the final report:

```bash
ls .fact-check/findings/*.md
```

**Main agent reads each file and builds the final report:**

1. Read each `.fact-check/findings/*.md` file
2. Extract summary counts from each
3. Build overall summary table
4. Concatenate all findings into final report

```markdown
# Fact Check Report

> Generated: <date>
> Docs: <docs-path> (<X> files)
> Sources: <source-paths>
> Agents: <n> concurrent

## Overall Summary

| Category                    | Total Issues |
| --------------------------- | ------------ |
| 🔴 Source Code Inaccuracies | <total>      |
| 🟡 Documentation Issues     | <total>      |
| 🟠 Other Problems           | <total>      |

## Files Checked

| File     | 🔴  | 🟡  | 🟠  | Total |
| -------- | --- | --- | --- | ----- |
| file1.md | 2   | 1   | 0   | 3     |
| file2.md | 0   | 3   | 1   | 4     |

---

<concatenate contents of each .fact-check/findings/\*.md file here>
```

5. Write final report to `outputFile` location

## Template Reference

See [templates/inaccuracy-report.md](templates/inaccuracy-report.md) for the full output template.

## Tips

- **Respect rate limits**: Don't spawn too many agents if API-limited
- **Multi-repo handling**: Pass all source paths to each agent
- **Glob patterns**: Adjust for your doc structure (`.md`, `.mdx`, etc.)
- **Evidence required**: Every source code inaccuracy MUST include file:line reference
- **Findings persist**: `.fact-check/findings/` survives context loss — agents never redo completed work
