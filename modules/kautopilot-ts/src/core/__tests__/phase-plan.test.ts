import { describe, expect, it } from "bun:test";
import {
	CANONICAL_PHASES,
	DEFAULT_CONFIDENCE_THRESHOLD,
	DEFAULT_PHASE_KEYWORDS,
	DEFAULT_PHASES,
	gatePhasePlan,
	hasPhase,
	isPhase,
	isPlanOnly,
	matchedKeywords,
	normalizePhases,
	type Phase,
	type PhaseProposal,
	parsePhasesArg,
	proposePhases,
	sessionPhases,
} from "../phase-plan";

const cfg = {
	keywords: DEFAULT_PHASE_KEYWORDS,
	defaultPhases: [...DEFAULT_PHASES] as Phase[],
	confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
};

describe("normalizePhases — validation, dedupe, plan mandatory, canonical order", () => {
	it("forces plan in and orders canonically", () => {
		expect(normalizePhases(["spec"])).toEqual(["spec", "plan"]);
		expect(normalizePhases(["plan"])).toEqual(["plan"]);
		expect(normalizePhases([])).toEqual(["plan"]);
	});

	it("dedupes and re-orders arbitrary input to canonical order", () => {
		expect(normalizePhases(["plan", "brainstorm", "plan", "triage"])).toEqual([
			"brainstorm",
			"triage",
			"plan",
		]);
	});

	it("is case-insensitive and trims", () => {
		expect(normalizePhases([" SPEC ", "Plan"])).toEqual(["spec", "plan"]);
	});

	it("throws on an unknown phase name", () => {
		expect(() => normalizePhases(["design", "plan"])).toThrow("Unknown phase");
	});

	it("the full set is exactly the canonical order", () => {
		expect(normalizePhases([...CANONICAL_PHASES])).toEqual([
			"brainstorm",
			"triage",
			"spec",
			"plan",
		]);
	});
});

describe("parsePhasesArg", () => {
	it("splits on commas and whitespace", () => {
		expect(parsePhasesArg("spec,plan")).toEqual(["spec", "plan"]);
		expect(parsePhasesArg("brainstorm triage spec plan")).toEqual([
			"brainstorm",
			"triage",
			"spec",
			"plan",
		]);
		expect(parsePhasesArg("plan")).toEqual(["plan"]);
	});
});

describe("isPlanOnly / hasPhase / sessionPhases", () => {
	it("isPlanOnly is true only for exactly [plan]", () => {
		expect(isPlanOnly(["plan"])).toBe(true);
		expect(isPlanOnly(["spec", "plan"])).toBe(false);
		expect(isPlanOnly(["brainstorm", "plan"])).toBe(false);
	});

	it("sessionPhases defaults to the full canonical set for pre-feature sessions", () => {
		expect(sessionPhases({})).toEqual([...CANONICAL_PHASES]);
		expect(sessionPhases({ phases: [] })).toEqual([...CANONICAL_PHASES]);
		expect(sessionPhases({ phases: ["plan"] })).toEqual(["plan"]);
	});

	it("hasPhase reflects the pinned set", () => {
		expect(hasPhase({ phases: ["spec", "plan"] }, "spec")).toBe(true);
		expect(hasPhase({ phases: ["spec", "plan"] }, "triage")).toBe(false);
		expect(hasPhase({ phases: ["plan"] }, "plan")).toBe(true);
	});

	it("isPhase accepts only canonical names", () => {
		expect(isPhase("plan")).toBe(true);
		expect(isPhase("design")).toBe(false);
	});
});

