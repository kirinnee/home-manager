import { describe, expect, it } from "bun:test";
import { generateSessionId } from "../id";

describe("generateSessionId", () => {
	it("generates 8-character base36 ID", () => {
		const id = generateSessionId();
		expect(id).toHaveLength(8);
		expect(id).toMatch(/^[0-9a-z]+$/);
	});

	it("generates unique IDs", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
		expect(ids.size).toBe(100);
	});
});
