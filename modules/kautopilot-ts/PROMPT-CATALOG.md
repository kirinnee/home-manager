# kautopilot prompt catalog

This catalogs the prompt surfaces currently embedded in `modules/kautopilot-ts`.
Use it as the migration map for moving prompt behavior into Codex/Claude skills
and leaving `kautopilot` as orchestration/state machinery.

## Prompt resolution model

- Configurable agent prompts live in `src/core/types.ts` under
  `DEFAULT_CONFIG.agents` and are resolved by `getAgentPrompt()` in
  `src/core/agents.ts`.
- TTY phases usually prepend hard-coded mechanics before the configurable
  prompt. These mechanics enforce artifact paths, approval events, and snapshot
  rules.
- Reviewer prompts are configured under `phase1.spec_reviewers` and
  `phase1.plan_reviewers`, then executed by `src/core/review-runner.ts`.
- kloop prompts are embedded under `DEFAULT_CONFIG.kloop.prompts`.
- A few one-off LLM prompts bypass the configurable agent registry; those are
  called out separately.

## High-priority skill candidates

These prompts are user-facing workflows and should become first-class skills.

| Skill candidate          | Current prompt ids                                                                                                | Sources                                                    | Variables/context                                                                                                                                        | Notes                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `kautopilot-triage`      | `agents.phase1.triage` plus `TRIAGE_MECHANICS` and `TRIAGE_APPROVAL_GATE`                                         | `src/core/types.ts`, `src/phases/phase1/triage.ts`         | `{ticket}`, `{triage}`, `{specDir}`, triage template                                                                                                     | Interactive TTY skill. Must preserve explicit approval and `kautopilot log-event triage:approved`.     |
| `kautopilot-spec-writer` | `agents.phase1.spec_writer` plus `SPEC_MECHANICS` and `SPEC_APPROVAL_PROTOCOL`                                    | `src/core/types.ts`, `src/phases/phase1/write-spec.ts`     | `{ticket}`, `{triage}`, `{spec}`, `{specDir}`, spec template, previous feedback/amendment paths                                                          | Interactive TTY skill. Must preserve in-place working copy and `kautopilot snapshot spec`.             |
| `kautopilot-plan-writer` | `agents.phase1.plan_writer` plus `PLAN_MECHANICS` and `PLAN_APPROVAL_PROTOCOL`                                    | `src/core/types.ts`, `src/phases/phase1/write-plans.ts`    | `{spec}`, `{triage}`, `{plans}`, plan template, previous feedback/plans paths                                                                            | Interactive TTY skill. Must preserve `kautopilot snapshot plans` and spec-amendment escalation.        |
| `kautopilot-resolve`     | `agents.phase2.resolve` plus `RESOLVE_MECHANICS`                                                                  | `src/core/types.ts`, `src/phases/phase2/resolve.ts`        | `{task_spec_path}`, `{plan_path}`, `{plans_dir}`, `{kloop_evidence}`, `{plan_name}`, `{reason}`, `{attempt}`, `{feedback_path}`, `{resolution_path}`     | Interactive strategy-selection skill. Outputs either retry/revisit-spec or a plan-resolution document. |
| `kautopilot-amend-plans` | `agents.phase2.amend_plans` plus strategy prompts                                                                 | `src/core/types.ts`, `src/phases/phase2/amend-plans.ts`    | `{resolution_path}`, `{task_spec_path}`, `{plans_dir}`, `{kloop_evidence}`, `{plan_name}`, `{plan_path}`, completed/incomplete plan lists, plan template | One skill with strategy modes: `refine_local`, `patch_downstream`, `regenerate_remaining`.             |
| `kautopilot-feedback`    | `agents.phase3.feedback` plus `FEEDBACK_MECHANICS`                                                                | `src/core/types.ts`, `src/phases/phase3/feedback-check.ts` | `{task_spec_path}`, `{plans_dir}`, `{pr_url}`, `{checks_status}`, `{thread_count}`, `{feedback_path}`                                                    | Interactive PR feedback skill that writes `feedback.md` and logs `feedback:approved`.                  |
| `kautopilot-tty-resolve` | `agents.phase3.tty_resolve_ambiguous`, `tty_resolve_conflict`, `tty_resolve_failure` plus `TTY_RESOLVE_MECHANICS` | `src/core/types.ts`, `src/phases/phase3/tty-resolve.ts`    | reason-specific context, spec path, plan paths, feedback path, ambiguous items or conflict files                                                         | Could be one skill with three modes. Preserve `tty_resolve:approved` event contract.                   |

