# kautopilot Init and Session Spec

## 1. Purpose

`kautopilot` has two distinct lifecycles:

1. **Init lifecycle** — discover how to talk to the user’s ticket system, generate the adapter scripts, and decide whether the worktree can be promoted into a real session.
2. **Runtime session lifecycle** — execute the actual plan / implementation / delivery workflow after init has succeeded or been downgraded to local mode.

This spec defines the init lifecycle, how it is persisted, how it interacts with WAL/status/state-machine semantics, and how a successful init is promoted into a real session.

The main goals are:

- keep the current product shape (`kautopilot init`, `kautopilot start`, `kautopilot org init`)
- keep the script adapter interface stable
- move ticket-system discovery into a generic progressive research/detection workflow
- preserve abandoned/failed init attempts for debugging
- prevent broken init attempts from becoming broken runtime sessions

---

## 2. Core model

### 2.1 Init attempt vs runtime session

The system distinguishes between:

- **Init attempt**: a per-worktree bootstrap attempt that researches the ticket system, gathers setup context, generates/verifies scripts, and ends in either promotion, downgrade, cancellation, or failure.
- **Runtime session**: the promoted session under `~/.kautopilot/<sessionId>` that runs the normal phase machine after init is complete.

An init attempt is not yet a runtime session.

### 2.2 Directory model

Each init attempt is stored under:

```text
~/.kautopilot/init/<sessionId>/
```

Each promoted runtime session is stored under:

```text
~/.kautopilot/<sessionId>/
```

Rules:

- every promoted runtime session has exactly one source init attempt
- not every init attempt becomes a runtime session
- init attempts are retained for debugging even if they fail or are abandoned
- promotion copies from the successful init attempt into the runtime session directory
- a stale or abandoned init attempt must never be reused as the source of promotion

### 2.3 Worktree uniqueness

Init and runtime ownership remain unique per worktree.

Rules:

- a worktree may have at most one active init/session process log at a time
- if an init attempt is active, another init for that worktree is blocked
- if a runtime session already exists for that worktree, re-init is blocked unless the user explicitly forces cancel/reset
- forced reset does not overwrite an old init attempt; it closes that attempt and starts a fresh one

This preserves the current per-worktree uniqueness model while allowing old init attempts to remain on disk as debug artifacts.

---

## 3. Init phases

Init is a phased workflow. Each phase produces durable artifacts that are consumed by the next phase.

### 3.1 Phase A — Identify ticket system

Goal:

- capture the minimum seed input: what system the user uses

Input:

- user answer to “What ticket/task system do you use?”

Output:

- `systemName`

Durable artifact:

- `identify.json` or equivalent status/context entry containing the selected system name

### 3.2 Phase B — Research

Goal:

- research the declared system and produce both system understanding and a detection plan

Research output must include:

- likely access paths (CLI, API, MCP, web/manual, custom wrapper)
- likely hierarchy and work organization
- likely transition model
- likely constraints/restrictions
- what tools/config/auth signals are worth checking locally
- what information still needs to be asked from the user

This phase must not only produce prose. It must produce machine-usable guidance for detection and follow-up questioning.

Durable artifacts:

- `research.md`
- `research.json` or equivalent normalized summary

### 3.3 Phase C — Detect

Goal:

- probe the local environment using the research phase’s detection plan

Detection is not a fixed global list. It is derived from research.

Detection may include:

- binaries to probe
- wrapper CLIs to probe
- config files to inspect
- auth/context test commands to try
- other provider-specific or environment-specific signals surfaced by research

Output:

- detection result describing what seems available, missing, configured, or uncertain

Durable artifact:

- `detection.json`

### 3.4 Phase D — Gather operational context

Goal:

- ask the user one broad context-aware question informed by research + detection

This phase should minimize user friction. It should not turn into a long rigid questionnaire unless absolutely necessary.

The intake should gather, in one broad answer where possible:

