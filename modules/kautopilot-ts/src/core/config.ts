import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as YAML from "yaml";
import type { Config } from "./types";
import { configSchema, DEFAULT_CONFIG } from "./types";

// ============================================================================
// Variable descriptions for generated config comments
// ============================================================================

const PROMPT_VARS: Record<string, Record<string, string>> = {
	"agents.phase1.triage": {
		ticket: "path to the ticket file",
	},
	"agents.phase1.spec_writer": {
		ticket: "path to the ticket file",
		triage: "path to the triage file",
	},
	"agents.phase1.plan_writer": {
		spec: "path to the spec file",
		triage: "path to the triage file",
	},
	"agents.phase1.spec_reviewers.*": {
		spec: "path to the spec file",
		ticket: "path to the ticket file",
		triage:
			"path to the triage file (for the high_level / grounding reviewers)",
	},
	"agents.phase1.plan_reviewers.*": {
		plans: "path to the plans directory",
		spec: "path to the spec file",
	},
	"agents.phase2.resolve": {
		plan: 'name of the current plan (e.g., "plan-1")',
		spec: "path to the current plan file",
		taskSpec: "path to the task spec file",
		reason: 'reason for resolve ("conflict" or "retry")',
		attempt: "attempt number (1-indexed)",
	},
	"agents.phase2.amend_plans": {
		resolution_path: "path to the resolution document written by resolve TTY",
		task_spec_path: "path to the task spec file",
		plans_dir: "path to the plans directory",
		kloop_evidence: "output from kloop describe",
	},
	"agents.phase3.eval": {
		spec_path: "path to the task spec file",
		plan_paths: "paths to plan files (newline-separated)",
	},
	"agents.phase3.write_fix": {
		// Context prepended by handler, not user-configurable
	},
	"agents.phase3.create_pr": {
		baseBranch: 'the base branch name (e.g., "main")',
		ticketId: "the ticket ID",
		spec_path: "path to the spec file",
	},
	"agents.phase3.prereview_classify": {
		// Content prepended by handler
	},
	"agents.phase3.prereview_fix": {
		// Content prepended by handler
	},
	"agents.phase3.tty_resolve_ambiguous": {
		// Context prepended by handler
	},
	"agents.phase3.tty_resolve_conflict": {
		// Context prepended by handler
	},
	"agents.phase3.tty_resolve_failure": {
		// Context prepended by handler
	},
	"agents.generic.commit": {
		context: "optional context (e.g., plan path, reason for commit)",
	},
};

/**
 * Build variable comment lines for a prompt path.
 * Returns empty string if no variables defined.
 */
function buildVarComments(path: string): string {
	const vars = PROMPT_VARS[path];
	if (!vars || Object.keys(vars).length === 0) return "";
	const lines = Object.entries(vars)
		.map(([v, desc]) => `# {${v}} - ${desc}`)
		.join("\n");
	return `${lines}\n`;
}

/**
 * Serialize config to YAML with variable comments for prompts.
 * This ensures users know what variables are available.
 */
export function serializeConfigWithComments(config: Config): string {
	const lines: string[] = [
		"# kautopilot global config",
		"# Edit these to customize agent behavior.",
		"",
	];

	// Agents section
	lines.push("agents:");
	for (const [phaseKey, phaseAgents] of Object.entries(config.agents)) {
		lines.push(`  ${phaseKey}:`);
		if (phaseKey === "phase1") {
			const p1 = phaseAgents as Config["agents"]["phase1"];
			// triage, spec_writer, plan_writer
			for (const agent of ["triage", "spec_writer", "plan_writer"] as const) {
				const path = `agents.phase1.${agent}`;
				lines.push(`    ${agent}:`);
				const cfg = p1[agent] as { prompt: string };
				lines.push(createPromptBlock(path, cfg.prompt, 6));
			}
			// spec_reviewers
			lines.push("    spec_reviewers:");
			for (const [name, reviewer] of Object.entries(p1.spec_reviewers)) {
				const path = "agents.phase1.spec_reviewers.*";
				lines.push(`      ${name}:`);
				lines.push(`        desc: ${JSON.stringify(reviewer.desc)}`);
				const varComments = buildVarComments(path);
				// Variable comments go BEFORE prompt: as YAML comments
				if (varComments) {
					lines.push(indentLines(varComments.trimEnd(), 8));
				}
				lines.push(`        prompt: |`);
				lines.push(indentLines(reviewer.prompt, 10));
			}
			// plan_reviewers
			lines.push("    plan_reviewers:");
			for (const [name, reviewer] of Object.entries(p1.plan_reviewers)) {
				const path = "agents.phase1.plan_reviewers.*";
				lines.push(`      ${name}:`);
				lines.push(`        desc: ${JSON.stringify(reviewer.desc)}`);
				const varComments = buildVarComments(path);
				// Variable comments go BEFORE prompt: as YAML comments
				if (varComments) {
					lines.push(indentLines(varComments.trimEnd(), 8));
				}
				lines.push(`        prompt: |`);
				lines.push(indentLines(reviewer.prompt, 10));
			}
		} else if (phaseKey === "phase2" || phaseKey === "phase3") {
			for (const [agentName, agentConfig] of Object.entries(
				phaseAgents as Record<string, { prompt: string }>,
			) as [string, { prompt: string }][]) {
				const path = `agents.${phaseKey}.${agentName}`;
				lines.push(`    ${agentName}:`);
				lines.push(createPromptBlock(path, agentConfig.prompt, 6));
			}
		} else if (phaseKey === "generic") {
			const genericAgents = phaseAgents as Config["agents"]["generic"];
			for (const [agentName, agentConfig] of Object.entries(genericAgents) as [
				string,
				{ prompt: string },
			][]) {
				const path = `agents.generic.${agentName}`;
				lines.push(`    ${agentName}:`);
				lines.push(createPromptBlock(path, agentConfig.prompt, 6));
			}
		}
	}
	lines.push("");

	// Templates section
	lines.push("templates:");
	for (const [key, value] of Object.entries(config.templates)) {
		lines.push(`  ${key}: |`);
		lines.push(indentLines(value, 4));
	}
	lines.push("");

	// Settings section
	lines.push("settings:");
	lines.push(`  maxPushCycles: ${config.settings.maxPushCycles}`);
	lines.push(`  pollInterval: ${config.settings.pollInterval}`);
	lines.push(`  coderabbit: ${config.settings.coderabbit}`);
	lines.push(`  maxParallelRepos: ${config.settings.maxParallelRepos}`);
	lines.push(`  runMode: ${config.settings.runMode}`);
	lines.push(`  execMode: ${config.settings.execMode}`);
	lines.push(`  viewerBaseUrl: ${config.settings.viewerBaseUrl}`);
	lines.push(`  kloopBaseUrl: ${config.settings.kloopBaseUrl}`);
	lines.push(`  viewerPort: ${config.settings.viewerPort}`);
	lines.push("");

	// Orgs section — per-org policy (the single source of truth).
	lines.push("# Per-org policy. Org is always asked, never auto-detected.");
	lines.push("orgs:");
	for (const [org, policy] of Object.entries(config.orgs)) {
		lines.push(`  ${org}:`);
		lines.push(`    ticketSystem: ${policy.ticketSystem}`);
		lines.push(`    commitSpec: ${policy.commitSpec}`);
		lines.push(`    baseBranch: ${policy.baseBranch}`);
	}

	return `${lines.join("\n")}\n`;
}

