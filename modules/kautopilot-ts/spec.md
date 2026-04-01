# kautopilot Specification

## 1. Purpose

kautopilot is a session-based orchestrator for taking a task from intake to completion through a three-phase workflow:

1. Phase 1: write and approve the contract
2. Phase 2: execute approved plans through kloop
3. Phase 3: deliver through a primary endpoint and babysit that endpoint until completion

kautopilot is not itself the implementation loop. For implementation work, kloop is the execution backend.

---

## 2. Core model

### 2.1 Spec vs plan

The system distinguishes between two different kinds of artifacts:

- **Spec**: declarative, idempotent, describes **WHAT** should be true
- **Plans**: imperative, procedural, describe **HOW** to move from the current state to the desired state

A new epoch rewrites the declarative contract. A rewritten plan stays inside the same epoch unless the declarative contract itself changed.

### 2.2 Contract epoch

A contract epoch is versioned as `vN`.

Each epoch defines:

- the approved declarative spec
- the approved plan set
- the primary delivery kind
- any supporting ticket-side actions implied by the contract

At any point, exactly one contract epoch is active.

### 2.3 Delivery kind

Each epoch has exactly one primary delivery kind:

- `pr`
- `ticket`

There is no separate `report` delivery kind.

If a report is needed, it is treated as a ticket artifact: attached, linked, or commented onto the ticket system.

### 2.4 Primary delivery vs supporting side effects

The primary delivery kind defines what it means for the epoch to complete.

Supporting side effects may still occur, for example:

- a `pr` epoch may update the ticket with links or comments
- a `ticket` epoch may create downstream linked tickets or attach artifacts

These are not separate delivery kinds.

---

## 3. The three phases

### 3.1 Phase 1: contract writing

Phase 1 is responsible for producing an approved contract.

It must:

- clarify ambiguity before deep research
- detect conflicting requirements
- write the high-level declarative spec
- choose the primary delivery kind for the epoch
- decompose the work into plan units
- attach proof requirements, dependencies, and strategy hints to each plan
- optionally mutate the current ticket or propose/create downstream ticket outputs when the contract requires it

Phase 1 output is the frozen contract for `vN`.

### 3.2 Phase 2: plan execution

Phase 2 executes the approved plans for the active epoch.

Phase 2 is a plan/workset orchestrator that delegates implementation execution to kloop.

It may:

- execute one approved plan at a time
- run bounded parallel worksets when the plan strategy requires divide-and-conquer
- persist progress, handoffs, and rewrites durably

Phase 2 does not redefine the declarative contract. If the declarative contract is wrong, Phase 2 must escalate back to Phase 1 through a new epoch.

### 3.3 Phase 3: delivery and babysitting

Phase 3 delivers the active epoch through its primary delivery endpoint.

If the primary delivery kind is `pr`, Phase 3 is PR-native and keeps the current babysitting loop:

- prereview
- poll
- eval
- act
- push

If the primary delivery kind is `ticket`, Phase 3 performs ticket delivery:

- update/comment on the current ticket
- attach/link artifacts
- create downstream linked tickets
- move tickets across ticket-system states when appropriate

---

## 4. Versioning and rewrite semantics

### 4.1 Contract-level rewrite

A contract-level rewrite creates a new epoch `vN+1` and supersedes the prior epoch.

This is required when the approved declarative contract changed materially, including:

- spec changes
- plan decomposition changes that alter the contract
- primary delivery kind changes
- ticket intent changes that alter the approved WHAT

When a new epoch is created:

- the previous epoch remains on disk
- the previous epoch is marked superseded/abandoned
- the new epoch becomes active

### 4.2 Execution-level rewrite

An execution-level rewrite stays inside the same epoch.

This is used when:

- the current plan procedure is wrong
- downstream plans need patching
- remaining plans must be regenerated
- the contract is still valid

Execution-level rewrites must never overwrite prior files.

### 4.3 Rewrite levels

The allowed rewrite decisions are:

- `refine_local`
- `patch_downstream`
- `regenerate_remaining`
- `revisit_spec`

`revisit_spec` is the only rewrite that creates a new epoch.

---

## 5. Artifact model

### 5.1 Contract artifacts

Each epoch is stored under:

```text
~/.kautopilot/{sessionId}/artifacts/vN/
```

Each epoch must contain:

- `task-spec.md`
- plan files
- machine-readable manifests
- step metadata

### 5.2 Manifest artifacts

Each epoch should include typed manifests such as:

- `contract.json`
- `plans/manifest.json`
- `delivery.json`

These manifests exist so runtime code does not need to infer everything from filenames alone.

### 5.3 Plan files as paper trail

The plan files themselves are the paper trail.

There should be no separate paper-trail directory for plan rewrites.

