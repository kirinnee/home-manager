import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { sessionDir } from "./artifacts";

// ============================================================================
// Master plan + orchestration state (multi-repo, multi-PR sequencing).
//
// The PLAN phase produces a `master_plan` artifact (approved BEFORE the per-repo
// sub-plans): it lays out the execution order, the dependency DAG between plans
// (each edge carries a GATE LEVEL), and the PR/branch layout (a repo may open
// several PRs across several branches). The agreed master plan is frozen into
// `orchestration.yaml` — a human-readable, resumable record that also tracks each
// plan's live execution status and the kloop run that implemented it.
//
// `orchestration.yaml` is a COMPANION view layered on the WAL + session.json (it
// never replaces them as the cursor's source of truth); it is the single place
// that maps plan → PR/branch → gate deps → exec status → kloop run, so a session
// can be stopped and resumed at any time and the UI can render the DAG.
//
// On-disk: ~/.kautopilot/<sessionId>/orchestration.yaml  (a SINGLE file holding the
// CURRENT epoch's master plan; the `epoch` field records which delivery cycle it
// describes. An epoch bump RE-INITS this file in place — prior progress is carried
// forward for any plan id that still exists, and the WAL remains the full history).
// ============================================================================

/**
 * How "done" an upstream plan must be before a dependent plan may START.
 * - `completed` — the upstream plan's code is implemented (committed on its branch).
 * - `merged`    — the upstream plan's PR is merged into base (manual or auto, see
 *                 {@link MergeMode}); the dependent worktree is cut off the updated base.
 * - `released`  — the upstream repo's semantic release for that work is fully
 *                 published AND all release CI/CD has finished, THEN base is pulled.
 */
export type GateLevel = "completed" | "merged" | "released";

const GATE_LEVELS: GateLevel[] = ["completed", "merged", "released"];

export function isGateLevel(v: unknown): v is GateLevel {
	return typeof v === "string" && (GATE_LEVELS as string[]).includes(v);
}

/** Per-session policy: user merge only, or controller may merge scheduled ready PRs. */
export type MergeMode = "manual" | "auto";

/**
 * A planned pull request: ONE branch in ONE repo, holding the plans that land in
 * it. A repo may have several PrPlans (multi-PR), each on its own branch.
 */
export interface PrPlan {
	/** Stable id within the master plan (e.g. `pr-1`). */
	id: string;
	/** Repo this PR is opened in. */
	repo: string;
	/** Full branch name (e.g. `kirinnee/PE-1234-api-contract`). */
	branch: string;
	/** PR title. */
	title: string;
	/** Plan ids (`plan-N`) whose work lands in this PR, in commit order. */
	plans: string[];
}

/** One plan node in the DAG: a plan, its repo, and the PR it ships in. */
export interface PlanNode {
	/** Plan id — the `plan-<N>` folder ordinal (e.g. `plan-1`). */
	plan: string;
	/** Repo the plan belongs to. */
	repo: string;
	/** Id of the PrPlan this plan lands in. */
	pr: string;
	/** Optional short title for display. */
	title?: string;
}

/**
 * A dependency edge: `plan` (in `repo`) may not start until `dependsOn` (in
 * `dependsOnRepo`) reaches `gate`. Edges may span repos.
 */
export interface PlanDependency {
	plan: string;
	repo: string;
	dependsOn: string;
	dependsOnRepo: string;
	gate: GateLevel;
}

/** The orchestration layer agreed in the plan phase, before sub-plans are written. */
export interface MasterPlan {
	prs: PrPlan[];
	nodes: PlanNode[];
	deps: PlanDependency[];
	/** Optional mermaid graph source; the viewer falls back to {@link toMermaid}. */
	mermaid?: string;
}

/**
 * Live execution status of a single plan, recorded by the agent via `kautopilot
 * record` as it drives the work. Whether a plan is currently *blocked* by a gate is
 * computed dynamically from {@link unsatisfiedDeps} (not stored), so there is no
 * `blocked` status — only the states a plan actually passes through.
 */
export type PlanExecStatus =
	| "pending" // not started
	| "running" // kloop / sub-agent is implementing it
	| "implemented" // code committed on its branch
	| "pr_open" // its PR exists; PR-level polish may still be running
	| "pr_ready" // its PR is ready-to-merge after CI + review-thread polish
	| "merged" // its PR has been merged into base
	| "released" // the release containing it is fully published
	| "failed"; // the agent reported it could not be completed

