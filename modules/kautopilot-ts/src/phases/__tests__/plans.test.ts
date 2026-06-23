import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("plan file resolution (spec section 5.3)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kautopilot-plans-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("resolveActivePlans returns highest rewrite per ordinal", () => {
		const { resolveActivePlans } = require("../shared");
		// Create plan files with multiple rewrites
		writeFileSync(join(tempDir, "plan-1-1.md"), "# Plan 1 v1");
		writeFileSync(join(tempDir, "plan-1-2.md"), "# Plan 1 v2");
		writeFileSync(join(tempDir, "plan-1-3.md"), "# Plan 1 v3");
		writeFileSync(join(tempDir, "plan-2-1.md"), "# Plan 2 v1");
		writeFileSync(join(tempDir, "plan-3-1.md"), "# Plan 3 v1");
		writeFileSync(join(tempDir, "plan-3-2.md"), "# Plan 3 v2");

		const plans = resolveActivePlans(tempDir);
		expect(plans).toHaveLength(3);
		expect(plans[0]).toEndWith("plan-1-3.md");
		expect(plans[1]).toEndWith("plan-2-1.md");
		expect(plans[2]).toEndWith("plan-3-2.md");
	});

	it("resolveActivePlans sorts by ordinal", () => {
		const { resolveActivePlans } = require("../shared");
		writeFileSync(join(tempDir, "plan-3-1.md"), "# Plan 3");
		writeFileSync(join(tempDir, "plan-1-1.md"), "# Plan 1");
		writeFileSync(join(tempDir, "plan-2-1.md"), "# Plan 2");

		const plans = resolveActivePlans(tempDir);
		expect(plans).toHaveLength(3);
		expect(plans[0]).toEndWith("plan-1-1.md");
		expect(plans[1]).toEndWith("plan-2-1.md");
		expect(plans[2]).toEndWith("plan-3-1.md");
	});

	it("resolveActivePlans handles empty directory", () => {
		const { resolveActivePlans } = require("../shared");
		const plans = resolveActivePlans(tempDir);
		expect(plans).toHaveLength(0);
	});

	it("resolveActivePlans handles nonexistent directory", () => {
		const { resolveActivePlans } = require("../shared");
		const plans = resolveActivePlans(join(tempDir, "nonexistent"));
		expect(plans).toHaveLength(0);
	});

	it("rewrite does not overwrite prior plan files", () => {
		const { resolveActivePlans } = require("../shared");
		writeFileSync(join(tempDir, "plan-1-1.md"), "# Original");

		// Simulate a rewrite (new file, no overwrite)
		writeFileSync(join(tempDir, "plan-1-2.md"), "# Rewritten");

		// Both files must still exist
		expect(existsSync(join(tempDir, "plan-1-1.md"))).toBe(true);
		expect(existsSync(join(tempDir, "plan-1-2.md"))).toBe(true);

		// Active plan should be the rewrite
		const plans = resolveActivePlans(tempDir);
		expect(plans).toHaveLength(1);
		expect(plans[0]).toEndWith("plan-1-2.md");
	});

	it("legacy flat files are handled as rewrite 1", () => {
		const { resolveActivePlans } = require("../shared");
		writeFileSync(join(tempDir, "plan-1.md"), "# Legacy plan 1");
		writeFileSync(join(tempDir, "plan-2.md"), "# Legacy plan 2");

		const plans = resolveActivePlans(tempDir);
		expect(plans).toHaveLength(2);
		expect(plans[0]).toEndWith("plan-1.md");
		expect(plans[1]).toEndWith("plan-2.md");
	});

	it("mixed legacy and spec convention resolves correctly", () => {
		const { resolveActivePlans } = require("../shared");
		writeFileSync(join(tempDir, "plan-1.md"), "# Legacy");
		writeFileSync(join(tempDir, "plan-1-2.md"), "# Spec rewrite");

		const plans = resolveActivePlans(tempDir);
		expect(plans).toHaveLength(1);
		// plan-1-2.md has rewrite=2 which is higher than plan-1.md (rewrite=1)
		expect(plans[0]).toEndWith("plan-1-2.md");
	});

	// --- BUG 1 regression: descriptive plan folder names (author-chosen) ---------
	// `write_plans` lets the author name a plan folder `plan-1-foundation/`, which
	// `seed` copies into the worktree as `plan-1-foundation.md`. These used to be
	// dropped here (matched neither the `plan-N-N` nor `plan-N` regex), so `running`
	// resolved a reconstructed `plan-1.md` that was never written → kloop init failed.
	it("descriptive plan names resolve by their leading ordinal", () => {
		const { resolveActivePlans } = require("../shared");
		writeFileSync(join(tempDir, "plan-1-foundation.md"), "# Foundation");
		writeFileSync(join(tempDir, "plan-2-formatting.md"), "# Formatting");
		writeFileSync(join(tempDir, "plan-3-translation.md"), "# Translation");

		const plans = resolveActivePlans(tempDir);
		expect(plans).toHaveLength(3);
		expect(plans[0]).toEndWith("plan-1-foundation.md");
		expect(plans[1]).toEndWith("plan-2-formatting.md");
		expect(plans[2]).toEndWith("plan-3-translation.md");
	});

	it("descriptive names sort by NUMERIC ordinal, not lexically (>= 10 plans)", () => {
		const { resolveActivePlans } = require("../shared");
		writeFileSync(join(tempDir, "plan-2-b.md"), "# 2");
		writeFileSync(join(tempDir, "plan-10-j.md"), "# 10");
		writeFileSync(join(tempDir, "plan-1-a.md"), "# 1");

		const plans = resolveActivePlans(tempDir);
		expect(plans).toHaveLength(3);
		expect(plans[0]).toEndWith("plan-1-a.md");
		expect(plans[1]).toEndWith("plan-2-b.md");
		expect(plans[2]).toEndWith("plan-10-j.md"); // not before plan-2 (lexical would)
	});

	it("a numeric second segment is still the rewrite, not a descriptive slug", () => {
		const { resolveActivePlans } = require("../shared");
		// plan-1-foundation (rewrite 1, descriptive) vs plan-1-2 (rewrite 2) — the
		// numeric-rewrite form wins for the same ordinal.
		writeFileSync(join(tempDir, "plan-1-foundation.md"), "# desc r1");
		writeFileSync(join(tempDir, "plan-1-2.md"), "# rewrite 2");

		const plans = resolveActivePlans(tempDir);
		expect(plans).toHaveLength(1);
		expect(plans[0]).toEndWith("plan-1-2.md");
	});

	it("non-plan files are ignored", () => {
		const { resolveActivePlans } = require("../shared");
		writeFileSync(join(tempDir, "plan-1-foundation.md"), "# Foundation");
		writeFileSync(join(tempDir, "resolution.md"), "# not a plan");
		writeFileSync(join(tempDir, "README.md"), "# nope");

		const plans = resolveActivePlans(tempDir);
		expect(plans).toHaveLength(1);
		expect(plans[0]).toEndWith("plan-1-foundation.md");
	});
});