Examples:

- `plan-1-1.md`
- `plan-2-1.md`
- `plan-1-2.md`
- `plan-2-2.md`

Meaning:

- first number = plan ordinal
- second number = rewrite ordinal within the same epoch

The active plan for a given plan ordinal is the highest suffix in the active epoch.

### 5.4 Approved plan finalization

After Phase 1 approval, plan files are frozen directly into suffixed canonical filenames, such as:

- `plan-1-1.md`
- `plan-2-1.md`

Later rewrites append new files directly in the same plans directory.

---

## 6. Plan structure

Each finalized plan must remain human-readable, but should also be machine-parseable.

Each plan should minimally carry:

- id/title
- goal
- scope/domain
- dependencies
- evidence / proof requirements
- definition of done
- strategy hints
- optional workset configuration
- handoff/replan guidance
- primary delivery kind
- delivery impact / downstream ticket intent if relevant

---

## 7. kloop execution contract

### 7.1 kloop as backend

For implementation execution, kloop is the backend loop.

kautopilot should treat kloop as the authoritative executor for iterative implementation work.

### 7.2 Recognized backend outcomes

The orchestration layer should treat the execution backend as returning a narrow set of outcomes:

- `completed`
- `conflict`
- `max_situations`
- `crash`

### 7.3 Outcome interpretation

- `completed`: the active plan completed successfully and may advance
- `crash`: retry/recover first; do not rewrite immediately by default
- `conflict`: enter rewrite analysis
- `max_situations`: enter rewrite analysis

Only `conflict` and `max_situations` should trigger rewrite analysis.

### 7.4 TTY-assisted rewrite analysis

When `conflict` or `max_situations` occurs, kautopilot should enter a TTY-assisted analysis path.

That path should gather durable loop evidence, including:

- `kloop describe`
- loop review output
- failure context
- current plan and downstream plan state

The analysis step must decide between:

- `refine_local`
- `patch_downstream`
- `regenerate_remaining`
- `revisit_spec`

This decision should be explicit and durable.

---

## 8. Commit invariant

The commit model is:

> one completed plan equals one commit

Implications:

- a rewritten plan revision is not complete just because it exists
- an abandoned rewrite does not get a commit
- only the finally completed active revision for that plan produces the commit

Example:

- `plan-1-1.md` exists
- it is superseded by `plan-1-2.md`
- `plan-1-1.md` does not produce a commit if it never completed
- `plan-1-2.md` produces the single commit for plan 1 if it completes

---

## 9. Handoff semantics

Handoff is an explicit transfer of control between stable workflow states.

It is not the same thing as Claude's raw turn-tracking.

A handoff must always record:

- what stopped
- why it stopped
- what the next stable state is
- what files/artifacts define that next state
- what condition allows resumption

### 9.1 Valid handoff categories

Examples include:

- user handoff
- plan-to-plan handoff
- replan handoff
- phase handoff
- external-wait handoff

### 9.2 Durable handoff state

Status/WAL should record:

- current contract version
- current workset item
- handoff boundary and reason
- rewrite level and affected artifacts
- superseded versions
- primary delivery state
- supporting side-effect state
- PR rollover recommendation and history

The combination of files and WAL/status should make `describe` trustworthy.

---

## 10. PR delivery semantics

### 10.1 Existing PR reuse

For `pr` epochs, the existing PR should be reused by default across new epochs.

A new epoch does not imply a new PR.

The PR is the stable delivery conversation surface.

### 10.2 PR rollover

During poll, Phase 3 should evaluate whether the current PR is still a good reasoning and review surface.

If the PR has become too noisy, the system may recommend rolling over to a fresh PR.

Rollover heuristics may consider signals such as:

- unresolved thread count
- total review comment volume
- push cycle count
- PR age
- general unreadability / review saturation

Any rollover decision must be explicit and durable so `describe` can explain why the PR was reused or replaced.

---

## 11. Ticket delivery semantics

If the primary delivery kind is `ticket`, Phase 3 should deliver through the ticket system rather than PR convergence.

Ticket delivery covers:

- updating the current ticket
- adding comments
- attaching or linking artifacts
- creating downstream linked tickets
- moving tickets into the correct ticket-system states

There is no separate report delivery kind.

### 11.1 Draft artifacts before publish

Before any irreversible ticket-side action happens, Phase 3 must first generate draft artifacts in the session artifacts directory.

Examples:

- `artifacts/vN/tickets-1.md`
- `artifacts/vN/tickets-2.md`
- `artifacts/vN/report-a.md`

These are review artifacts, not yet published ticket-system side effects.

### 11.2 User review gate

Ticket delivery completion must include a user review gate after the ticket artifacts are generated and before any publish action occurs.

