import type { Config } from "./types";

// ============================================================================
// Host-driven controller contract — StepDescriptor / StepContract
//
// The binary owns codified state/replay/dispatch/detection/prompts (0 tokens).
// `kautopilot next` yields a StepDescriptor; the harness runs the step and
// reports back via `kautopilot complete`. `code` steps are never yielded — the
// binary runs them inline (and blocks on detection). See CLI-CONTRACT.md.
// ============================================================================

/** Phase of the one flat session machine. */
export type StepPhase = "plan" | "execution" | "feedback";

/**
 * Who runs a step.
 * - `code`        — deterministic plumbing + all detection. Never yielded; the
 *                   binary runs it inline and (for watch loops) blocks.
 * - `interactive` — needs the user. Run inline by the harness; serialized.
 * - `agent`       — needs an LLM, not the user. Always a fresh isolated run:
 *                   a detached kteam session by default, native sub-agent as
 *                   fallback (see the /kautopilot skill).
 */
export type StepKind = "code" | "interactive" | "agent";

/** Whether a step runs on the shared session (plan/feedback) or a single repo. */
export type StepScope = "session" | "repo";

/** The contract a harness must satisfy to `complete` a yielded step. */
export interface StepContract {
	/** Absolute path the harness must write (the source of truth on `complete`). */
	outputFile?: string;
	/** Canonical WAL event appended by `complete`. */
	completionEvent: string;
	/** Schema hint for `--metadata` (keys → human description of the expected value). */
	completionMetadataSchema?: Record<string, string>;
}

/** One reviewer in a fan-out review step (§7.4). */
export interface ReviewerDescriptor {
	id: string;
	prompt: string;
	verdictSchema?: Record<string, string>;
}

/** Review fan-out payload (spec: 8 reviewers; plans: 5). */
export interface ReviewDescriptor {
	reviewers: ReviewerDescriptor[];
	synthesize: { prompt: string; outputFile: string };
	gate: "all_approve";
}

/**
 * What `kautopilot next` hands the harness for one yielded step. Mirrors the
 * JSON surface in CLI-CONTRACT.md §2.
 */
export interface StepDescriptor {
	done: false;
	sessionId: string;
	ticketId: string;
	phase: StepPhase;
	step: string;
	kind: Exclude<StepKind, "code">;
	/** Always null for yielded steps; execution/polish are driven via schedule/record. */
	repo: string | null;
	/** Epoch version. */
	version: number;
	/** Fully-resolved prompt: mechanics + configurable body + substituted vars.
	 *  For `execution: "deferred"` steps this is a short stub — the full prompt
	 *  only ever enters the writer session's message.md (keeps `next --json`
	 *  cheap in the main context). */
	prompt: string;
	/** Absolute paths already substituted into `prompt`. Trimmed to cheap path
	 *  entries for deferred steps (no templates / inline diff text). */
	vars: Record<string, string | null>;
	contract: StepContract;
	/** Present only on review fan-out steps. Always null for deferred steps —
	 *  the writer session owns the fan-out (payload travels via message.md). */
	review: ReviewDescriptor | null;
	/** How the harness runs this step: think inline, or relay to the writer
	 *  session via `kautopilot relay`. (specs/deferred-writer-relay.md §3) */
	execution: "inline" | "deferred";
}

/** Terminal shape from `next` when the session (or a repo loop) is finished. */
export interface DoneDescriptor {
	done: true;
	sessionId: string;
	phase: StepPhase | "done";
	reason: string;
}

export type NextResult = StepDescriptor | DoneDescriptor;

// ============================================================================
// Step registry contracts
// ============================================================================

import type { RepoEntry, SessionMeta } from "./session-meta";

/**
 * Everything a step handler needs. `next` builds it for `prepare`/`run`;
 * `complete` builds it (with output/metadata) for `finalize`.
 */
export interface StepContext {
	sessionId: string;
	meta: SessionMeta;
	config: Config;
	/** The repo this step operates on; null for session-scoped plan/feedback steps. */
	repo: RepoEntry | null;
	/** Epoch version. */
	version: number;
	/** `complete` only: path passed via `--output`. */
	output?: string;
	/** `complete` only: parsed `--metadata` JSON. */
	metadata?: Record<string, unknown>;
}

/** What a step's `prepare` returns — the descriptor minus framing the driver fills in. */
export interface PreparedStep {
	prompt: string;
	vars: Record<string, string | null>;
	contract: StepContract;
	review?: ReviewDescriptor | null;
}

/**
 * A single step in the flat session machine. Split-handler model (§11):
 * - `code` steps define `run` (executed inline by `next`; may block on detection).
 * - `interactive`/`agent` steps define `prepare` (emits the descriptor) and
 *   `finalize` (runs inside `complete`, deterministically).
 * Every handler returns the next step name, or null when the phase/session ends.
 */
export interface StepDef {
	name: string;
	phase: StepPhase;
	kind: StepKind;
	scope: StepScope;
	/** code only: run inline; returns the next step name or null. May block. */
	run?: (ctx: StepContext) => Promise<string | null>;
	/** interactive/agent only: build the yielded descriptor body. */
	prepare?: (ctx: StepContext) => Promise<PreparedStep>;
	/** interactive/agent only: finalize on `complete`; returns next step or null. */
	finalize?: (ctx: StepContext) => Promise<string | null>;
}
