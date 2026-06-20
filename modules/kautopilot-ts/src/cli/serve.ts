import { Command } from "commander";
import { handleRequest } from "../server/routes";
import { logError, logInfo } from "../util/format";

// ============================================================================
// `kautopilot serve` — host a live local website that renders ~/.kautopilot
// (sessions / specs / plans / diffs) so the user can read them. The store is
// re-read on EVERY request (no caching) so the UI always reflects current
// state.
//
// `serve` runs the Bun.serve HTTP server directly in-process ("serve
// directly"). For a dockerized, always-on dashboard, see `kautopilot dash`,
// whose container runs this same `serve` command internally.
// ============================================================================

const DEFAULT_PORT = 47317;
const DEFAULT_HOST = "127.0.0.1";

/**
 * Run the live-reloading HTTP viewer in-process and block forever. Also the
 * command the `dash` container runs internally.
 */
async function runHttpServer({
	host,
	port,
}: {
	host: string;
	port: number;
}): Promise<never> {
	let server: ReturnType<typeof Bun.serve>;
	try {
		server = Bun.serve({ port, hostname: host, fetch: handleRequest });
	} catch (err) {
		// The most common bootstrap failure is the port already being in use.
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EADDRINUSE") {
			logError(`Port ${port} is already in use on ${host}.`);
		} else {
			logError(
				`Failed to start web UI: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		process.exit(1);
	}
	logInfo(`kautopilot web UI on http://${server.hostname}:${server.port}`);
	logInfo("Reading ~/.kautopilot live. Ctrl-C to stop.");
	// Block forever so the top-level `parseAsync().then(exit)` does not tear the
	// server down; Ctrl-C / SIGTERM ends the process.
	return new Promise<never>(() => {});
}

export function createServeCommand(): Command {
	return new Command("serve")
		.description("Serve a live local web UI for ~/.kautopilot (read-only)")
		.option("--port <n>", "Port to listen on", (v) => Number.parseInt(v, 10))
		.option("--host <h>", "Host to bind")
		.action(async (opts: { port?: number; host?: string }) => {
			const port = opts.port ?? DEFAULT_PORT;
			const host = opts.host ?? DEFAULT_HOST;
			await runHttpServer({ host, port });
		});
}