describe("matchedKeywords — word-boundary, case-insensitive", () => {
	it("matches whole words and multi-word phrases", () => {
		expect(matchedKeywords("a quick fix", ["quick"])).toEqual(["quick"]);
		expect(
			matchedKeywords("let's bounce ideas around", ["bounce ideas"]),
		).toEqual(["bounce ideas"]);
	});

	it("does not match keywords embedded in larger words", () => {
		expect(matchedKeywords("a smallish job", ["small"])).toEqual([]);
		expect(matchedKeywords("fix breakfast", ["fast"])).toEqual([]);
	});

	it("returns [] for empty text or blank keywords", () => {
		expect(matchedKeywords("", ["small"])).toEqual([]);
		expect(matchedKeywords("small", ["", "  "])).toEqual([]);
	});
});

describe("proposePhases — one class per keyword group + confidence gate", () => {
	it("plan-only cue → [plan], high confidence, propose", () => {
		const p = proposePhases("just a small quick fix", cfg);
		expect(p.phases).toEqual(["plan"]);
		expect(p.confidence).toBeGreaterThanOrEqual(cfg.confidenceThreshold);
		expect(p.decision).toBe("propose");
	});

	it("full cue → all four phases, high confidence, propose", () => {
		const p = proposePhases("this is a big risky migration", cfg);
		expect(p.phases).toEqual(["brainstorm", "triage", "spec", "plan"]);
		expect(p.confidence).toBeGreaterThanOrEqual(cfg.confidenceThreshold);
		expect(p.decision).toBe("propose");
	});

	it("brainstorm cue → default set plus brainstorm, medium confidence, ask", () => {
		const p = proposePhases("I'm unsure, let's discuss this", cfg);
		expect(p.phases).toContain("brainstorm");
		expect(p.phases).toContain("plan");
		expect(p.confidence).toBeLessThan(cfg.confidenceThreshold);
		expect(p.decision).toBe("ask");
	});

	it("conflicting cues → default set, low confidence, ask", () => {
		const p = proposePhases("a small but big change", cfg);
		expect(p.phases).toEqual([...DEFAULT_PHASES]);
		expect(p.confidence).toBeLessThan(cfg.confidenceThreshold);
		expect(p.decision).toBe("ask");
	});

	it("no cue → default set, low confidence, ask", () => {
		const p = proposePhases("refactor the auth module", cfg);
		expect(p.phases).toEqual([...DEFAULT_PHASES]);
		expect(p.decision).toBe("ask");
	});

	it("no request text → default set, ask", () => {
		const p = proposePhases(undefined, cfg);
		expect(p.phases).toEqual([...DEFAULT_PHASES]);
		expect(p.decision).toBe("ask");
	});

	it("honors a custom threshold (propose below 0.6 when threshold is low)", () => {
		const p = proposePhases("let's brainstorm", {
			...cfg,
			confidenceThreshold: 0.5,
		});
		expect(p.decision).toBe("propose");
	});
});

describe("gatePhasePlan — the confidence gate gates BEFORE commit", () => {
	const propose: PhaseProposal = {
		phases: ["plan"],
		confidence: 0.9,
		decision: "propose",
		reasons: [],
	};
	const ambiguous: PhaseProposal = {
		phases: [...DEFAULT_PHASES],
		confidence: 0.3,
		decision: "ask",
		reasons: ["conflicting cues"],
	};

	it("confident → proceeds with the proposal, NEVER calls ask", async () => {
		let asked = false;
		const r = await gatePhasePlan(propose, async () => {
			asked = true;
			return ["brainstorm", "triage", "spec", "plan"];
		});
		expect(asked).toBe(false);
		expect(r.asked).toBe(false);
		expect(r.phases).toEqual(["plan"]);
	});

	it("low confidence → asks FIRST, then pins the (normalized) answer", async () => {
		let asked = false;
		const r = await gatePhasePlan(ambiguous, async () => {
			asked = true;
			return ["spec"]; // user clarifies to a smaller set
		});
		expect(asked).toBe(true);
		expect(r.asked).toBe(true);
		// The user's answer wins over the low-confidence guess, normalized (plan forced in).
		expect(r.phases).toEqual(["spec", "plan"]);
	});
});
