import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeKloopSpec } from "../devloop";

let origHome: string;
let tempHome: string;
beforeAll(() => {
	origHome = process.env.HOME!;
	tempHome = mkdtempSync(join(tmpdir(), "kautopilot-devloop-test-"));
	process.env.HOME = tempHome;
});
afterAll(() => {
	process.env.HOME = origHome;
	rmSync(tempHome, { recursive: true, force: true });
});

describe("devloop helpers", () => {
	const testDir = join(process.env.HOME!, ".kautopilot", "__test_devloop__");

	// Clean up before and after
	const cleanup = () => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {}
	};

	describe("writeKloopSpec", () => {
		it("writes spec file to session tmp dir", () => {
			cleanup();
			const specPath = writeKloopSpec("__test_devloop__", "# Test Spec\nHello");
			expect(existsSync(specPath)).toBe(true);
			expect(readFileSync(specPath, "utf-8")).toBe("# Test Spec\nHello");
			expect(specPath).toContain("__test_devloop__/tmp/kloop-spec.md");
			cleanup();
		});

		it("supports custom filename", () => {
			cleanup();
			const specPath = writeKloopSpec(
				"__test_devloop__",
				"content",
				"plan-1-spec.md",
			);
			expect(specPath).toContain("plan-1-spec.md");
			cleanup();
		});
	});
});
