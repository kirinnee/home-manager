import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logField, logHeading, logOk } from "../util/format";
import { sessionDir } from "./artifacts";

// ============================================================================
// Script constants
// ============================================================================

export const ALL_SCRIPTS = [
	"extract-ticket",
	"get-ticket",
	"start-ticket",
	"to-review",
	"revert-to-inprogress",
	// Expanded ticket script surface (spec section 12)
	"update-ticket",
	"create-downstream-ticket",
	"add-comment",
	"move-to-todo",
	"attach-artifact",
];

const ORGS_DIR = `${process.env.HOME}/.kautopilot/orgs`;

// ============================================================================
// Org script loading
// ============================================================================

/**
 * Try to copy all 5 scripts from org dir.
 * Returns { found: [...copied], missing: [...not found] }.
 */
export function loadOrgScripts(
	targetDir: string,
	org: string,
): { found: string[]; missing: string[] } {
	mkdirSync(targetDir, { recursive: true });

	const orgDir = join(ORGS_DIR, org);
	const found: string[] = [];
	const missing: string[] = [];

	if (!org || !existsSync(orgDir)) {
		return { found: [], missing: [...ALL_SCRIPTS] };
	}

	for (const name of ALL_SCRIPTS) {
		const src = join(orgDir, name);
		const dest = join(targetDir, name);
		if (existsSync(src)) {
			copyFileSync(src, dest);
			Bun.spawnSync({ cmd: ["chmod", "+x", dest] });
			found.push(name);
		} else {
			missing.push(name);
		}
	}

	if (found.length === ALL_SCRIPTS.length) {
		logField("Scripts", `all copied from org "${org}"`);
	} else if (found.length > 0) {
		logField(
			"Scripts",
			`copied ${found.length} from org "${org}", missing ${missing.join(", ")}`,
		);
	}

	return { found, missing };
}

/**
 * Display the contents of each script to the user.
 */
export function showScripts(scriptsDir: string, scripts: string[]): void {
	logHeading("Scripts");

	for (const name of scripts) {
		const path = join(scriptsDir, name);
		if (existsSync(path)) {
			console.log(`\n--- ${name} ---`);
			console.log(readFileSync(path, "utf-8"));
		}
	}

	console.log();
}

// ============================================================================
// LLM script creation
// ============================================================================

/**
 * Ask user whether to save scripts and config as org config for future projects.
 */
export async function promptSaveOrg(
	scriptsDir: string,
	org: string | undefined | null,
	sessionId?: string,
): Promise<void> {
	if (!org) return;
	const { confirmAction } = await import("../llm/inquirer");
	const save = await confirmAction(
		`Save these scripts and config as org config for "${org}"? Future projects will reuse them.`,
		true,
	);
	if (!save) return;

	const orgDir = join(ORGS_DIR, org);
	mkdirSync(orgDir, { recursive: true });

	for (const name of ALL_SCRIPTS) {
		const src = join(scriptsDir, name);
		const dest = join(orgDir, name);
		if (existsSync(src)) {
			copyFileSync(src, dest);
		}
	}

	// Copy session config to org if available
	if (sessionId) {
		const sDir = sessionDir(sessionId);
		const sessionConfig = join(sDir, "config.yaml");
		if (existsSync(sessionConfig)) {
			copyFileSync(sessionConfig, join(orgDir, "config.yaml"));
		}
	}

	logOk(`Org scripts and config saved to ${orgDir}`);
}