export interface PlanProgress {
	plan: string;
	repo: string;
	status: PlanExecStatus;
	/** The kloop run id that implemented this plan (links plan ↔ kloop run). */
	kloopRunId?: string | null;
	prNumber?: number | null;
	prUrl?: string | null;
	updatedAt?: string;
}

export type PrLifecycleStatus =
	| "pending" // not opened yet
	| "open" // PR exists; polish/CI/review-thread loop is still pending
	| "ready" // CI green + actionable review threads resolved
	| "merged" // PR merged into base
	| "released" // release containing the PR is complete
	| "failed";

export interface PrProgress {
	/** Stable PrPlan id from the master plan (e.g. `pr-1`). */
	pr: string;
	status: PrLifecycleStatus;
	prNumber?: number | null;
	prUrl?: string | null;
	updatedAt?: string;
}

/** The full resumable orchestration record persisted to `orchestration.yaml`. */
export interface Orchestration {
	sessionId: string;
	epoch: number;
	mergeMode: MergeMode;
	master: MasterPlan;
	progress: PlanProgress[];
	/** PR-level lifecycle; polish belongs here, not on individual plan readiness. */
	prProgress?: PrProgress[];
}

// ----------------------------------------------------------------------------
// I/O
// ----------------------------------------------------------------------------

function orchestrationPath(sessionId: string): string {
	return join(sessionDir(sessionId), "orchestration.yaml");
}

export function readOrchestration(sessionId: string): Orchestration | null {
	const path = orchestrationPath(sessionId);
	if (!existsSync(path)) return null;
	try {
		const parsed = YAML.parse(readFileSync(path, "utf-8")) as Orchestration;
		if (!parsed || typeof parsed !== "object") return null;
		// Tolerate older/partial docs: normalize arrays.
		parsed.master ??= { prs: [], nodes: [], deps: [] };
		parsed.master.prs ??= [];
		parsed.master.nodes ??= [];
		parsed.master.deps ??= [];
		parsed.progress ??= [];
		const missingPrProgress = !parsed.prProgress;
		if (missingPrProgress) normalizeLegacyPrOpenProgress(parsed);
		parsed.prProgress = normalizePrProgress(parsed, missingPrProgress);
		return parsed;
	} catch {
		return null;
	}
}

function normalizeLegacyPrOpenProgress(orch: Orchestration): void {
	for (const pr of orch.master.prs) {
		const planNodes = orch.master.nodes.filter((n) => n.pr === pr.id);
		const progresses = planNodes
			.map((n) =>
				orch.progress.find((p) => p.repo === n.repo && p.plan === n.plan),
			)
			.filter((p): p is PlanProgress => !!p);
		const legacyReady =
			progresses.length > 0 &&
			progresses.every(
				(p) =>
					p.status === "pr_open" ||
					p.status === "pr_ready" ||
					p.status === "merged" ||
					p.status === "released",
			);
		if (legacyReady) {
			for (const p of progresses) {
				if (p.status === "pr_open") p.status = "pr_ready";
			}
		}
	}
}

function normalizePrProgress(
	orch: Orchestration,
	legacyMissingPrProgress = false,
): PrProgress[] {
	const existing = new Map((orch.prProgress ?? []).map((p) => [p.pr, p]));
	return orch.master.prs.map((pr) => {
		const found = existing.get(pr.id);
		if (found) return found;
		return derivePrProgress(orch, pr.id, {
			legacyPrOpenIsReady: legacyMissingPrProgress,
		});
	});
}

