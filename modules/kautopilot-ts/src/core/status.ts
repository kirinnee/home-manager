import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";
import { readLog } from "./log";
import type { LogEntry } from "./types";

// ============================================================================
// Types
// ============================================================================

/** Active plan context during implementation phase */
export interface ActivePlan {
	name: string;
	planIndex: number;
	maxPlans: number;
	kloopRunId: string | null;
	attempt: number;
}

/** Polish phase state for PR delivery visibility */
export interface PolishState {
	prNumber: number | null;
	prUrl: string | null;
	pushCycle: number;
	lastEvalSummary: {
		replies: number;
		resolves: number;
		codeFixes: number;
		ambiguous: number;
	} | null;
	ttyReason: string | null;
}

/** Per-phase summary for overall progress visibility */
export interface PhaseSummary {
	status: "pending" | "active" | "completed";
	currentStep: string | null;
}

/** Implementation phase summary with plan progress */
export interface ImplPhaseSummary extends PhaseSummary {
	planProgress: string | null;
}

export interface SessionStatus {
	// Replay metadata
	walCursor: number;
	walTimestamp: string;

	// Current position
	phase: string;
	version: number;
	state: string;
	stateStatus: "pending" | "running" | "completed" | "failed";

	// Checkpoint
	lastCheckpoint: string | null;

	// Process
	pid: number | null;
	running: boolean;
	startedAt: string | null;

	// Step execution type. The flat driver emits `def.kind` (interactive | agent | code).
	stepType: "interactive" | "agent" | "code" | null;

	// Completed steps for current cycle (resume logic)
	completedSteps: string[];

	// Phase-specific context (survives crash recovery)
	context: {
		planIndex?: number;
		maxPlans?: number;
		prNumber?: number;
		prUrl?: string;
		pushCycle?: number;
		attempt?: number;
		ttyReason?: string;
	};

	// Kloop run IDs per plan (plan name -> list of run IDs)
	planRuns: Record<string, string[]>;

	// Active plan context (implementation phase)
	activePlan: ActivePlan | null;

	// Polish phase state
	polishState: PolishState | null;

	// Per-phase summary
	phases: {
		plan: PhaseSummary;
		execution: ImplPhaseSummary;
		feedback: PhaseSummary;
	};
}

// ============================================================================
// Checkpoint Definitions
// ============================================================================

// Phase keys here are the public flat-machine phases.
const CHECKPOINTS: Record<string, Set<string>> = {
	plan: new Set([
		"fetch_ticket",
		"triage",
		"write_spec",
		"write_plans",
		"finalize_plans",
	]),
	execution: new Set(["await_repos"]),
	feedback: new Set(["feedback_check"]),
};

/** Ordered step names per phase for display purposes (flat machine step names). */
export const PHASE_STEPS: Record<string, string[]> = {
	plan: [
		"resolve_org",
		"brainstorm",
		"create_ticket",
		"fetch_ticket",
		"triage",
		"write_spec",
		"write_plans",
		"finalize_plans",
	],
	execution: ["await_repos"],
	feedback: ["feedback_check", "feedback"],
};

function isCheckpoint(phase: string, state: string): boolean {
	return CHECKPOINTS[phase]?.has(state) ?? false;
}

// ============================================================================
// Lifecycle events — excluded from state tracking
// ============================================================================

const LIFECYCLE_EVENTS = new Set([
	"start:started",
	"start:completed",
	"stop:started",
	"stop:completed",
	"context:updated",
]);

function isLifecycleEvent(event: string): boolean {
	return LIFECYCLE_EVENTS.has(event);
}

// ============================================================================
// Phase mapping
// ============================================================================

function phaseFromEvent(event: string): string {
	if (event.startsWith("phase1")) return "plan";
	if (event.startsWith("phase2")) return "execution";
	if (event.startsWith("phase3")) return "feedback";
	return "none";
}

// ============================================================================
// Initial status
// ============================================================================

