import { describe, expect, it } from "bun:test";
import { formatDuration } from "../format";

describe("formatDuration", () => {
	it("formats 0 ms", () => {
		expect(formatDuration(0)).toBe("0s");
	});

	it("formats seconds", () => {
		expect(formatDuration(5000)).toBe("5s");
	});

	it("formats minutes and seconds", () => {
		expect(formatDuration(125000)).toBe("2m 05s");
	});

	it("formats hours, minutes, seconds", () => {
		expect(formatDuration(3725000)).toBe("1h 02m 05s");
	});

	it("handles negative values", () => {
		expect(formatDuration(-1000)).toBe("0s");
	});
});
