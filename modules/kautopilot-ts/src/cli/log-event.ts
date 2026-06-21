import { Command } from "commander";
import { appendEvent } from "../core/log";
import { logError, logOk } from "../util/format";
import { resolveSession } from "./resolve-session";

export function createLogEventCommand(): Command {
	return new Command("log-event")
		.argument("<event>", "Event name (e.g. spec:approved)")
		.option("--metadata <json>", "JSON metadata to attach")
		.option("--session <id>", "Target session id")
		.action(
			async (event: string, opts: { metadata?: string; session?: string }) => {
				try {
					// Resolve like next/complete: --session wins, else the cwd's single
					// (running) session — a folder may host several, so ambiguity errors.
					const { sessionId } = resolveSession(opts.session);

					let metadata: Record<string, unknown> | undefined;
					if (opts.metadata) {
						try {
							metadata = JSON.parse(opts.metadata);
						} catch {
							logError("Invalid JSON for --metadata");
							process.exit(1);
						}
					}

					appendEvent(sessionId, {
						ts: new Date().toISOString(),
						event,
						metadata,
					});

					logOk(`Event logged: ${event}`);
				} catch (err) {
					logError(err instanceof Error ? err.message : String(err));
					process.exit(1);
				}
			},
		);
}
