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

If context is lost during the fact-check process, check `.kagent/fact-check-state.json` to resume:

```bash
cat .kagent/fact-check-state.json
```

The state file contains:

- `docsPath`: Documentation path being checked
- `sourcePaths`: Source code paths to verify against
- `outputFile`: Where to save the report
- `filesToCheck`: List of all doc files to verify
- `checkedFiles`: Files already processed
- `pendingFiles`: Files waiting to be checked
- `concurrentAgents`: Max parallel agents

**Resume by running `/fact-check` again** — the orchestrator reads the state and continues from where it left off.

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

### Step 2: Initialize State File

Create `.fact-check/state.json` to track progress:

```json
{
  "docsPath": "<docs-path>",
  "sourcePaths": ["<path1>", "<path2>"],
  "outputFile": "<output-file>",
  "concurrentAgents": <n>,
  "filesToCheck": [],
  "checkedFiles": [],
  "pendingFiles": [],
  "startTime": "<iso-timestamp>"
}
```

**If resuming:** Read `.fact-check/state.json` first. If `pendingFiles` is non-empty, continue from Step 5 (spawn agents for pending files). Otherwise, start from Step 3.

### Step 3: Discover Documentation Files

Use `Glob` to find all documentation files:

```bash
# Common patterns
**/*.md
**/*.mdx
docs/**/*.md
content/**/*.mdx
```

Create a list of all files to check. Update state file with `filesToCheck` and `pendingFiles`.

### Step 4: Spawn Parallel Agents

**⚠️ CRITICAL RULE: 1 Agent = 1 File**

Each agent checks exactly ONE documentation file. This ensures:

- Thorough analysis of each file
- Clear attribution of findings
- Better accuracy and completeness

Spawn agents using the `Task` tool with `subagent_type: "general-purpose"`:

```typescript
// For each file, spawn a separate agent
files.forEach(file => {
  Task({
    subagent_type: 'general-purpose',
    description: `Fact-check ${file}`,
    prompt: `...`,
    run_in_background: true, // Run in parallel
  });
});
```

### Step 5: Update State & Spawn Next Batch

Before spawning, update state file:

```json
{
  "pendingFiles": ["file1.md", "file2.md", ...],
  "checkedFiles": [],
  "currentBatch": ["file1.md", "file2.md", "file3.md"]
}
```

Spawn up to `concurrentAgents` agents from `pendingFiles`. After spawning:

1. Move spawned files from `pendingFiles` to a temporary "in-flight" list
2. Wait for batch to complete
3. Move completed files to `checkedFiles`
4. Repeat until `pendingFiles` is empty

### Step 6: Agent Instructions

Each agent receives these instructions:

```
You are fact-checking: <doc-file>

Source code paths: <source-paths>

Your task:
1. Read the documentation file completely
2. Identify all claims, code references, API descriptions, configuration examples
3. For EACH claim:
   - Search the source code to verify
   - Check if function/class/variable exists
   - Verify parameters, return types, behavior
   - Check links and references

4. Categorize issues into:
   - 🔴 SOURCE CODE INACCURACIES: Docs don't match actual code
   - 🟡 DOCUMENTATION ISSUES: Broken links, typos, outdated refs
   - 🟠 OTHER PROBLEMS: Empty sections, formatting, unclear content

5. IGNORE:
   - Stylistic preferences
   - Minor grammar issues
   - Subjective improvements

6. Output findings using this template for EACH file:

---
# 📄 File: <path>

> <brief summary of issues found>

### 🔴 Source Code Inaccuracies

#### 1. <Issue Title>

| Aspect | Details |
|--------|---------|
| **Documented** | `<what docs say>` |
| **Actual** | `<what code does>` |
| **Evidence** | `[repo@path:lines]` |

### 🟡 Documentation Issues

#### 1. <Issue Title>

| Aspect | Details |
|--------|---------|
| **Problem** | `<description>` |
| **Location** | `<where>` |
| **Fix** | `<resolution>` |

### 🟠 Other Problems

#### 1. <Issue Title>

| Aspect | Details |
|--------|---------|
| **Problem** | `<description>` |
| **Recommendation** | `<suggestion>` |

## Summary

| Category | Count |
|----------|-------|
| 🔴 Source Code Inaccuracies | <n> |
| 🟡 Documentation Issues | <n> |
| 🟠 Other Problems | <n> |
---
```

### Step 7: Aggregate Results

1. Wait for all agents to complete
2. Collect all reports
3. Merge into single output file
4. Add overall summary at the top:

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

<individual file reports follow>
```

## Template Reference

See [templates/inaccuracy-report.md](templates/inaccuracy-report.md) for the full output template.

## Tips

- **Respect rate limits**: Don't spawn too many agents if API-limited
- **Multi-repo handling**: Pass all source paths to each agent
- **Glob patterns**: Adjust for your doc structure (`.md`, `.mdx`, etc.)
- **Evidence required**: Every source code inaccuracy MUST include file:line reference