function initialStatus(): SessionStatus {
	return {
		walCursor: 0,
		walTimestamp: "",
		phase: "none",
		version: 0,
		state: "none",
		stateStatus: "pending",
		lastCheckpoint: null,
		pid: null,
		running: false,
		startedAt: null,
		stepType: null,
		completedSteps: [],
		context: {},
		planRuns: {},
		activePlan: null,
		polishState: null,
		phases: {
			plan: { status: "pending", currentStep: null },
			execution: {
				status: "pending",
				currentStep: null,
				planProgress: null,
			},
			feedback: { status: "pending", currentStep: null },
		},
	};
}

// ============================================================================
// applyEvent reducer
// ============================================================================

function applyEvent(
	status: SessionStatus,
	entry: LogEntry,
	index: number,
): void {
	status.walCursor = index + 1;
	status.walTimestamp = entry.ts;

	const { event } = entry;

	// Phase start
	if (/^phase\d:started$/.test(event)) {
		const newPhase = phaseFromEvent(event);
		status.phase = newPhase;
		status.version = entry.version ?? status.version;
		status.completedSteps = [];
		status.lastCheckpoint = null;

		// Bug fix #1: Reset phase-specific context fields on phase transitions
		if (newPhase === "plan") {
			// Bug fix #6: Clear planRuns on new epoch (revisit_spec / amend_spec)
			status.planRuns = {};
			// Bug fix #7: Clear ALL context on revisit_spec
			status.context = {};
			status.activePlan = null;
			status.polishState = null;
		} else if (newPhase === "implementation") {
			// Reset phase2-specific context
			status.context.attempt = undefined;
			status.activePlan = null;
			status.polishState = null;
		} else if (newPhase === "polish") {
			// Reset phase3-specific context
			status.context.pushCycle = undefined;
			status.context.prNumber = undefined;
			status.context.prUrl = undefined;
			status.context.ttyReason = undefined;
			status.activePlan = null;
			// Initialize polishState
			status.polishState = {
				prNumber: null,
				prUrl: null,
				pushCycle: 0,
				lastEvalSummary: null,
				ttyReason: null,
			};
		}
	}

	// Phase complete — clear ephemeral state
	if (/^phase\d:completed$/.test(event)) {
		const completedPhase = phaseFromEvent(event);
		if (completedPhase === "execution") {
			status.activePlan = null;
		}
		if (completedPhase === "feedback") {
			status.polishState = null;
		}
	}

	// Per-plan cycle reset (phase2 loops per plan)
	if (event === "clear_loop:started" && entry.metadata?.planIndex != null) {
		status.completedSteps = [];
		const planIndex = entry.metadata.planIndex as number;
		status.context.planIndex = planIndex;
		const maxPlans = status.context.maxPlans ?? 0;
		status.activePlan = {
			name: `plan-${planIndex + 1}`,
			planIndex,
			maxPlans,
			kloopRunId: null,
			attempt: (status.context.attempt as number) ?? 1,
		};
	}

	// Track kloop run IDs per plan. The `running` agent step records the run id via
	// a `context:updated` event (recordRepoState) once the babysitter reports it;
	// `clear_loop` records `kloopRunId: null` (skipped by the truthy guard).
	if (event === "context:updated" && entry.metadata?.kloopRunId) {
		const plan =
			(entry.plan as string) ?? `plan-${(status.context.planIndex ?? 0) + 1}`;
		const runId = entry.metadata.kloopRunId as string;
		if (!status.planRuns[plan]) {
			status.planRuns[plan] = [];
		}
		status.planRuns[plan].push(runId);
		// Update activePlan kloopRunId (create if missing, e.g. after crash recovery)
		if (status.activePlan) {
			if (status.activePlan.name === plan) {
				status.activePlan.kloopRunId = runId;
			}
		} else {
			const planIndex = status.context.planIndex ?? 0;
			status.activePlan = {
				name: plan,
				planIndex,
				maxPlans: (status.context.maxPlans as number) ?? 0,
				kloopRunId: runId,
				attempt: (status.context.attempt as number) ?? 1,
			};
		}
	}

	// Update activePlan when running completes (kloop finished)
	if (event === "running:completed" && status.activePlan) {
		status.activePlan.kloopRunId = null;
	}

	// Update activePlan on next_plan
	if (
		event === "next_plan:completed" &&
		status.activePlan &&
		entry.metadata?.to
	) {
		const to = entry.metadata.to as string;
		if (to !== "done") {
			const match = to.match(/^plan-(\d+)$/);
			if (match) {
				const newPlanIndex = parseInt(match[1], 10) - 1;
				status.activePlan.planIndex = newPlanIndex;
				status.activePlan.name = to;
				status.activePlan.kloopRunId = null;
			}
		}
	}

	// State started (skip lifecycle/meta events)
	if (event.endsWith(":started") && !isLifecycleEvent(event)) {
		const name = event.replace(":started", "");
		status.state = name;
		status.stateStatus = "running";
		// Set stepType from metadata. The driver emits def.kind (interactive | agent | code).
		const st = (entry.metadata?.stepType as string) ?? null;
		status.stepType = st as SessionStatus["stepType"];
	}

	// State completed (skip lifecycle/meta events)
	if (event.endsWith(":completed") && !isLifecycleEvent(event)) {
		const name = event.replace(":completed", "");
		if (name === status.state) {
			status.stateStatus = "completed";
		}
		status.stepType = null;
		if (!status.completedSteps.includes(name)) {
			status.completedSteps.push(name);
		}
		if (isCheckpoint(status.phase, name)) {
			status.lastCheckpoint = name;
		}
	}

	// Session run start
	if (event === "start:started") {
		status.running = true;
		status.pid = (entry.metadata?.pid as number) ?? null;
		status.startedAt = entry.ts;
		if (entry.metadata?.phase) {
			status.phase = entry.metadata.phase as string;
		}
	}

	// Session run end
	if (event === "start:completed" || event === "stop:completed") {
		status.running = false;
		status.pid = null;
		status.stepType = null;
	}

	// Context updates — also track polish-specific fields
	if (event === "context:updated" && entry.metadata) {
		const { task, parent, error, ...contextFields } = entry.metadata;
		Object.assign(status.context, contextFields);

		// Update polishState from context changes
		if (status.polishState) {
			if (contextFields.prNumber != null)
				status.polishState.prNumber = contextFields.prNumber as number;
			if (contextFields.prUrl != null)
				status.polishState.prUrl = contextFields.prUrl as string;
			if (contextFields.pushCycle != null)
				status.polishState.pushCycle = contextFields.pushCycle as number;
			if (contextFields.ttyReason != null)
				status.polishState.ttyReason = contextFields.ttyReason as string;
		}
	}

	// Track polish eval summary from eval:completed
	if (event === "eval:completed" && status.polishState) {
		status.polishState.lastEvalSummary = {
			replies: (entry.metadata?.replies as number) ?? 0,
			resolves: (entry.metadata?.resolves as number) ?? 0,
			codeFixes: (entry.metadata?.codeFixes as number) ?? 0,
			ambiguous: (entry.metadata?.ambiguous as number) ?? 0,
		};
	}
}

