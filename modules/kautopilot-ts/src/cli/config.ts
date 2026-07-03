import { Command } from "commander";
import { resolveConfig } from "../core/config";
import { logError } from "../util/format";

// ============================================================================
// `kautopilot config` — print the RESOLVED config (the single file that wins:
// --config > org > global). The harness uses this to read the configured
// `viewerBaseUrl` / `kloopBaseUrl` when building shareable links, instead of
// guessing a host. Prints JSON so it can be parsed; `--field` extracts one
// settings value (e.g. `kautopilot config --field viewerBaseUrl`).
// ============================================================================

export function createConfigCommand(): Command {
	return new Command("config")
		.description(
			"Print the resolved config (viewer/kloop base URLs, settings, orgs)",
		)
		.option("--org <org>", "Resolve the org-scoped config")
		.option("--config <path>", "Resolve a specific config file")
		.option(
			"--field <name>",
			"Print a single settings value (e.g. viewerBaseUrl)",
		)
		.action(
			async (opts: { org?: string; config?: string; field?: string }) => {
				try {
					const config = resolveConfig(opts.org, opts.config);
					if (opts.field) {
						const settings = config.settings as Record<string, unknown>;
						if (!(opts.field in settings)) {
							logError(`Unknown settings field: ${opts.field}`);
							process.exit(1);
						}
						process.stdout.write(`${String(settings[opts.field])}\n`);
						process.exit(0);
					}
					process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
					process.exit(0);
				} catch (err) {
					logError(err instanceof Error ? err.message : String(err));
					process.exit(1);
				}
			},
		);
}
