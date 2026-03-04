---
name: { SKILL_NAME }
description: '{DESCRIPTION}. Use when running /{SKILL_NAME}.'
argument-hint: '[TARGET_PATH] [--output OUTPUT_FILE] [--agents N]'
---

# {SKILL_TITLE}

{DESCRIPTION}

## When to Use

- Running `/{SKILL_NAME}`
  {USE_CASES}

## Context Resumption

If context is lost, check whether pending files remain:

```bash
bash <skill-dir>/scripts/next-file.sh .{SKILL_NAME}/state.json
```

If output is non-empty, work remains. Read config to resume:

```bash
jq '{sourcePaths, outputFile, concurrentAgents}' .{SKILL_NAME}/state.json
```

**Resume by running `/{SKILL_NAME}` again** — the scripts track all progress.

## Process

> **`<skill-dir>`** refers to the directory containing this SKILL.md. Resolve it once at the start and reuse throughout.

### Step 1: Collect Configuration

Use `AskUserQuestion` to gather:

1. **Target Path**: Where are the files to process?
2. **Source Paths**: What sources should agents reference?
3. **Concurrent Agents**: How many in parallel? (default: {DEFAULT_CONCURRENT})
4. **Output File**: Where to save the report? (default: `{DEFAULT_OUTPUT}`)

### Step 2: Create Working Directory

```bash
mkdir -p .{SKILL_NAME}/findings
echo '*' > .{SKILL_NAME}/.gitignore
```

### Step 3: Initialize State

Discover files matching `{FILE_EXTENSIONS}` under the target path. Exclude irrelevant directories (vendored code, build artifacts, etc.) as appropriate for the project.

Pipe the file list into `init-state.sh`:

```bash
<file-discovery-command> | bash <skill-dir>/scripts/init-state.sh .{SKILL_NAME}/state.json \
  '["<source1>","<source2>"]' <N> "<output-file>"
```

**If resuming**: Skip steps 2-3. State already exists.

### Step 4: Agent Loop

**1 Agent = 1 File.** Loop until `next-file.sh` returns nothing:

1. **Get next batch**:

   ```bash
   bash <skill-dir>/scripts/next-file.sh .{SKILL_NAME}/state.json --batch <N>
   ```

2. **For each file**, compute safe name and spawn an agent:

   ```
   safeName = filename with / replaced by _ and extension removed
   ```

   ```typescript
   Task({
     subagent_type: 'general-purpose',
     description: `Process ${file}`,
     prompt: `
   {SKILL_TITLE} TASK
   
   File: ${file}
   Source paths: ${sourcePaths}
   Findings output: .{SKILL_NAME}/findings/${safeName}.md
   
   INSTRUCTIONS:
   {PROCESSING_INSTRUCTIONS}
   
   OUTPUT FORMAT:
   {OUTPUT_FORMAT}
   
   Write findings to the output file using the Write tool.
   When done, respond: "Done"
   `,
     run_in_background: true,
   });
   ```

3. **Collect results** (sequentially):

   ```
   a. TaskOutput(agent_id) — wait for completion
   b. Verify .{SKILL_NAME}/findings/${safeName}.md exists and is non-empty
   c. If missing — log warning, do NOT mark done (file stays pending for retry)
   d. If exists — bash <skill-dir>/scripts/mark-done.sh .{SKILL_NAME}/state.json <filename>
   ```

4. Repeat from step 1 if `next-file.sh` returns more files.

### Step 5: Aggregate Findings

After all agents complete:

```bash
ls .{SKILL_NAME}/findings/*.md
```

Read each findings file, build the final report using [templates/output.md](templates/output.md), and write it to the output file.

## Example Agent Output

Below is an example of what a single agent's findings file (`.{SKILL_NAME}/findings/some_file.md`) should look like:

{EXAMPLE_OUTPUT}

## Tips

- **Findings persist**: `.{SKILL_NAME}/findings/` survives context loss
- **Respect rate limits**: Don't spawn too many agents at once
- **Progress is tracked**: Re-running the skill resumes from where it left off
