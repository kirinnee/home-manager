import type { SessionMeta } from "../session-meta";
import type { Config } from "../types";

// ============================================================================
// Deferred-writer mode resolution. A writer step runs `deferred` (relayed to a
// separate writer session via `kautopilot relay`) iff the session opted in AND
// the step is enabled in config.writer.steps. Everything else stays `inline`.
// (specs/deferred-writer-relay.md §3)
// ============================================================================

export type StepExecution = "inline" | "deferred";

/** The interactive writer steps (the STEP_ARTIFACT keys). `plan_only` is the
 *  plan-only ("fast") single artifact and defers like the other writer steps. */
const WRITER_STEPS = [
	"brainstorm",
	"triage",
	"write_spec",
	"write_master_plan",
	"write_plans",
	"plan_only",
	"feedback",
] as const;

export type WriterStep = (typeof WRITER_STEPS)[number];

/** @public Exported for unit tests; used internally by `stepExecution`. */
export function isWriterStep(step: string): step is WriterStep {
	return (WRITER_STEPS as readonly string[]).includes(step);
}

/**
 * How the harness must run a step. `create_ticket`/`feedback_check`/agent steps
 * are always inline; writer steps defer only when the session's pinned
 * `writerMode` is deferred AND the step is enabled in `config.writer.steps`.
 */
export function stepExecution(
	step: string,
	meta: Pick<SessionMeta, "writerMode">,
	config: Config,
): StepExecution {
	if (!isWriterStep(step)) return "inline";
	if (meta.writerMode !== "deferred") return "inline";
	return config.writer.steps.includes(step) ? "deferred" : "inline";
}
