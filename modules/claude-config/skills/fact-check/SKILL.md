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
bash <skill-dir>/scripts/next-file.sh .fact-check/state.json
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

### Step 2: Create Working Directory

```bash
mkdir -p .fact-check/findings
```

Scripts are shipped in this skill's `scripts/` subfolder. Determine the skill directory path (the folder containing this SKILL.md) and use it for all script references below as `<skill-dir>`.

### Step 3: Initialize State

Run the init script with user-provided config:

```bash
bash <skill-dir>/scripts/init-state.sh .fact-check/state.json \
  "<docs-path>" "md,mdx" '["<source1>","<source2>"]' <N> "<output-file>"
```

The script discovers all doc files and writes `state.json`. The main agent **never loads the file list**.

**If resuming**: Skip Steps 2-3. The state file already exists. Read only the config:

```bash
jq '{docsPath, sourcePaths, outputFile, concurrentAgents}' .fact-check/state.json
```

### Step 4: Agent Loop

**⚠️ CRITICAL RULE: 1 Agent = 1 File**

Loop until `next-file.sh` returns nothing:

1. **Get next batch**:

   ```bash
   bash <skill-dir>/scripts/next-file.sh .fact-check/state.json --batch <N>
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
   b. bash <skill-dir>/scripts/mark-done.sh .fact-check/state.json mark-checked <filename>
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
