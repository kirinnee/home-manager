import { afterEach, describe, expect, it } from "bun:test";
import { getAgentPrompt, setCachedConfig } from "../agents";
import { DEFAULT_CONFIG } from "../types";

describe("agents", () => {
	afterEach(() => {
		setCachedConfig(null);
	});

	it("throws on a missing prompt for a known phase", () => {
		setCachedConfig(null);
		expect(() => getAgentPrompt("phase1", "nonexistent")).toThrow(
			/No agent prompt configured/,
		);
	});

	it("falls back to a generic prompt for an unknown phase", () => {
		setCachedConfig(null);
		expect(getAgentPrompt("phaseX", "anything")).toContain("anything");
	});

	it("resolves prompts from the cached config", () => {
		setCachedConfig({
			...DEFAULT_CONFIG,
			agents: {
				...DEFAULT_CONFIG.agents,
				phase1: {
					...DEFAULT_CONFIG.agents.phase1,
					triage: { prompt: "ORG-OVERRIDDEN TRIAGE PROMPT" },
				},
			},
		});

		expect(getAgentPrompt("phase1", "triage")).toBe(
			"ORG-OVERRIDDEN TRIAGE PROMPT",
		);
	});
});
