# Goal: multi-repo, multi-PR orchestration with a master plan

Extend kautopilot to support **multi-repo, multi-PR, dependency-sequenced** workflows.
The work spans the binary (`SPEC-kautopilot.md`, `CLI-CONTRACT.md`, `src/`) and the
`/kautopilot` skill (`modules/agent-config/skills/kautopilot/SKILL.md`).

## 1. Master plan artifact (new — in the plan phase, BEFORE sub-plans)

Add a **master plan** as its own versioned artifact in the plan phase. The plan-phase
order becomes:

1. `triage` — which repos are involved.
2. `spec` — the master spec.
3. **`master_plan`** — 🆕 the orchestration artifact. Confirmed/approved **before**
   any detailed per-repo plans are written.
4. `write_plans` — the per-repo sub-plans, written **only after** the master plan is
   approved.

The master plan defines, up front:

- **Execution order** of all plans across all repos.
- **Dependency DAG** between plans, where each edge carries a **gate level**:
  - `completed` — upstream plan's code is done.
  - `merged` — upstream plan's PR is merged.
  - `released` — upstream plan's release is fully published (see §4).
  - Edges may span repos (repo A plan depends on repo B plan).
- **PR + branch layout**: how many PRs, their branch names, and which plans land in
  which PR. A repo may have **multiple branches / multiple PRs** (today's model of one
  branch + one PR per repo is replaced).

The master plan goes through the normal **revise + approve loop** and gets an
**infographic visual** like the other artifacts.

## 2. Show the DAG + master plan in the UI

- Render the dependency **DAG** in the web dashboard as a **mermaid graph** (the viewer
  already renders mermaid): nodes = repo/plan, edges labelled with the gate level
  (`merged` / `released`).
- The master plan is a versioned artifact in the viewer (Read + Visual), same as
  spec/triage/plans/feedback.

## 3. Per-session merge mode

- New per-session setting: **`mergeMode: manual | auto`** (chosen at session start).
- **Always**, regardless of mode: drive each PR to **ready-to-merge** (CI green + all
  threads resolved).
- Then:
  - `manual` → **ask the user** whether to merge.
  - `auto` → **merge automatically**.
- This is the only place kautopilot is allowed to merge, and only when the session is
  `auto` (or the user says yes in `manual`).

## 4. Release-gating

Before pulling main and starting a plan that depends (gate level `released`) on a
previous plan's release:

1. **Detect** whether the repo has a **semantic releaser** (semantic-release or similar).
2. If it does → wait until the **newest release is fully complete** AND **all CI/CD
   pipelines have finished**.
3. **Only then** pull latest main and proceed to the next plan.
4. Release-gating can **span repos** (downstream repo waits on upstream repo's release).

## 5. Worktrees

- **Always pull latest main and create each worktree off it** — so a downstream
  worktree includes upstream merged/released work.
- **Each repo gets its own worktree**, created via **worktrunk (`wt`)**.
- Worktrees are **cleaned up** at the end, per repo.

## 6. Tracking YAML (resume)

Maintain a **human-readable YAML** in the session store capturing:

- The master plan + dependency DAG + gate levels.
- The PR / branch layout.
- **Per-plan execution status.**
- The **kloop run ID linked to each plan execution.**

This lets a session be **stopped and resumed at any time**, and shows exactly where each
plan / PR stands. It should be a companion/derived view layered on the existing WAL +
`session.json` (which already record `kloopRunId`), not a competing source of truth —
unless that turns out to be impractical.

## 7. End-of-message links table → single column

In the `/kautopilot` skill, replace the 2-column `Artifact | Link` summary table with a
**single-column** table where the visible text **is** the hyperlink, one row each — e.g.
`[Spec](url)`, `[Plans — api](url)`, `[PR — api](url)`.

## Acceptance

- `bun run check` exit 0 and `bun test` green from `modules/kautopilot-ts`.
- `SPEC-kautopilot.md` + `CLI-CONTRACT.md` updated to describe the above.
- `SKILL.md` updated for the new master-plan step ordering, merge-mode, release-gating,
  and the single-column hyperlink table.
