import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as YAML from "yaml";

// Override HOME to temp dir for config tests
const origHome = process.env.HOME;

describe("config", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kautopilot-test-"));
		process.env.HOME = tempDir;
	});

	afterEach(() => {
		process.env.HOME = origHome;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writeConfig creates config file with defaults", () => {
		const { writeConfig, readConfig } =
			require("../config") as typeof import("../config");
		const { DEFAULT_CONFIG } = require("../types") as typeof import("../types");
		writeConfig("testid", { ...DEFAULT_CONFIG });

		const config = readConfig("testid");
		expect(config).not.toBeNull();
		// Trimmed top-level shape: agents, templates, settings, orgs, writer — no kloop/binary.
		expect(Object.keys(config as object).sort()).toEqual([
			"agents",
			"orgs",
			"settings",
			"templates",
			"writer",
		]);
		expect((config as Record<string, unknown>).kloop).toBeUndefined();
		expect((config as Record<string, unknown>).claude_binary).toBeUndefined();
		// commit agent prompt is configurable via agents.generic.commit (resolved by getAgentPrompt)
		expect(config?.agents.generic.commit.prompt).toContain(
			"committing code changes",
		);
		expect((config?.agents as Record<string, unknown>).phase2).toBeUndefined();
		expect((config?.agents as Record<string, unknown>).phase3).toBeUndefined();
		expect(config?.settings.maxParallelRepos).toBe(2);
		expect(config?.settings.runMode).toBe("current-session");
		expect(config?.settings.execMode).toBe("kloop");
		expect(config?.orgs.liftoff).toEqual({
			ticketSystem: "jira",
			commitSpec: false,
			baseBranch: "master",
		});
		expect(config?.orgs.atomicloud).toEqual({
			ticketSystem: "clickup",
			commitSpec: true,
			baseBranch: "main",
		});

		expect(existsSync(join(tempDir, ".kautopilot/testid/config.yaml"))).toBe(
			true,
		);
	});

	it("readConfig returns null for missing config", () => {
		const { readConfig } = require("../config") as typeof import("../config");
		const result = readConfig("nonexistent");
		expect(result).toBeNull();
	});

	it("readConfig reads config back after writeConfig", () => {
		const { writeConfig, readConfig } =
			require("../config") as typeof import("../config");
		const { DEFAULT_CONFIG } = require("../types") as typeof import("../types");
		writeConfig("testid", { ...DEFAULT_CONFIG });
		const config = readConfig("testid");
		expect(config).not.toBeNull();
		expect(config?.settings.maxPushCycles).toBe(10);
		expect(config?.orgs.atomicloud.baseBranch).toBe("main");
	});

	it("writeConfig persists changes", () => {
		const { writeConfig, readConfig } =
			require("../config") as typeof import("../config");
		const { DEFAULT_CONFIG } = require("../types") as typeof import("../types");
		writeConfig("testid", { ...DEFAULT_CONFIG });

		const config = readConfig("testid")!;
		config.orgs.atomicloud.baseBranch = "develop";
		config.settings.maxPushCycles = 5;
		writeConfig("testid", config);

		const reloaded = readConfig("testid")!;
		expect(reloaded.orgs.atomicloud.baseBranch).toBe("develop");
		expect(reloaded.settings.maxPushCycles).toBe(5);
	});

	it("ensureGlobalConfig creates ~/.kautopilot/config.yaml", () => {
		const { ensureGlobalConfig, resolveConfig } =
			require("../config") as typeof import("../config");
		ensureGlobalConfig();
		expect(existsSync(join(tempDir, ".kautopilot/config.yaml"))).toBe(true);
		expect(resolveConfig().settings.maxPushCycles).toBe(10);
	});

	it("ensureGlobalConfig does not overwrite existing config", () => {
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		const { ensureGlobalConfig } =
			require("../config") as typeof import("../config");

		// Create a config with custom content
		const globalDir = join(tempDir, ".kautopilot");
		const { mkdirSync } = require("node:fs") as typeof import("node:fs");
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(
			join(globalDir, "config.yaml"),
			"claude_binary: my-custom-binary\n",
		);

		ensureGlobalConfig();

		// Should still have custom content
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const content = readFileSync(join(globalDir, "config.yaml"), "utf-8");
		expect(content).toContain("my-custom-binary");
	});

	it("resolveConfig rejects incomplete config files", () => {
		const { writeFileSync, mkdirSync } =
			require("node:fs") as typeof import("node:fs");
		const { resolveConfig } =
			require("../config") as typeof import("../config");

		const globalDir = join(tempDir, ".kautopilot");
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(
			join(globalDir, "config.yaml"),
			"claude_binary: custom-claude\n",
		);

		expect(() => resolveConfig()).toThrow("Invalid config");
	});

	it("resolveConfig reads a complete config without default overlay", () => {
		const { writeFileSync, mkdirSync } =
			require("node:fs") as typeof import("node:fs");
		const { resolveConfig } =
			require("../config") as typeof import("../config");
		const { DEFAULT_CONFIG } = require("../types") as typeof import("../types");
		const globalDir = join(tempDir, ".kautopilot");
		mkdirSync(globalDir, { recursive: true });

		const config = {
			...DEFAULT_CONFIG,
			settings: {
				...DEFAULT_CONFIG.settings,
				maxPushCycles: 11,
			},
		};
		writeFileSync(join(globalDir, "config.yaml"), YAML.stringify(config));

		const resolved = resolveConfig();
		expect(resolved.settings.maxPushCycles).toBe(11);
	});

	it("resolveConfig parses a legacy config with top-level binary and kloop section", () => {
		const { writeFileSync, mkdirSync } =
			require("node:fs") as typeof import("node:fs");
		const { resolveConfig } =
			require("../config") as typeof import("../config");
		const { DEFAULT_CONFIG } = require("../types") as typeof import("../types");
		const globalDir = join(tempDir, ".kautopilot");
		mkdirSync(globalDir, { recursive: true });

		// Legacy file carries a top-level binary + a kloop section on the old schema.
		// Both are dropped by normalizeConfigInput; the rest parses cleanly.
		const config = {
			...DEFAULT_CONFIG,
			binary: "legacy-claude",
			kloop: { binary: "legacy-claude", maxIterations: 11 },
		} as typeof DEFAULT_CONFIG & { binary: string; kloop: unknown };
		writeFileSync(join(globalDir, "config.yaml"), YAML.stringify(config));

		const resolved = resolveConfig();
		expect((resolved as Record<string, unknown>).kloop).toBeUndefined();
		expect((resolved as Record<string, unknown>).binary).toBeUndefined();
		expect(resolved.orgs.atomicloud.baseBranch).toBe("main");
	});

	it("resolveOrgPolicy reads from config orgs map", () => {
		const { ensureGlobalConfig } =
			require("../config") as typeof import("../config");
		const { resolveOrgPolicy } =
			require("../session-meta") as typeof import("../session-meta");
		ensureGlobalConfig();
		expect(resolveOrgPolicy("liftoff")).toEqual({
			org: "liftoff",
			ticketSystem: "jira",
			commitSpec: false,
			baseBranch: "master",
		});
		expect(resolveOrgPolicy("atomicloud")).toEqual({
			org: "atomicloud",
			ticketSystem: "clickup",
			commitSpec: true,
			baseBranch: "main",
		});
	});

	it("resolveOrgPolicy honors config overrides for an org", () => {
		const { ensureGlobalConfig, readConfig, writeFileSync } = {
			...(require("../config") as typeof import("../config")),
			...(require("node:fs") as typeof import("node:fs")),
		};
		const { resolveOrgPolicy } =
			require("../session-meta") as typeof import("../session-meta");
		ensureGlobalConfig();
		const config = readConfig("");
		if (!config) throw new Error("expected global config");
		config.orgs.liftoff.baseBranch = "trunk";
		config.orgs.liftoff.commitSpec = true;
		writeFileSync(
			join(tempDir, ".kautopilot/config.yaml"),
			YAML.stringify(config),
		);
		expect(resolveOrgPolicy("liftoff")).toEqual({
			org: "liftoff",
			ticketSystem: "jira",
			commitSpec: true,
			baseBranch: "trunk",
		});
	});

	it("resolveOrgPolicy falls back to ORG_DEFAULTS when org absent from config", () => {
		const { ensureGlobalConfig, readConfig, writeFileSync } = {
			...(require("../config") as typeof import("../config")),
			...(require("node:fs") as typeof import("node:fs")),
		};
		const { resolveOrgPolicy } =
			require("../session-meta") as typeof import("../session-meta");
		ensureGlobalConfig();
		const config = readConfig("");
		if (!config) throw new Error("expected global config");
		// Remove orgs from config so resolveOrgPolicy must use built-in ORG_DEFAULTS.
		config.orgs = {};
		writeFileSync(
			join(tempDir, ".kautopilot/config.yaml"),
			YAML.stringify(config),
		);
		// Built-in fallback values (must match ORG_DEFAULTS in session-meta.ts).
		expect(resolveOrgPolicy("liftoff")).toEqual({
			org: "liftoff",
			ticketSystem: "jira",
			commitSpec: false,
			baseBranch: "master",
		});
		expect(resolveOrgPolicy("atomicloud")).toEqual({
			org: "atomicloud",
			ticketSystem: "clickup",
			commitSpec: true,
			baseBranch: "main",
		});
	});

	it("config has no roles or steps", () => {
		const { writeConfig, readConfig } =
			require("../config") as typeof import("../config");
		const { DEFAULT_CONFIG } = require("../types") as typeof import("../types");
		writeConfig("testid", { ...DEFAULT_CONFIG });
		const config = readConfig("testid")!;
		expect((config as Record<string, unknown>).roles).toBeUndefined();
		expect((config as Record<string, unknown>).steps).toBeUndefined();
	});
});