- how they actually access tickets
- which detected tool/path they want to use
- whether it is already working/authenticated
- relevant state names
- hierarchy/defaults
- quirks/restrictions/custom fields

Durable artifact:

- `user-context.md` or `user-context.json`

### 3.5 Phase E — Normalize setup brief

Goal:

- turn the research, detection result, and user answer into a stable setup brief for script generation

The normalized brief should define:

- chosen access path
- readiness/confidence
- hierarchy/defaults
- state mapping
- quirks/restrictions
- which adapter capabilities are required
- which non-critical capabilities are allowed to become no-op

Durable artifact:

- `setup-brief.json`

### 3.6 Phase F — Generate and verify

Goal:

- generate the adapter scripts and verify them through a bounded repair loop

This is not a user-driven retry loop. One LLM agent gets several bounded attempts to:

- generate scripts
- run verification
- inspect failures
- repair scripts
- retry

Durable artifacts:

- generated `scripts/`
- `verify.json`
- generation/repair attempt logs

### 3.7 Phase G — Resolve outcome

Goal:

- convert verification results into one of the allowed init outcomes

Allowed outcomes:

- `promoted`
- `promoted_degraded`
- `downgraded_local`
- `cancelled`
- `failed`
- `abandoned`

Durable artifact:

- `outcome.json`
- final status/WAL state for the init attempt

---

## 4. Adapter script model

The ticket-system integration layer remains script-based and provider-agnostic.

### 4.1 Stable interface

The existing script interface is the stable adapter surface. Runtime code should call scripts, not ask the LLM to perform provider-specific actions on demand.

Current script surface includes:

- `extract-ticket`
- `get-ticket`
- `start-ticket`
- `to-review`
- `revert-to-inprogress`
- `update-ticket`
- `create-downstream-ticket`
- `add-comment`
- `move-to-todo`
- `attach-artifact`

### 4.2 Critical vs non-critical capabilities

Capabilities are split into:

**Critical read-path capabilities**

- `extract-ticket`
- `get-ticket`

These must work before a non-local init can be promoted.

**Non-critical write/transition capabilities**

- update current ticket
- create downstream ticket
- add comment
- attach/link artifact
- transition ticket states

These may degrade to no-op if they cannot be made reliable.

### 4.3 No-op policy

If non-critical capabilities fail after bounded repair attempts:

- the corresponding scripts may be replaced with no-op implementations
- the promoted session must record that those actions are manual
- the user must be explicitly informed which operations they must remember to do themselves

---

## 5. Agent-driven generation and repair loop

### 5.1 Input to the agent

The generation/repair agent receives:

- `research.md` / `research.json`
- `detection.json`
- user operational answer
- `setup-brief.json`
- the required adapter interface
- critical/non-critical classification

### 5.2 Bounded repair loop

The loop is bounded. It should:

- generate scripts
- run verification
- inspect failures
- repair scripts
- retry a few times

The user is not asked to manually steer each repair attempt.

### 5.3 Exhaustion behavior

After the bounded repair loop is exhausted:

- if critical scripts still fail, init cannot promote as a ticket-integrated session
- if only non-critical scripts fail, init may still promote in degraded mode

The exhaustion result must be explicit and durable.

---

## 6. Outcome policy

### 6.1 Critical failure

If `extract-ticket` or `get-ticket` cannot be made reliable after bounded retries:

- ticket-integrated init is not promotable
- the user must be told the integration could not be made to work
- the user must be offered downgrade to local mode
- the init attempt remains on disk for debugging
- no broken ticket-integrated runtime session is created

### 6.2 Non-critical failure

If the critical path works but some write/transition scripts do not:

- init may promote to a runtime session
- failing non-critical scripts become no-op
- the outcome is `promoted_degraded`
- the user is explicitly told which actions are now manual

### 6.3 Cancelled or abandoned init

If the user cancels init, or init is interrupted and never resumed:

- the init attempt is marked `cancelled` or `abandoned`
- its logs/artifacts remain intact
- it is never reused as the source for a later promotion

---

