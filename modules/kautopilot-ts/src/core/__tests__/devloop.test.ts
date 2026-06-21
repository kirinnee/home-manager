import { describe, expect, it } from "bun:test";
import { devloopVerify } from "../devloop";

describe("devloop helpers", () => {
	describe("devloopVerify", () => {
		it("never reports a phantom run as completed", () => {
			// A run the binary can't positively confirm as completed must NOT yield
			// "completed" — that's the anti-silent-success guarantee behind decision A.
			// (No kloop binary → "unavailable"; unknown/unconfirmable run → "crash".)
			const valid = [
				"completed",
				"max_iterations",
				"conflict",
				"crash",
				"running",
				"unavailable",
			];
			const outcome = devloopVerify("kautopilot-no-such-run");
			expect(valid).toContain(outcome);
			expect(outcome).not.toBe("completed");
		});
	});
});
