# Phase 3: Verify (File-Processor Pattern)

## State Machine

```
[init_verify] → [verify_loop] → [triage]
   inline         file-proc(S)    team(S)
```

## State File: `verify-state.json`

```json
{
  "step": "init_verify | verify_loop | triage | completed",
  "pendingFiles": ["thread-01-slug.md", ...],
  "verifiedFiles": []
}
```

## Step Dispatch

| Step          | Agent        | Model  | Type      | File                             | Description                                     |
| ------------- | ------------ | ------ | --------- | -------------------------------- | ----------------------------------------------- |
| `init_verify` | —            | —      | inline    | —                                | Discover findings, init verify state via script |
| `verify_loop` | verify-agent | sonnet | file-proc | `verify/steps/verify-finding.md` | Independent verification per thread             |
| `triage`      | triage-agent | sonnet | team      | —                                | Summarize verification results                  |

## Step Dispatch Logic

| Condition              | Action                                                        |
| ---------------------- | ------------------------------------------------------------- |
| No `verify-state.json` | Create it with `step: "init_verify"`, run init inline         |
| `step: "init_verify"`  | Run init inline (see below)                                   |
| `step: "verify_loop"`  | Run file-processor loop (see below)                           |
| `step: "triage"`       | Spawn triage-agent (sonnet)                                   |
| `step: "completed"`    | Phase done — advance `task-state.currentPhase` to `"compose"` |

### Inline: init_verify step

1. Discover all finding files:
   ```bash
   ls research/findings/thread-*.md
   ```
2. Pipe the file list into the init script:
   ```bash
   ls research/findings/thread-*.md | bash <skill-dir>/verify/scripts/init-verify.sh .research/verify-state.json
   ```
3. `verify-state.json` is now populated with `pendingFiles` and `step: "verify_loop"`
4. Continue to verify_loop dispatch

### File-Processor: verify_loop step

**1 Agent = 1 Thread file.** Loop until `next-file.sh` returns nothing:

1. **Get next batch** (up to 3 concurrent):

   ```bash
   bash <skill-dir>/verify/scripts/next-file.sh .research/verify-state.json --batch 3
   ```

2. **For each file**, spawn a verify-agent:
   - Compute safe output name: replace `/` with `_`, strip `research/findings/` prefix
   - Output goes to `research/verification/{same-filename}`

   ```
   Task({
     subagent_type: 'general-purpose',
     model: 'sonnet',
     description: `Verify ${file}`,
     prompt: `
   VERIFICATION TASK

   Read the step file at <skill-dir>/verify/steps/verify-finding.md and follow its instructions.

   Finding file: ${file}
   Verification output: research/verification/${basename}
   Reputation system: <skill-dir>/common/reputation-system.md
   Verification template: <skill-dir>/templates/verification-template.md

   When done, respond: "Done"
   `,
     run_in_background: true,
   })
   ```

3. **Collect results** (sequentially):
   - `TaskOutput(agent_id)` — wait for completion
   - Verify `research/verification/${basename}` exists
   - If exists: `bash <skill-dir>/verify/scripts/mark-done.sh .research/verify-state.json <filename>`
   - If missing: log warning, file stays pending for retry

4. Repeat from step 1 if more pending files.

5. When all files verified, update state: `step: "triage"`

### Inline: triage step

Spawn a triage-agent (sonnet) that:

1. Reads ALL files in `research/verification/`
2. Summarizes:
   - Total claims verified vs unverifiable vs contradicted
   - Low-confidence threads flagged
   - Reputation score adjustments
3. Reports summary to orchestrator

After triage report received, update state to `step: "completed"`.

## State Transitions

The verify phase uses **shell scripts** for file-processor state management instead of a state agent. The orchestrator calls the scripts directly.

**Bootstrap exceptions:** The orchestrator runs `init-verify.sh` directly during the `init_verify` step.

## Phase Completion

When `step: "completed"`:

1. Update `task-state.json`: `currentPhase: "compose"`
2. Create `compose-state.json`: `{"step": "synthesize"}`
3. Log transition