## 7. Local-mode downgrade semantics

Local mode is a first-class init outcome.

On downgrade to local mode:

- ticket integration is fully disabled
- branch naming is chosen locally rather than derived from a real ticket ID
- the ticket ID becomes `local-<random>`
- ticket content is collected via TTY input and written as a local `ticket.md`
- ticket-system adapter scripts are treated as fully disabled/no-op for that session

This is not an error state. It is a valid promoted runtime mode.

---

## 8. Status, WAL, and state-machine semantics

Init must interact cleanly with the existing WAL/status model rather than living as implicit transient logic.

### 8.1 Separate init WAL/log root

Runtime sessions currently log to:

```text
~/.kautopilot/<sessionId>/log.jsonl
```

Init attempts must analogously log to:

```text
~/.kautopilot/init/<sessionId>/log.jsonl
```

The init attempt also gets its own materialized status file, e.g.:

```text
~/.kautopilot/init/<sessionId>/status.yaml
```

This keeps init debugging separate from runtime session logs while preserving the same WAL/materialization pattern.

### 8.2 Per-worktree uniqueness and locking

Even though init logs live under a separate root, init still participates in the same unique per-worktree process model.

Rules:

- only one active init/session process may own a worktree at a time
- an active init blocks a second init
- an existing runtime session blocks re-init unless explicitly reset/cancelled
- a reset closes the active owner and creates a fresh init attempt rather than rewriting the old one

### 8.3 Init state machine

Init should be modeled as a machine with explicit states, analogous to the runtime phase machine.

Suggested init states:

- `identify`
- `research`
- `detect`
- `gather_context`
- `normalize`
- `generate`
- `verify`
- `promote`
- `downgrade_local`
- `failed`
- `cancelled`

The exact names may vary, but the machine must make the workflow resumable and inspectable.

### 8.4 WAL events

Init should emit its own `:started` / `:completed` events for init states, plus outcome events.

Examples:

- `init_phase:started` is too coarse by itself; state-level events are required
- `research:started`
- `research:completed`
- `detect:started`
- `detect:completed`
- `generate:started`
- `generate:completed`
- `verify:started`
- `verify:completed`
- `promote:completed`
- `downgrade_local:completed`
- `init:failed`
- `init:cancelled`

The important requirement is not the exact string shape; it is that init is materialized through the same durable event + status pattern as runtime work.

### 8.5 Status materialization

Init status must be reconstructible from WAL the same way runtime session status is today.

Status should track at least:

- wal cursor/timestamp
- current init state
- state status (`pending`, `running`, `completed`, `failed`)
- running flag / pid / start time
- checkpoints if the init machine defines them
- setup context fields that must survive crash recovery
- bounded repair-loop metadata
- final outcome classification

### 8.6 Promotion boundary

Promotion is the point where a successful init attempt creates the runtime session directory and associated session DB row.

Rules:

- before promotion, the init attempt exists only under `~/.kautopilot/init/<sessionId>`
- promotion copies the approved/init-produced artifacts into `~/.kautopilot/<sessionId>`
- promotion must only source from the fresh successful init attempt
- abandoned/failed init attempts are never resumed in place and never copied from later

### 8.7 Runtime session DB semantics

A runtime session should only be registered as a real session once promotion happens.

This prevents half-failed init attempts from polluting the real session index as if they were usable runtime sessions.

If desired, init attempts may have a separate lightweight index, but they must not masquerade as ready runtime sessions before promotion.

---

## 9. Org setup relationship

`kautopilot org init` may reuse parts of the same setup model, but it is not required to share every artifact or promotion rule.

What must remain consistent:

- research-driven setup
- detection driven by research output
- script adapter interface
- critical vs non-critical behavior
- bounded generation/repair loop

What may differ:

- org init may persist reusable script/config defaults without creating a runtime session
- org init does not need the same promotion semantics as a worktree init attempt

If org init diverges, the implementation/spec must state that divergence explicitly.

---

## 10. Definition of Done