export function derivePrProgress(
	orch: Orchestration,
	prId: string,
	opts: { legacyPrOpenIsReady?: boolean } = {},
): PrProgress {
	const planNodes = orch.master.nodes.filter((n) => n.pr === prId);
	const progresses = planNodes
		.map((n) =>
			orch.progress.find((p) => p.repo === n.repo && p.plan === n.plan),
		)
		.filter((p): p is PlanProgress => !!p);
	const statuses = progresses.map((p) => p.status);
	let status: PrLifecycleStatus = "pending";
	if (statuses.length > 0 && statuses.every((s) => s === "released")) {
		status = "released";
	} else if (
		statuses.length > 0 &&
		statuses.every((s) => s === "merged" || s === "released")
	) {
		status = "merged";
	} else if (
		opts.legacyPrOpenIsReady &&
		statuses.length > 0 &&
		statuses.every(
			(s) =>
				s === "pr_open" ||
				s === "pr_ready" ||
				s === "merged" ||
				s === "released",
		)
	) {
		status = "ready";
	} else if (
		statuses.length > 0 &&
		statuses.every(
			(s) => s === "pr_ready" || s === "merged" || s === "released",
		)
	) {
		status = "ready";
	} else if (
		statuses.some(
			(s) =>
				s === "pr_open" ||
				s === "pr_ready" ||
				s === "merged" ||
				s === "released",
		)
	) {
		status = "open";
	} else if (statuses.some((s) => s === "failed")) {
		status = "failed";
	}
	return {
		pr: prId,
		status,
		prNumber: progresses.find((p) => p.prNumber != null)?.prNumber ?? null,
		prUrl: progresses.find((p) => p.prUrl)?.prUrl ?? null,
	};
}

function writeOrchestration(orch: Orchestration): void {
	const path = orchestrationPath(orch.sessionId);
	const tmp = `${path}.tmp`;
	// Best-effort, like status.yaml (writeStatusYaml): orchestration.yaml is a
	// recomputable companion record, never the cursor's source of truth, so a
	// read-only store / failed rename must not crash a step. Clean up the temp file
	// on failure and degrade silently.
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, YAML.stringify(orch));
		// Atomic swap so a concurrent reader never sees a half-written doc.
		renameSync(tmp, path);
	} catch {
		try {
			if (existsSync(tmp)) rmSync(tmp, { force: true });
		} catch {
			// nothing more we can do.
		}
	}
}

/**
 * Seed (or re-seed) the orchestration record from an approved master plan. When a
 * record already exists (e.g. an epoch bump re-runs the plan phase), each plan's
 * prior exec status is PRESERVED where the plan id still exists, so resume keeps
 * progress; brand-new plans start `pending`.
 */
export function initOrchestration(
	sessionId: string,
	epoch: number,
	mergeMode: MergeMode,
	master: MasterPlan,
): Orchestration {
	const prior = readOrchestration(sessionId);
	const priorById = new Map(
		(prior?.progress ?? []).map((p) => [`${p.repo}/${p.plan}`, p]),
	);
	const progress: PlanProgress[] = master.nodes.map((n) => {
		const carried = priorById.get(`${n.repo}/${n.plan}`);
		return (
			carried ?? {
				plan: n.plan,
				repo: n.repo,
				status: "pending" as PlanExecStatus,
				kloopRunId: null,
				prNumber: null,
				prUrl: null,
			}
		);
	});
	const orch: Orchestration = {
		sessionId,
		epoch,
		mergeMode,
		master,
		progress,
		prProgress: master.prs.map((pr) => {
			const carried = prior?.prProgress?.find((p) => p.pr === pr.id);
			return (
				carried ??
				derivePrProgress(
					{ sessionId, epoch, mergeMode, master, progress, prProgress: [] },
					pr.id,
				)
			);
		}),
	};
	writeOrchestration(orch);
	return orch;
}

/** Read → mutate → write the orchestration record atomically. No-op if absent. */
function updateOrchestration(
	sessionId: string,
	mutate: (orch: Orchestration) => void,
): Orchestration | null {
	const orch = readOrchestration(sessionId);
	if (!orch) return null;
	mutate(orch);
	writeOrchestration(orch);
	return orch;
}

/** Set one plan's progress fields (creating the entry if it is missing). */
export function recordPlanProgress(
	sessionId: string,
	repo: string,
	plan: string,
	patch: Partial<Omit<PlanProgress, "plan" | "repo">>,
): Orchestration | null {
	return updateOrchestration(sessionId, (orch) => {
		let entry = orch.progress.find((p) => p.repo === repo && p.plan === plan);
		if (!entry) {
			// Match initOrchestration's shape so a created-on-the-fly entry serializes
			// identically (null optionals, not missing keys).
			entry = {
				plan,
				repo,
				status: "pending",
				kloopRunId: null,
				prNumber: null,
				prUrl: null,
			};
			orch.progress.push(entry);
		}
		Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
	});
}

/** Set one PR's lifecycle fields, creating the entry if it is missing. */
export function recordPrProgress(
	sessionId: string,
	pr: string,
	patch: Partial<Omit<PrProgress, "pr">>,
): Orchestration | null {
	return updateOrchestration(sessionId, (orch) => {
		orch.prProgress ??= normalizePrProgress(orch);
		let entry = orch.prProgress.find((p) => p.pr === pr);
		if (!entry) {
			entry = { pr, status: "pending", prNumber: null, prUrl: null };
			orch.prProgress.push(entry);
		}
		Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
	});
}

