// ============================================================================
// Phase-set model — which of the four plan-shaping phases a session runs.
//
// The canonical phases are, in execution order:
//   brainstorm → triage → spec → plan
// PLAN IS MANDATORY: every run ends in a plan artifact then implementation. Any
// subset of the earlier phases may be included; they always execute in canonical
// order and omitted phases are skipped ENTIRELY (no empty placeholder artifacts).
//
// The set is chosen once at `start` — an explicit `--phases` list, or a
// keyword-heuristic proposal from the user's initial request — and PINNED into
// session.json (`phases`), so a later config change never re-shapes an in-flight
// session. `plan` alone is the "fast" shape: one collapsed artifact, exactly ONE PR.
// ============================================================================

/** All phases in canonical execution order (a literal tuple so `z.enum` can derive
 *  the {@link Phase} union directly). */
export const CANONICAL_PHASES = [
	"brainstorm",
	"triage",
	"spec",
	"plan",
] as const;

export type Phase = (typeof CANONICAL_PHASES)[number];

export function isPhase(value: unknown): value is Phase {
	return (CANONICAL_PHASES as readonly unknown[]).includes(value);
}

/**
 * Validate + normalize a raw phase list: lower-case, dedupe, force `plan` in
 * (mandatory), and re-order to canonical order. Throws on any unknown phase name
 * so a typo fails loudly at `start` rather than silently dropping a phase.
 */
export function normalizePhases(input: readonly string[]): Phase[] {
	const seen = new Set<Phase>();
	for (const raw of input) {
		const p = raw.trim().toLowerCase();
		if (!p) continue;
		if (!isPhase(p)) {
			throw new Error(
				`Unknown phase: "${raw}". Valid phases: ${CANONICAL_PHASES.join(", ")}.`,
			);
		}
		seen.add(p);
	}
	seen.add("plan"); // plan is always included
	return CANONICAL_PHASES.filter((p) => seen.has(p));
}

/** Parse a comma/space-separated `--phases` argument into a normalized set. */
export function parsePhasesArg(arg: string): Phase[] {
	return normalizePhases(arg.split(/[,\s]+/).filter(Boolean));
}

/** The pinned phase set for a session, defaulting to the full canonical set for
 *  pre-feature sessions (mirrors the old always-full behavior). */
export function sessionPhases(meta: { phases?: Phase[] }): Phase[] {
	const p = meta.phases;
	return p && p.length > 0 ? normalizePhases(p) : [...CANONICAL_PHASES];
}

/** Is a phase enabled for this session? */
export function hasPhase(meta: { phases?: Phase[] }, phase: Phase): boolean {
	return sessionPhases(meta).includes(phase);
}

/** Plan-only ("fast") shape: the single collapsed artifact + exactly one PR. */
export function isPlanOnly(phases: readonly Phase[]): boolean {
	return phases.length === 1 && phases[0] === "plan";
}

// ----------------------------------------------------------------------------
// Keyword heuristics + confidence gate
// ----------------------------------------------------------------------------

/**
 * Config-driven keyword map. Each class contributes to the proposed phase set:
 * - `planOnly`  → [plan]                              (the fast shape, one PR)
 * - `full`      → [brainstorm, triage, spec, plan]    (the heavyweight shape)
 * - `brainstorm`→ include brainstorm on top of the base
 * Word/phrase matching is word-boundary and case-insensitive; the lists live in
 * config so they stay extensible without a code change.
 */
export interface PhaseKeywordMap {
	planOnly: string[];
	full: string[];
	brainstorm: string[];
}

export const DEFAULT_PHASE_KEYWORDS: PhaseKeywordMap = {
	planOnly: ["small", "simple", "quick", "fast"],
	full: ["big", "long", "dangerous", "risky"],
	brainstorm: ["unsure", "bounce ideas", "discuss", "brainstorm", "explore"],
};

export const DEFAULT_PHASES: Phase[] = [...CANONICAL_PHASES];