This Phase 3 completion gate should:

- ask the user to review the ticket/report artifacts
- ask whether the artifacts are acceptable
- ask whether the user has feedback

If the user has feedback:

- the current epoch is not published
- the feedback becomes input to the next contract epoch
- the workflow proceeds to `vN+1`

If the user approves:

- Phase 3 may perform the irreversible publish actions
- reports may be attached/linked to the current ticket
- downstream tickets may be created
- ticket comments/updates may be emitted

### 11.3 Publish happens only after approval

For `ticket` epochs, publish is the final step, not the draft-generation step.

That means:

- generate draft artifacts first
- gather user feedback first
- only publish after explicit approval

### 11.4 Built-in markdown to PDF conversion

kautopilot should include a built-in markdown-to-PDF conversion path for ticket/report artifacts.

If a report artifact needs PDF delivery, the system should be able to:

- generate markdown first
- convert markdown to PDF locally
- attach or link the resulting PDF during the publish step

Markdown remains the editable review artifact. PDF is a delivery/export format.

---

## 12. Ticket-system script primitives

The ticket-system integration layer should remain script-based and provider-agnostic.

The existing init/org script vocabulary should be expanded beyond the current five scripts to support operations such as:

- update current ticket
- create downstream tickets
- add ticket comment
- move ticket to todo
- attach/link ticket artifact

Core orchestration should remain generic, while org scripts supply provider-specific behavior.

---

## 13. Definition of Done

This specification is complete only when both the functional and non-functional acceptance criteria below are satisfied.

### 13.1 Functional Definition of Done

#### A. Spec / plan model

The runtime must reflect the declarative/imperative split:

- spec is treated as declarative and idempotent
- plans are treated as imperative and procedural
- each epoch has exactly one primary delivery kind: `pr` or `ticket`

Expected behavior:

- a new epoch rewrites the contract, not just the current implementation attempt
- execution within the same epoch rewrites plans, not the declarative target

How to test:

- create a scenario where the plan is wrong but the target is still right; confirm the runtime stays in the same epoch and emits a plan rewrite
- create a scenario where the target itself changes; confirm the runtime creates `vN+1` and marks the previous epoch superseded

#### B. Plan file rewrite trail

Plan rewrites must be represented directly by suffixed filenames in the plan artifact directory.

Expected behavior:

- approved plan files are stored as `plan-1-1.md`, `plan-2-1.md`, etc.
- local or downstream rewrites append new files like `plan-1-2.md`, `plan-2-2.md`
- the active plan for a plan ordinal is the highest suffix in the active epoch
- no prior plan file is overwritten

How to test:

- finalize a contract with multiple plans and verify suffixed files are written
- trigger a local rewrite and verify a higher-suffix file appears without deleting the prior file
- load plans through the runtime and confirm it resolves the highest suffix as active

#### C. kloop outcome handling

Phase 2 must treat kloop as the implementation backend and recognize only the narrow execution outcomes defined by this spec.

Expected behavior:

- `completed` advances to the next plan
- `crash` retries or recovers before any rewrite path is entered
- only `conflict` and `max_situations` enter TTY-assisted rewrite analysis
- rewrite analysis uses loop evidence such as `kloop describe` and review/failure output

How to test:

- simulate or fixture each backend outcome and confirm the orchestrator transitions correctly
- verify that `crash` does not immediately rewrite the plan
- verify that `conflict` and `max_situations` enter the analysis path and require an explicit rewrite decision

#### D. Commit behavior

Commit generation must follow the plan completion invariant.

Expected behavior:

- one completed plan equals one commit
- abandoned rewrites do not produce commits
- if `plan-1-1` is superseded by `plan-1-2`, only the finally completed active revision may produce the commit for that plan

How to test:

- run a plan that completes without rewrite and verify exactly one commit is produced
- run a plan that rewrites once before completion and verify the abandoned rewrite does not commit
- verify the final active rewrite produces exactly one commit when complete

#### E. Handoff and status semantics

Handoff and rewrite state must be first-class and durable.

Expected behavior:

- `describe` and `status --json` expose the active epoch, superseded epochs, current plan/workset, rewrite history, handoff reason, and delivery state
- workflow state can be resumed from files plus WAL/status rather than hidden model memory

How to test:

- interrupt execution mid-plan, mid-rewrite, and mid-delivery, then resume and confirm state is reconstructed from artifacts/status
- inspect `describe` output and confirm it explains why a handoff or rewrite occurred

#### F. PR delivery behavior

For `pr` epochs, Phase 3 must remain PR-native.

Expected behavior:

- the existing PR is reused by default across epochs
- poll computes an explicit rollover recommendation from heuristic signals
- if the PR remains usable, Phase 3 continues on the same PR
- if the PR is too noisy, Phase 3 can explicitly roll over to a fresh PR and record why