## Medium-priority skill candidates

These are non-interactive agent tasks. They can become skills, but the CLI can
also keep calling them as configured prompts during transition.

| Skill candidate                     | Current prompt ids                                                                 | Sources                                                                                                                | Variables/context                                                                                                                                                                                           | Notes                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `kautopilot-init-local`             | `agents.init.localInit`                                                            | `src/core/types.ts`, `src/phases/init/states.ts`                                                                       | `{sessionId}`                                                                                                                                                                                               | Generates local `ticket.md`, `task-spec.md`, and initial plans.                                                        |
| `kautopilot-ticket-system-research` | `agents.init.researchTicketSystem`; hard-coded research parser                     | `src/core/types.ts`, `src/phases/init/states.ts`, `src/core/scripts.ts`                                                | `{taskSystem}`, `{detectedInfo}`                                                                                                                                                                            | Split into research skill plus parser/output schema. Current parser prompt is hard-coded.                              |
| `kautopilot-ticket-setup`           | `agents.init.researchSetup`                                                        | `src/core/types.ts`, `src/phases/init/states.ts`, `src/core/scripts.ts`                                                | `{taskSystem}`, `{accessMethod}`                                                                                                                                                                            | Produces setup/auth instructions for a task system.                                                                    |
| `kautopilot-ticket-scripts`         | `agents.init.createScripts`; repair-context suffix                                 | `src/core/types.ts`, `src/phases/init/states.ts`, `src/core/scripts.ts`                                                | `{taskSystem}`, `{accessMethod}`, `{stateMapping}`, `{transitionNoOp}`, `{branch}`, `{scriptsDir}`, `{quirks}`, `{setupAssessment}`, `{researchDoc}`, `{detectedInfo}`, `{scriptList}`, `{optionalScripts}` | Skill should include bounded repair mode for failing `extract-ticket`/`get-ticket`.                                    |
| `kautopilot-pr-eval`                | `agents.phase3.eval` plus `EVAL_MECHANICS` and output schema                       | `src/core/types.ts`, `src/phases/phase3/eval.ts`                                                                       | `{spec_path}`, `{plan_paths}`, ticket id, one feedback item                                                                                                                                                 | Fan-out JSON decision task: `reply`, `resolve`, or `code_fix`.                                                         |
| `kautopilot-write-fix`              | `agents.phase3.write_fix` plus `WRITE_FIX_MECHANICS`                               | `src/core/types.ts`, `src/phases/phase3/write-fix.ts`                                                                  | spec path, plan paths, feedback path, evaluated fixes                                                                                                                                                       | Produces a merged implementation spec for another kloop run.                                                           |
| `kautopilot-create-pr`              | `agents.phase3.create_pr` plus `CREATE_PR_MECHANICS`                               | `src/core/types.ts`, `src/phases/phase3/create-pr.ts`                                                                  | `{baseBranch}`, `{ticketId}`, `{spec_path}`                                                                                                                                                                 | Discovers PR conventions and runs `gh pr create`; outputs PR JSON.                                                     |
| `kautopilot-prereview`              | `agents.phase3.prereview_classify`, `agents.phase3.prereview_fix`, inline wrappers | `src/core/types.ts`, `src/phases/phase3/prereview.ts`                                                                  | CodeRabbit output, classified fixes                                                                                                                                                                         | Could be one skill with classify/apply submodes. Also has a hard-coded one-line commit-message prompt.                 |
| `kautopilot-ticket-draft`           | hard-coded `draftPrompt`                                                           | `src/phases/phase3/ticket-draft.ts`                                                                                    | completed spec content, original ticket content                                                                                                                                                             | Should become a delivery-artifact skill for ticket-only tasks.                                                         |
| `kautopilot-commit`                 | `agents.generic.commit`                                                            | `src/core/types.ts`, `src/phases/phase2/commit.ts`, `src/phases/phase3/push.ts`, `src/phases/phase3/commit-pending.ts` | `{context}`                                                                                                                                                                                                 | Shared commit skill. Existing prompt discovers conventions, stages specific files, handles hook failures, outputs SHA. |