/** Above this confidence the proposal is offered and the run continues; below it
 *  the harness asks a few clarifying questions first. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/** Escape a keyword/phrase for safe embedding in a `\b…\b` RegExp. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The keywords (from `words`) that appear in `text` on a word boundary. */
export function matchedKeywords(
	text: string | undefined | null,
	words: readonly string[],
): string[] {
	if (!text) return [];
	return words.filter((w) => {
		const word = w.trim();
		if (!word) return false;
		return new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(text);
	});
}

export interface PhaseProposal {
	/** The proposed, normalized phase set. */
	phases: Phase[];
	/** 0..1 — how strongly the heuristics point at this set. */
	confidence: number;
	/** `propose` (continue with the set) vs `ask` (clarify first). */
	decision: "propose" | "ask";
	/** Human-readable reasons (matched keywords per class). */
	reasons: string[];
}

/**
 * Propose a phase set + confidence from the user's initial request. Pure — the
 * config supplies the keyword map, default set, and threshold. The confidence
 * gate (`propose` vs `ask`) is decided against the threshold; either way the
 * chosen set is always overridable by the user.
 */
export function proposePhases(
	text: string | undefined | null,
	cfg: {
		keywords: PhaseKeywordMap;
		defaultPhases: Phase[];
		confidenceThreshold: number;
	},
): PhaseProposal {
	const planOnly = matchedKeywords(text, cfg.keywords.planOnly);
	const full = matchedKeywords(text, cfg.keywords.full);
	const brainstorm = matchedKeywords(text, cfg.keywords.brainstorm);
	const reasons: string[] = [];

	let base: Phase[];
	let confidence: number;
	if (planOnly.length > 0 && full.length > 0) {
		// Conflicting signals — fall back to the default set, low confidence.
		base = [...cfg.defaultPhases];
		confidence = 0.3;
		reasons.push(
			`conflicting cues: plan-only (${planOnly.join(", ")}) vs full (${full.join(", ")})`,
		);
	} else if (full.length > 0) {
		base = [...CANONICAL_PHASES];
		confidence = 0.9;
		reasons.push(`full-shape cue: ${full.join(", ")}`);
	} else if (planOnly.length > 0) {
		base = ["plan"];
		confidence = 0.9;
		reasons.push(`plan-only cue: ${planOnly.join(", ")}`);
	} else {
		base = [...cfg.defaultPhases];
		confidence = brainstorm.length > 0 ? 0.6 : 0.2;
		reasons.push("no strong shape cue — using the default phase set");
	}

	if (brainstorm.length > 0) {
		base = [...base, "brainstorm"];
		reasons.push(`brainstorm cue: ${brainstorm.join(", ")}`);
	}

	const phases = normalizePhases(base);
	const decision: "propose" | "ask" =
		confidence >= cfg.confidenceThreshold ? "propose" : "ask";
	return { phases, confidence, decision, reasons };
}

export interface PhaseGateResult {
	/** The phase set the session should be pinned with. */
	phases: Phase[];
	/** Whether the low-confidence clarifying path was taken. */
	asked: boolean;
}

/**
 * The confidence gate that runs BEFORE a session commits to a phase set:
 * - `propose` (confident) → take the proposed set as-is; `ask` is NEVER called.
 * - `ask` (low confidence) → invoke `ask()` to clarify with the user FIRST, then
 *   pin whatever it returns (normalized). This is what makes a low-confidence
 *   heuristic lead to clarifying questions before the run starts, not after.
 * Pure control flow (the `ask` side effect is injected), so both branches are
 * unit-testable without a TTY.
 */
export async function gatePhasePlan(
	proposal: PhaseProposal,
	ask: () => Promise<readonly string[]>,
): Promise<PhaseGateResult> {
	if (proposal.decision === "propose") {
		return { phases: proposal.phases, asked: false };
	}
	const chosen = await ask();
	return { phases: normalizePhases(chosen), asked: true };
}