This spec is complete only when the later implementation satisfies the following.

### 10.1 Functional requirements

#### A. Progressive init flow

Expected behavior:

- init runs as a phased workflow: identify → research → detect → gather context → normalize → generate/verify → resolve outcome
- each phase leaves durable artifacts that later phases consume

How to test later:

- run init and confirm each phase emits artifacts/log events and can be explained by status/describe output

#### B. Init attempt persistence

Expected behavior:

- every init attempt gets its own directory under `~/.kautopilot/init/<sessionId>`
- failed/abandoned attempts remain on disk for debugging
- stale init attempts are never overwritten

How to test later:

- abandon an init attempt, rerun init with forced reset, and confirm a fresh init attempt directory is created while the old one remains intact

#### C. Unique per-worktree ownership

Expected behavior:

- only one active init/session owner exists per worktree
- active init blocks another init
- active runtime session blocks re-init unless reset/cancelled

How to test later:

- start init and attempt a second init for the same worktree
- create a runtime session and verify re-init is blocked without reset

#### D. Promotion semantics

Expected behavior:

- successful init promotes into `~/.kautopilot/<sessionId>`
- promotion copies only from the successful fresh init attempt
- failed init does not create a broken ticket-integrated runtime session

How to test later:

- run one failed init and one successful retry, then verify the promoted session came from the successful attempt only

#### E. Critical vs non-critical behavior

Expected behavior:

- critical script failure blocks ticket-integrated promotion and leads to local-mode downgrade choice
- non-critical failure produces no-op scripts plus explicit manual-action warnings

How to test later:

- fixture a case where `extract-ticket` fails and confirm downgrade is required
- fixture a case where only transition/update scripts fail and confirm degraded promotion succeeds

#### F. Local-mode downgrade

Expected behavior:

- downgrade creates a valid local-mode promoted session
- ticket ID is `local-<random>`
- branch is local/user-chosen
- local `ticket.md` is created via TTY input

How to test later:

- force downgrade and confirm local-mode artifacts and semantics are correct

#### G. WAL/status correctness

Expected behavior:

- init has its own log and materialized status
- init status can be reconstructed from WAL
- promotion cleanly transitions from init-attempt storage to runtime session storage

How to test later:

- interrupt init mid-phase and verify it can be inspected/resolved from WAL/status
- confirm failed/abandoned attempts remain inspectable after later successful init attempts

### 10.2 Non-functional requirements

#### A. Debuggability

Required outcome:

- abandoned and failed init attempts leave enough artifacts to understand what happened without relying on hidden memory

#### B. Determinism

Required outcome:

- promotion rules are explicit
- stale init attempts are never silently reused
- runtime session indexing reflects only real promoted sessions

#### C. Low user friction

Required outcome:

- setup minimizes repeated narrow prompts
- the main user input after research/detection is broad and context-aware
- users are only asked to intervene after the bounded repair loop is exhausted or a downgrade decision is required

#### D. Compatibility

Required outcome:

- downstream runtime phases continue to use the same adapter script interface
- provider-specific behavior remains in scripts/prompts, not in core orchestration branches

---

## 11. Runtime invariants

The system should enforce these invariants:

1. Init attempt storage is separate from runtime session storage.
2. Every promoted runtime session has exactly one source init attempt.
3. Not every init attempt becomes a runtime session.
4. Worktree ownership remains unique across init and runtime.
5. A fresh forced/retried init creates a fresh init attempt; it never rewrites a prior abandoned attempt.
6. Promotion copies only from the successful fresh init attempt.
7. Critical read-path adapter scripts must work before non-local promotion.
8. Non-critical adapter failures degrade to no-op plus explicit manual-action warnings.
9. Critical adapter failure leads to local-mode downgrade or no promotion.
10. Init is durably represented through WAL + materialized status, not hidden transient state.
11. Runtime session indexing must only include real promoted sessions.
12. Provider-specific behavior belongs in research/prompts/scripts, not hard-coded orchestration branches.