// ============================================================================
// YAML I/O
// ============================================================================

function statusPath(sessionId: string): string {
	return `${process.env.HOME}/.kautopilot/${sessionId}/status.yaml`;
}

function readStatusYaml(sessionId: string): SessionStatus | null {
	const path = statusPath(sessionId);
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf-8");
		return YAML.parse(raw) as SessionStatus;
	} catch {
		return null;
	}
}

function writeStatusYaml(sessionId: string, status: SessionStatus): void {
	const path = statusPath(sessionId);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const content = YAML.stringify(status, { lineWidth: 120 });
		// Atomic write: temp file + rename
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, content);
		renameSync(tmp, path);
	} catch (err) {
		// The status.yaml is a recomputable cache; on a read-only store (e.g. the
		// `serve` web viewer's docker bind mount) writing it is impossible and we
		// fall back to recomputing from log.jsonl each call. Swallow only EROFS/
		// EACCES; rethrow anything else so genuine write bugs stay visible.
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EROFS" && code !== "EACCES") throw err;
	}
}

// ============================================================================
// ensureStatus — lazy incremental replay
// ============================================================================

export function ensureStatus(sessionId: string): SessionStatus {
	const log = readLog(sessionId);
	const existing = readStatusYaml(sessionId);

	if (existing && existing.walCursor >= log.length) {
		const status = { ...initialStatus(), ...existing };
		computeDerivedFields(status);
		return status;
	}

	// Incremental replay from cursor, or full replay if missing
	// Merge with initialStatus() so new fields get their defaults when
	// reading status.yaml from a session created before those fields existed.
	const status = existing
		? { ...initialStatus(), ...existing }
		: initialStatus();
	const startIdx = existing ? existing.walCursor : 0;

	for (let i = startIdx; i < log.length; i++) {
		applyEvent(status, log[i], i);
	}

	computeDerivedFields(status);
	writeStatusYaml(sessionId, status);
	return status;
}

