import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { setCachedConfig } from "../core/agents";
import { ensureGlobalConfig, resolveConfig } from "../core/config";
import {
	ALL_SCRIPTS,
	loadOrgScripts,
	promptSaveOrg,
	showScripts,
} from "../core/scripts";
import { logError, logField, logInfo } from "../util/format";

const ORGS_DIR = `${process.env.HOME}/.kautopilot/orgs`;

export function createOrgCommand(): Command {
	return new Command("org")
		.description("Org ticket script management")
		.addCommand(createOrgInitCommand())
		.addCommand(createOrgLsCommand());
}

function createOrgInitCommand(): Command {
	return new Command("init")
		.argument("<name>", "Org name")
		.description("Create or re-init org ticket scripts")
		.action(async (name: string) => {
			try {
				await runOrgInit(name);
			} catch (err) {
				logError(err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});
}

async function runOrgInit(name: string): Promise<void> {
	const orgDir = join(ORGS_DIR, name);

	if (existsSync(orgDir)) {
		const { confirmAction } = await import("../llm/inquirer");
		const confirmed = await confirmAction(
			`Org '${name}' already exists. Overwrite?`,
			false,
		);
		if (!confirmed) return;
	}

	mkdirSync(orgDir, { recursive: true });

	// 1. Ensure global config exists, then copy to org
	ensureGlobalConfig();
	const globalConfigPath = `${process.env.HOME}/.kautopilot/config.yaml`;
	const orgConfigPath = join(orgDir, "config.yaml");
	const { copyFileSync } = await import("node:fs");
	if (existsSync(globalConfigPath)) {
		copyFileSync(globalConfigPath, orgConfigPath);
		logField("Config", `${orgConfigPath} (copied from global)`);
	}
	setCachedConfig(resolveConfig(name, orgConfigPath));

	logField("Org", name);

	// 2. Load any existing ticket scripts from the org (best-effort; ticket ops are
	// harness-side now, so missing scripts are not fatal — they are simply noted).
	const scriptsDir = orgDir;
	const { missing } = loadOrgScripts(scriptsDir, name);
	if (missing.length > 0) {
		logInfo(
			`No scripts for: ${missing.join(", ")} (ticket ops run harness-side — optional).`,
		);
	}

	// 3. Show whatever scripts are present, then offer to persist them as org config.
	showScripts(scriptsDir, ALL_SCRIPTS);
	await promptSaveOrg(scriptsDir, name);
}

function createOrgLsCommand(): Command {
	return new Command("ls")
		.description("List configured orgs")
		.action(async () => {
			try {
				await runOrgLs();
			} catch (err) {
				logError(err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});
}

async function runOrgLs(): Promise<void> {
	mkdirSync(ORGS_DIR, { recursive: true });

	const { readdirSync, statSync } = await import("node:fs");
	const orgs = readdirSync(ORGS_DIR, { withFileTypes: true }).filter((d) =>
		d.isDirectory(),
	);

	if (orgs.length === 0) {
		logInfo(
			"No orgs configured. Run `kautopilot org init <name>` to create one.",
		);
		return;
	}

	const cols = { org: 12, scripts: 60 };
	console.log(`${"ORG".padEnd(cols.org)}SCRIPTS`);

	for (const org of orgs) {
		const orgDir = join(ORGS_DIR, org.name);
		const scripts = readdirSync(orgDir)
			.filter((f) => !f.startsWith("."))
			.filter((f) => {
				try {
					return statSync(join(orgDir, f)).isFile();
				} catch {
					return false;
				}
			});
		console.log(org.name.padEnd(cols.org) + scripts.join(", "));
	}
}
