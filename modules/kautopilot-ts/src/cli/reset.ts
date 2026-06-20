import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { serializeConfigWithComments } from "../core/config";
import { DEFAULT_CONFIG } from "../core/types";
import { logDim, logError, logInfo, logOk } from "../util/format";

const GLOBAL_DIR = `${process.env.HOME}/.kautopilot`;
const GLOBAL_CONFIG = `${GLOBAL_DIR}/config.yaml`;
const BINARY_CACHE = `${GLOBAL_DIR}/binary-config-dirs.json`;

export function createResetCommand(): Command {
	return new Command("reset")
		.description("Reset global config to defaults")
		.option("--binary-cache", "Also clear the binary config dir cache")
		.option("-y, --yes", "Skip confirmation prompt")
		.action(async (opts: { binaryCache?: boolean; yes?: boolean }) => {
			try {
				await runReset(opts);
			} catch (err) {
				logError(err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});
}

async function runReset(opts: {
	binaryCache?: boolean;
	yes?: boolean;
}): Promise<void> {
	if (!opts.yes) {
		const { confirmAction } = await import("../llm/inquirer");
		const confirmed = await confirmAction(
			"Reset global config to defaults?",
			false,
		);
		if (!confirmed) {
			logInfo("Cancelled.");
			return;
		}
	}

	// Ensure directory exists
	mkdirSync(GLOBAL_DIR, { recursive: true });

	// Write fresh defaults with variable comments
	writeFileSync(GLOBAL_CONFIG, serializeConfigWithComments(DEFAULT_CONFIG));
	logOk(`Reset ${GLOBAL_CONFIG}`);

	// Optionally clear binary cache
	if (opts.binaryCache && existsSync(BINARY_CACHE)) {
		unlinkSync(BINARY_CACHE);
		logOk(`Removed ${BINARY_CACHE}`);
	} else if (existsSync(BINARY_CACHE)) {
		logDim(
			`Binary cache preserved (${BINARY_CACHE}). Use --binary-cache to clear.`,
		);
	}
}
