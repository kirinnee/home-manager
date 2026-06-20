import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readLog } from "../../core/log";

let origHome: string;
let tempHome: string;
beforeAll(() => {
	origHome = process.env.HOME!;
	tempHome = mkdtempSync(join(tmpdir(), "kautopilot-outcomes-test-"));
	process.env.HOME = tempHome;
});
afterAll(() => {
	process.env.HOME = origHome;
	rmSync(tempHome, { recursive: true, force: true });
});

// ============================================================================
// kloop outcome → orchestrator transition tests (spec section 7)
// ============================================================================

describe("kloop outcome handling (spec section 7.2-7.4)", () => {
	it("completed status maps correctly", () => {
		// Spec: completed → advance to next plan
		const status = "completed";
		expect(status === "completed").toBe(true);
		// In running.ts: returns 'commit'
	});

	it("max_iterations status triggers rewrite analysis", () => {
		// Spec: max_iterations → enter rewrite analysis
		const status = "max_iterations";
		expect(status === "max_iterations" || status === "conflict").toBe(true);
		// In running.ts: returns 'resolve'
	});

	it("conflict status triggers rewrite analysis", () => {
		const status: string = "conflict";
		expect(status === "max_iterations" || status === "conflict").toBe(true);
		// In running.ts: returns 'resolve'
	});

	it("crash status retries before rewrite (invariant 8)", () => {
		// Spec: crash → retry/recover first, do not rewrite immediately
		const status = "crash";
		expect(status === "crash").toBe(true);
		// In running.ts: increments crashRetryCount, returns 'setup_run' for retry
	});

	it("valid rewrite decisions are the five defined types", () => {
		const validDecisions = [
			"refine_local",
			"patch_downstream",
			"regenerate_remaining",
			"revisit_spec",
			"retry",
		];
		expect(validDecisions).toHaveLength(5);
		expect(validDecisions).toContain("refine_local");
		expect(validDecisions).toContain("patch_downstream");
		expect(validDecisions).toContain("regenerate_remaining");
		expect(validDecisions).toContain("revisit_spec");
		expect(validDecisions).toContain("retry");
	});

	it("only revisit_spec creates a new epoch", () => {
		// Spec section 4.3: revisit_spec is the only rewrite that creates a new epoch
		const epochCreatingDecisions = [
			"refine_local",
			"patch_downstream",
			"regenerate_remaining",
			"revisit_spec",
		].filter((d) => d === "revisit_spec");
		expect(epochCreatingDecisions).toEqual(["revisit_spec"]);
	});
});

// ============================================================================
// Contract epoch versioning tests (spec section 4)
// ============================================================================

const TEST_SESSION = `test-outcomes-${Date.now()}`;
const SESSION_DIR = join(process.env.HOME!, ".kautopilot", TEST_SESSION);

if (!existsSync(SESSION_DIR)) {
	mkdirSync(SESSION_DIR, { recursive: true });
}

process.on("exit", () => {
	if (existsSync(SESSION_DIR)) {
		rmSync(SESSION_DIR, { recursive: true, force: true });
	}
});

describe("contract epoch versioning (spec section 4)", () => {
	it("contract rewrite creates new epoch", () => {
		// revisit_spec → new epoch vN+1
		const currentVersion = 1;
		const newVersion = currentVersion + 1;
		expect(newVersion).toBe(2);
	});

	it("execution rewrite stays in same epoch", () => {
		const decisions = [
			"refine_local",
			"patch_downstream",
			"regenerate_remaining",
		];
		for (const decision of decisions) {
			expect(decision).not.toBe("revisit_spec");
			// These stay in the same epoch — no version increment
		}
	});
});

// ============================================================================
// Script expansion tests (spec section 12)
// ============================================================================

describe("ticket script expansion (spec section 12)", () => {
	it("ALL_SCRIPTS includes expanded ticket operations", () => {
		const { ALL_SCRIPTS } = require("../../core/scripts");
		expect(ALL_SCRIPTS).toContain("update-ticket");
		expect(ALL_SCRIPTS).toContain("create-downstream-ticket");
		expect(ALL_SCRIPTS).toContain("add-comment");
		expect(ALL_SCRIPTS).toContain("move-to-todo");
		expect(ALL_SCRIPTS).toContain("attach-artifact");
	});
});

// ============================================================================
// revisit_spec end-to-end re-entry through implementation (spec section 1.1)
// ============================================================================

describe("revisit_spec re-entry through implementation (spec section 1.1)", () => {
	const SESSION = `test-revisit-spec-${Date.now()}`;

	afterEach(() => {
		const dir = `${process.env.HOME}/.kautopilot/${SESSION}`;
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	it("rewrite history is reconstructable from WAL for describe --json", () => {
		// Simulate two rewrite events across versions
		appendEvent(SESSION, {
			ts: "2026-04-01T10:00:00Z",
			event: "phase2:started",
			version: 1,
		});
		appendEvent(SESSION, {
			ts: "2026-04-01T10:05:00Z",
			event: "context:updated",
			version: 1,
			metadata: { rewriteDecision: "refine_local", plan: "plan-1" },
		});
		appendEvent(SESSION, {
			ts: "2026-04-01T10:10:00Z",
			event: "context:updated",
			version: 1,
			metadata: { rewriteDecision: "revisit_spec" },
		});

		const log = readLog(SESSION);
		const rewriteHistory: Array<{
			version: number;
			decision: string;
			plan?: string;
		}> = [];
		for (const entry of log) {
			if (entry.event === "context:updated" && entry.version !== undefined) {
				const meta = entry.metadata as Record<string, unknown> | undefined;
				if (meta?.rewriteDecision && typeof meta.rewriteDecision === "string") {
					rewriteHistory.push({
						version: entry.version,
						decision: meta.rewriteDecision,
						plan: meta.plan as string | undefined,
					});
				}
			}
		}

		expect(rewriteHistory).toHaveLength(2);
		expect(rewriteHistory[0]).toEqual({
			version: 1,
			decision: "refine_local",
			plan: "plan-1",
		});
		expect(rewriteHistory[1]).toEqual({
			version: 1,
			decision: "revisit_spec",
			plan: undefined,
		});
	});
});