How to test:

- run a normal PR epoch and confirm PR reuse across a new contract epoch
- fixture or simulate a noisy PR and verify rollover is recommended and persisted
- verify `describe` records whether the PR was reused or replaced and why

#### G. Ticket delivery behavior

For `ticket` epochs, Phase 3 must produce review artifacts before publishing any irreversible side effects.

Expected behavior:

- draft artifacts are generated under the epoch artifact directory, such as `tickets-1.md`, `tickets-2.md`, `report-a.md`
- Phase 3 asks the user to review those artifacts before publish
- if the user has feedback, the workflow does not publish and instead proceeds to a new epoch
- if the user approves, the workflow performs the real ticket-side actions: update ticket, comment, attach/link artifact, create downstream tickets, move ticket state

How to test:

- run a ticket epoch and verify draft artifacts are created before any external side effects
- provide feedback at the approval gate and verify a new epoch is required instead of publishing
- approve at the gate and verify publish actions occur only after approval

#### H. Markdown to PDF export

kautopilot must support markdown-to-PDF conversion for ticket/report artifacts.

Expected behavior:

- markdown remains the editable artifact
- PDF can be generated locally from markdown
- the PDF can be attached or linked during ticket publish

How to test:

- generate a markdown report artifact and verify a PDF can be produced
- verify the publish path can reference the resulting PDF

#### I. Ticket script expansion

Init/org setup must support the expanded ticket action surface.

Expected behavior:

- script setup includes the ability to update current ticket, add comments, create downstream tickets, move tickets to todo, and attach/link artifacts
- provider-specific behavior stays in scripts, not in core orchestration logic

How to test:

- initialize a session/org script set and verify the expanded script surface is scaffolded or validated
- exercise each script hook through the runtime path that uses it

### 13.2 Non-functional Definition of Done

#### A. Tests

The codebase must include automated coverage for the new behavior.

Required test coverage:

- plan/manifest parsing and validation
- active-plan resolution from suffixed filenames
- mapping from kloop outcomes into orchestrator transitions
- TTY-assisted rewrite analysis entry only on `conflict` / `max_situations`
- contract rewrite to `vN+1`
- no-overwrite behavior for rewritten plan files
- one completed plan equals one commit
- PR rollover heuristic calculation and persistence
- ticket approval gate behavior
- markdown-to-PDF conversion path
- init/org script scaffolding and validation for the expanded script set

#### B. Build and type correctness

The project must build and type-check cleanly after the change.

Required outcome:

- Bun/TypeScript checks pass for the updated codebase
- no broken imports from removing the old `spec/` directory in favor of `spec.md`

#### C. Runtime quality

The implementation must preserve resumability, determinism, and auditability.

Required outcome:

- crashes do not corrupt active epoch state
- WAL/status remains sufficient for resume
- artifact history remains inspectable without hidden mutable state
- rewrite decisions and PR rollover decisions are durable and explainable

#### D. Dead code and compatibility cleanup

The change should leave the repo in a coherent state.

Required outcome:

- dead code and stale readers tied to the old unsuffixed plan assumptions are removed or updated
- old `spec/`-directory-specific references are removed or updated
- no duplicate artifact mechanisms are introduced for the same concept
- no stale delivery-kind logic remains for the removed standalone `report` mode

#### E. User-facing clarity

User-facing behavior should be understandable from CLI/status output.

Required outcome:

- status and describe output make the active epoch, plan revision, handoff reason, delivery mode, and PR rollover state obvious
- ticket approval gates clearly separate draft generation from publish

#### F. End-to-end verification

Before this spec is considered complete, verify at least the following scenarios end-to-end:

- normal PR-only flow
- PR flow with contract rewrite and same-PR reuse
- PR flow with heuristic rollover to a fresh PR
- ticket flow with draft artifacts, feedback, and new epoch
- ticket flow with approval and publish
- conflict-triggered rewrite flow
- max-situations-triggered rewrite flow
- crash and resume flow

---

## 14. Runtime invariants

The system should enforce these invariants:

1. Spec is declarative and idempotent.
2. Plans are imperative and procedural.
3. Each epoch has exactly one primary delivery kind.
4. Contract rewrites create a new epoch.
5. Execution rewrites stay in the same epoch.
6. Plan files themselves are the rewrite trail.
7. Only `conflict` and `max_situations` trigger rewrite analysis.
8. `crash` retries/recoveries before rewrite by default.
9. One completed plan equals one commit.
10. Existing PR is reused by default.
11. PR rollover is heuristic and explicit.
12. Status plus artifacts must be sufficient to explain and resume the workflow.