## Review skills

These are small review prompts. They can be separate skills, one multi-mode
`kautopilot-spec-review` skill, or left as prompt data behind a review runner.

### Spec reviewers

Defined in `DEFAULT_CONFIG.agents.phase1.spec_reviewers` in
`src/core/types.ts`.

| Reviewer                  | Purpose                                                                      | Inputs               |
| ------------------------- | ---------------------------------------------------------------------------- | -------------------- |
| `completeness`            | Check every ticket requirement is covered by the spec.                       | `{spec}`, `{ticket}` |
| `docs_accuracy`           | Check referenced tool versions, APIs, and signatures against the codebase.   | `{spec}`, `{ticket}` |
| `generalization`          | Check whether the spec extends local patterns instead of inventing new ones. | `{spec}`             |
| `complexity`              | Check whether the proposed approach is unnecessarily complex.                | `{spec}`             |
| `security`                | Check security/compliance concerns.                                          | `{spec}`             |
| `proof_of_completion`     | Check for concrete, testable acceptance criteria.                            | `{spec}`             |
| `nonfunctional_checklist` | Check every non-functional checklist item is evaluated.                      | `{spec}`             |
| `verification_evidence`   | Check triage assumptions have concrete evidence in the spec.                 | `{spec}`, `{triage}` |

### Plan reviewers

Defined in `DEFAULT_CONFIG.agents.phase1.plan_reviewers` in
`src/core/types.ts`.

| Reviewer         | Purpose                                                                     | Inputs              |
| ---------------- | --------------------------------------------------------------------------- | ------------------- |
| `coverage`       | Check all spec requirements are covered by the plans.                       | `{plans}`, `{spec}` |
| `ordering`       | Check plan dependencies are ordered correctly.                              | `{plans}`           |
| `vertical_split` | Check plans are vertical, committable slices rather than horizontal layers. | `{plans}`           |
| `cost`           | Check cost/resource implications are addressed.                             | `{plans}`, `{spec}` |
| `spec_adherence` | Check no spec drift, omissions, or scope creep.                             | `{plans}`, `{spec}` |

### Review summarizer

`src/core/review-runner.ts` contains a hard-coded `summaryPrompt` that
deduplicates reviewer outputs into a numbered problem list. If reviewers become
skills, this should either become `kautopilot-review-summarizer` or be folded
into the review-runner skill.

## kloop prompt bundle

These live in `DEFAULT_CONFIG.kloop.prompts` in `src/core/types.ts` and are
passed through to kloop configuration.

| Prompt id          | Current constant                         | Role                                                                     | Skill candidate            |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------ | -------------------------- |
| `implementer`      | `DEFAULT_KLOOP_IMPLEMENTER_PROMPT`       | Implements the spec, writes evidence and learnings, respects git safety. | `kloop-implementer`        |
| `reviewer`         | `DEFAULT_KLOOP_REVIEWER_PROMPT`          | Reviews diff against spec/evidence and writes review/verdict artifacts.  | `kloop-reviewer`           |
| `checkpointer`     | `DEFAULT_KLOOP_CHECKPOINTER_PROMPT`      | Detects spec-level conflicts after failed consensus.                     | `kloop-conflict-detector`  |
| `checkpointerFull` | `DEFAULT_KLOOP_CHECKPOINTER_FULL_PROMPT` | Fuller checkpoint/progress analysis after failed consensus.              | `kloop-checkpointer`       |
| `synthesizer`      | `DEFAULT_KLOOP_SYNTHESIZER_PROMPT`       | Deduplicates and prioritizes multi-review feedback.                      | `kloop-review-synthesizer` |
| `verifier`         | `DEFAULT_KLOOP_VERIFIER_PROMPT`          | Verifies whether reviewer findings are valid.                            | `kloop-verifier`           |
| `reSynthesizer`    | `DEFAULT_KLOOP_RE_SYNTHESIS_PROMPT`      | Re-synthesizes after verifier pass.                                      | `kloop-re-synthesizer`     |

