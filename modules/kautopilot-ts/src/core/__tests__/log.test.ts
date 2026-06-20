import { describe, expect, it } from "bun:test";
import { readLog } from "../log";

// Test the log read/write helpers (appendEvent/readLog still in log.ts)
describe("readLog", () => {
	it("returns empty array for nonexistent session", () => {
		const log = readLog("nonexistent-session-id-test");
		expect(log).toEqual([]);
	});
});