// ----------------------------------------------------------------------------
// Gate evaluation
// ----------------------------------------------------------------------------

/** Rank a status so a single comparison answers "has it reached gate X?". */
const STATUS_RANK: Record<PlanExecStatus, number> = {
	pending: 0,
	failed: 0,
	running: 1,
	implemented: 2,
	pr_open: 3,
	pr_ready: 4,
	merged: 5,
	released: 6,
};

/** The minimum status rank that satisfies each gate level. */
const GATE_MIN_RANK: Record<GateLevel, number> = {
	completed: STATUS_RANK.implemented,
	merged: STATUS_RANK.merged,
	released: STATUS_RANK.released,
};

/** Is a single dependency edge satisfied given the current progress map? */
function gateSatisfied(dep: PlanDependency, progress: PlanProgress[]): boolean {
	const up = progress.find(
		(p) => p.repo === dep.dependsOnRepo && p.plan === dep.dependsOn,
	);
	if (!up) return false;
	return STATUS_RANK[up.status] >= GATE_MIN_RANK[dep.gate];
}

/** The dependency edges of a plan that are NOT yet satisfied (its blockers). */
export function unsatisfiedDeps(
	orch: Orchestration,
	repo: string,
	plan: string,
): PlanDependency[] {
	return orch.master.deps
		.filter((d) => d.repo === repo && d.plan === plan)
		.filter((d) => !gateSatisfied(d, orch.progress));
}

// ----------------------------------------------------------------------------
// Mermaid rendering (UI) — derived when the agent didn't supply `master.mermaid`.
// ----------------------------------------------------------------------------

/** Reduce a string to a mermaid-safe identifier (alnum + underscore only). */
function sanitizeMermaidId(s: string): string {
	return s.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Sanitize an id for use as a mermaid node id (alnum + underscore only). */
function mermaidId(repo: string, plan: string): string {
	return sanitizeMermaidId(`${repo}__${plan}`);
}

/**
 * Escape a free-text string (PR title, branch, plan title) for use inside a
 * mermaid `"..."` label. Double quotes break the label and `[]{}|` break the
 * node/edge syntax, so quotes become the `#quot;` entity mermaid understands and
 * the structural characters are softened to safe equivalents.
 */
function mermaidLabel(s: string): string {
	return s
		.replace(/"/g, "#quot;")
		.replace(/[[{]/g, "(")
		.replace(/[\]}]/g, ")")
		.replace(/[|<>]/g, "/");
}

const GATE_EDGE_LABEL: Record<GateLevel, string> = {
	completed: "done",
	merged: "merged",
	released: "released",
};

/**
 * Render the master plan as a mermaid `graph TD`: one node per plan (labelled
 * `repo/plan`, grouped into a per-PR subgraph), edges labelled with the gate level.
 */
export function toMermaid(master: MasterPlan): string {
	const lines: string[] = ["graph TD"];
	// Group nodes into per-PR subgraphs so the branch/PR layout is visible.
	for (const pr of master.prs) {
		lines.push(
			`  subgraph ${sanitizeMermaidId(pr.id)}["${mermaidLabel(`${pr.repo}: ${pr.title} (${pr.branch})`)}"]`,
		);
		for (const n of master.nodes.filter((x) => x.pr === pr.id)) {
			lines.push(
				`    ${mermaidId(n.repo, n.plan)}["${mermaidLabel(`${n.repo}/${n.plan}${n.title ? `: ${n.title}` : ""}`)}"]`,
			);
		}
		lines.push("  end");
	}
	// Nodes not attached to any PR (defensive).
	for (const n of master.nodes.filter(
		(x) => !master.prs.some((p) => p.id === x.pr),
	)) {
		lines.push(
			`  ${mermaidId(n.repo, n.plan)}["${mermaidLabel(`${n.repo}/${n.plan}`)}"]`,
		);
	}
	for (const d of master.deps) {
		lines.push(
			`  ${mermaidId(d.dependsOnRepo, d.dependsOn)} -->|${GATE_EDGE_LABEL[d.gate]}| ${mermaidId(d.repo, d.plan)}`,
		);
	}
	return lines.join("\n");
}