## Templates

These are not prompts, but prompt mechanics inject them and skill migrations
must preserve them.

| Template                                       | Source              | Used by                                    |
| ---------------------------------------------- | ------------------- | ------------------------------------------ |
| `templates.triage` / `DEFAULT_TRIAGE_TEMPLATE` | `src/core/types.ts` | `TRIAGE_MECHANICS`                         |
| `templates.spec` / `DEFAULT_SPEC_TEMPLATE`     | `src/core/types.ts` | `SPEC_MECHANICS`                           |
| `templates.plan` / `DEFAULT_PLAN_TEMPLATE`     | `src/core/types.ts` | `PLAN_MECHANICS`, Phase 2 amend strategies |

## Utility and plumbing prompts

These should generally remain code-owned unless there is a strong reason to
customize them.

| Prompt                                     | Source                           | Purpose                                                        | Migration recommendation                                                                |
| ------------------------------------------ | -------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Research parser prompt                     | `src/phases/init/states.ts`      | Converts ticket-system research markdown into structured JSON. | Keep as schema-bound utility or fold into ticket-system-research skill output contract. |
| Script repair suffix                       | `src/phases/init/states.ts`      | Adds failure details for script regeneration attempts.         | Fold into `kautopilot-ticket-scripts` repair mode.                                      |
| CodeRabbit commit message prompt           | `src/phases/phase3/prereview.ts` | Generates a short commit message for prereview fixes.          | Replace with `generic.commit` or `kautopilot-commit` skill; avoid one-off prompt.       |
| `spawnPrintToFile` JSON output-file suffix | `src/llm/spawn.ts`               | Forces JSON response to be written to a known output path.     | Keep in runner plumbing; it is transport protocol, not agent behavior.                  |
| Claude config-dir probe                    | `src/core/config-dir.ts`         | Asks a Claude binary to print `CLAUDE_CONFIG_DIR`.             | Keep as code-owned probe.                                                               |

## Suggested migration sequence

1. Extract Phase 1 TTY workflows first: triage, spec writer, plan writer.
   These are the highest-leverage and already look like skills.
2. Extract Phase 2 repair workflows: resolve and amend-plans. Keep strategy
   decisions explicit and preserve event/snapshot contracts.
3. Extract Phase 3 PR workflows: eval, write-fix, feedback, tty-resolve,
   create-pr, prereview.
4. Convert review prompts into either one multi-mode review skill or small
   per-reviewer skills.
5. Convert kloop prompt bundle into skills only after deciding whether kloop
   itself will call skills directly or whether kautopilot will materialize skill
   instructions into kloop prompt config.

## Open design decisions

- Skills should probably own human-facing behavior, while `kautopilot` continues
  to own event names, artifact paths, restart loops, and snapshot validation.
- Several mechanics prompts contain operational contracts. When moving to
  skills, either keep these as runner-prepended contract blocks or duplicate
  them verbatim in each skill. Runner-prepended contracts reduce drift.
- The current config supports org/session prompt overrides. A skill-based system
  needs an equivalent override story: skill selection, skill shadowing, or
  repo-local skill directories.
- Some prompts inline large content (`ticket_draft`, research parser), while
  newer prompts prefer file paths. Skill conversion should standardize on paths
  where possible.