/**
 * Whether the flat binary session reached its terminal cursor. The DB `state`
 * column is a dead signal in the thin-controller model — it's "running" from
 * creation and never updated.
 */
export function isSessionTerminal(sessionId: string): boolean {
	for (const entry of [...readLog(sessionId)].reverse()) {
		if (entry.event === "feedback_check:completed") {
			return entry.metadata?.to === "done";
		}
	}
	return false;
}

/** Whether a session is still in progress (vs finished). */
export function isSessionActive(sessionId: string): boolean {
	return !isSessionTerminal(sessionId);
}

// ============================================================================
// Derived field computation
// ============================================================================

/**
 * Compute summary views of the replayed state (phases summary).
 */
function computeDerivedFields(status: SessionStatus): void {
	// phases summary
	const phaseOrder: Array<"plan" | "execution" | "feedback"> = [
		"plan",
		"execution",
		"feedback",
	];
	const currentPhaseIdx = phaseOrder.indexOf(
		status.phase as "plan" | "execution" | "feedback",
	);

	for (const p of phaseOrder) {
		const pIdx = phaseOrder.indexOf(p);
		if (
			pIdx < currentPhaseIdx ||
			(pIdx === currentPhaseIdx &&
				status.stateStatus === "completed" &&
				status.phase === p)
		) {
			// Completed phase
			if (p === "execution") {
				status.phases.execution = {
					status: "completed",
					currentStep: null,
					planProgress: null,
				};
			} else if (p === "feedback") {
				status.phases.feedback = {
					status: "completed",
					currentStep: null,
				};
			} else {
				status.phases.plan = { status: "completed", currentStep: null };
			}
		} else if (p === status.phase) {
			// Active phase
			const step = status.stateStatus === "running" ? status.state : null;
			if (p === "execution") {
				const planProgress = status.activePlan
					? `${status.activePlan.planIndex + 1}/${status.activePlan.maxPlans}`
					: status.context.maxPlans != null
						? `${(status.context.planIndex ?? 0) + 1}/${status.context.maxPlans}`
						: null;
				status.phases.execution = {
					status: "active",
					currentStep: step,
					planProgress,
				};
			} else if (p === "feedback") {
				status.phases.feedback = {
					status: "active",
					currentStep: step,
				};
			} else {
				status.phases.plan = { status: "active", currentStep: step };
			}
		} else {
			// Pending phase
			if (p === "execution") {
				status.phases.execution = {
					status: "pending",
					currentStep: null,
					planProgress: null,
				};
			} else if (p === "feedback") {
				status.phases.feedback = {
					status: "pending",
					currentStep: null,
				};
			} else {
				status.phases.plan = { status: "pending", currentStep: null };
			}
		}
	}
}

/**
 * Get the current kloop run ID from the active plan.
 * Convenience accessor for CLI commands.
 */
export function getCurrentKloopRunId(status: SessionStatus): string | null {
	return status.activePlan?.kloopRunId ?? null;
}