/**
 * Create a prompt block with variable comments as YAML comments before the prompt key.
 * @param path - the agent path for looking up variable descriptions
 * @param prompt - the prompt content
 * @param indentSpaces - how many spaces to indent the entire block
 */
function createPromptBlock(
	path: string,
	prompt: string,
	indentSpaces: number,
): string {
	const varComments = buildVarComments(path);
	const indent = " ".repeat(indentSpaces);
	const indentedPrompt = indentLines(prompt, indentSpaces + 2);

	// Variable comments go BEFORE prompt: as YAML comments
	if (varComments) {
		const indentedComments = indentLines(varComments.trimEnd(), indentSpaces);
		return `${indentedComments}\n${indent}prompt: |\n${indentedPrompt}`;
	}
	return `${indent}prompt: |\n${indentedPrompt}`;
}

function indentLines(text: string, spaces: number): string {
	const indent = " ".repeat(spaces);
	return text
		.split("\n")
		.map((line) => indent + line)
		.join("\n");
}

function configPath(id: string): string {
	return `${process.env.HOME}/.kautopilot/${id}/config.yaml`;
}

function normalizeConfigInput(input: unknown): unknown {
	if (input && typeof input === "object" && !Array.isArray(input)) {
		const raw = { ...(input as Record<string, unknown>) };
		// Legacy: a binary lived at the top level (`claude_binary` or `binary`) and a
		// `kloop:` section held kloop's native config. kautopilot no longer owns any
		// binary or kloop config (kloop runs on its own native config), so drop them.
		// Zod strips remaining unknown keys; explicitly removing these keeps the parse
		// of older config files clean.
		raw.claude_binary = undefined;
		raw.binary = undefined;
		raw.kloop = undefined;
		return raw;
	}
	return input;
}

function parseConfigYaml(raw: string, source: string): Config {
	const parsed = normalizeConfigInput(YAML.parse(raw) as unknown);
	const result = configSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(`Invalid config at ${source}: ${result.error.message}`);
	}
	return result.data;
}

export function readConfig(id: string): Config | null {
	const path = configPath(id);
	if (!existsSync(path)) {
		return null;
	}
	const raw = readFileSync(path, "utf-8");
	return parseConfigYaml(raw, path);
}

export function writeConfig(id: string, config: Config): void {
	const path = configPath(id);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, YAML.stringify(config));
}

// ============================================================================
// Config resolution (init-time)
// ============================================================================

function globalConfigPath(): string {
	return `${process.env.HOME}/.kautopilot/config.yaml`;
}

function orgConfigPath(org: string): string {
	return `${process.env.HOME}/.kautopilot/orgs/${org}/config.yaml`;
}

/**
 * Ensure ~/.kautopilot/config.yaml exists with built-in defaults.
 * Called on first init or org init. Runtime loading does not merge these
 * defaults into user/org/session config files.
 */
export function ensureGlobalConfig(): void {
	const path = globalConfigPath();
	if (existsSync(path)) return;

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, serializeConfigWithComments(DEFAULT_CONFIG));
}

/**
 * Pick which config file to use (only one wins, not merged).
 * Priority: --config flag > org config > global config
 */
function pickConfig(org?: string, configPathOverride?: string): string | null {
	if (configPathOverride) return configPathOverride;
	if (org) {
		const orgPath = orgConfigPath(org);
		if (existsSync(orgPath)) return orgPath;
	}
	return globalConfigPath();
}

/**
 * Resolve final config. One complete config file wins — no multi-layer merging
 * and no built-in default overlay at init time.
 */
export function resolveConfig(
	org?: string,
	configPathOverride?: string,
): Config {
	const picked = pickConfig(org, configPathOverride);
	if (!picked || !existsSync(picked)) {
		throw new Error(`Config file not found: ${picked ?? "(none)"}`);
	}

	const raw = readFileSync(picked, "utf-8");
	return parseConfigYaml(raw, picked);
}
