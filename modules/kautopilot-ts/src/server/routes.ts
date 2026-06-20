import type { ArtifactKind } from "../core/revisions";
import {
	getDiff,
	getDoc,
	getPlan,
	getSessionDetail,
	isDocKind,
	listSessionSummaries,
	storeFingerprint,
} from "./data";
import { SHELL_HTML } from "./page";

// ============================================================================
// The request router for `kautopilot serve`. /api/* returns JSON read fresh
// from ~/.kautopilot on every request; every other GET returns the SPA shell
// (the client reads the path and fetches the matching /api endpoint), so each
// artifact/version/diff has a real, shareable, reload-safe URL.
// ============================================================================

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function html(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function notFoundJson(): Response {
	return json({ error: "not found" }, 404);
}

const POLL_MS = 1000;
const HEARTBEAT_MS = 15000;

/**
 * Server-pushed live reload via Server-Sent Events. Polls the store
 * fingerprint (max mtime over sessions) every POLL_MS and emits `data: reload`
 * whenever it changes; sends a `: ping` heartbeat every HEARTBEAT_MS to keep
 * the connection alive through proxies. mtime polling (not fs.watch) so it
 * works reliably over docker bind mounts. Intervals are cleared on cancel.
 */
function eventsStream(): Response {
	const encoder = new TextEncoder();
	let last = storeFingerprint();
	let poll: ReturnType<typeof setInterval> | undefined;
	let beat: ReturnType<typeof setInterval> | undefined;
	const stream = new ReadableStream({
		start(controller) {
			// Flush an initial comment so the client connection (and any fetch
			// awaiting the first byte) opens immediately rather than after the
			// first poll/heartbeat tick.
			controller.enqueue(encoder.encode(": connected\n\n"));
			poll = setInterval(() => {
				try {
					const fp = storeFingerprint();
					if (fp !== last) {
						last = fp;
						controller.enqueue(encoder.encode("data: reload\n\n"));
					}
				} catch {
					// transient read error; try again next tick
				}
			}, POLL_MS);
			beat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": ping\n\n"));
				} catch {
					// stream closed between ticks
				}
			}, HEARTBEAT_MS);
		},
		cancel() {
			if (poll) clearInterval(poll);
			if (beat) clearInterval(beat);
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			connection: "keep-alive",
		},
	});
}

/** Route the /api/* surface. Returns null when the path is not an API route. */
function handleApi(parts: string[], url: URL): Response | null {
	// /api/events — SSE live-reload stream.
	if (parts.length === 2 && parts[1] === "events") {
		return eventsStream();
	}
	// /api/sessions
	if (parts.length === 2 && parts[1] === "sessions") {
		return json(listSessionSummaries());
	}
	if (parts[1] !== "sessions" || parts.length < 3) return notFoundJson();
	const id = decodeURIComponent(parts[2]);

	// /api/sessions/:id
	if (parts.length === 3) {
		const detail = getSessionDetail(id);
		return detail ? json(detail) : notFoundJson();
	}

	const section = parts[3];

	// /api/sessions/:id/doc/:kind[/v/:n]
	if (section === "doc") {
		const kind = parts[4];
		if (kind === "ticket") {
			const doc = getDoc(id, "ticket");
			return doc ? json(doc) : notFoundJson();
		}
		if (!kind || !isDocKind(kind)) return notFoundJson();
		const version =
			parts[5] === "v" && parts[6] ? Number.parseInt(parts[6], 10) : undefined;
		const doc = getDoc(id, kind, version);
		return doc ? json(doc) : notFoundJson();
	}

	// /api/sessions/:id/plans/:repo[/v/:n]
	if (section === "plans") {
		const repo = parts[4] ? decodeURIComponent(parts[4]) : "";
		if (!repo) return notFoundJson();
		const version =
			parts[5] === "v" && parts[6] ? Number.parseInt(parts[6], 10) : undefined;
		const doc = getPlan(id, repo, version);
		return doc ? json(doc) : notFoundJson();
	}

	// /api/sessions/:id/diff/:kind  and  /api/sessions/:id/diff/plans/:repo
	if (section === "diff") {
		const from = url.searchParams.has("from")
			? Number.parseInt(url.searchParams.get("from") as string, 10)
			: undefined;
		const to = url.searchParams.has("to")
			? Number.parseInt(url.searchParams.get("to") as string, 10)
			: undefined;
		if (parts[4] === "plans") {
			const repo = parts[5] ? decodeURIComponent(parts[5]) : "";
			if (!repo) return notFoundJson();
			const d = getDiff(id, "plans", { from, to, repo });
			return d ? json(d) : notFoundJson();
		}
		const kind = parts[4];
		if (!kind || !isDocKind(kind)) return notFoundJson();
		const d = getDiff(id, kind as ArtifactKind, { from, to });
		return d ? json(d) : notFoundJson();
	}

	return notFoundJson();
}

/** The Bun.serve fetch handler. */
export function handleRequest(req: Request): Response {
	try {
		const url = new URL(req.url);
		if (req.method !== "GET" && req.method !== "HEAD") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] === "api") {
			return handleApi(parts, url) ?? notFoundJson();
		}
		// Every other path returns the SPA shell (stable, reload-safe URLs).
		return html(SHELL_HTML);
	} catch (err) {
		// A thrown error mid-request (e.g. a transient fs error reading
		// ~/.kautopilot) must return a 500 rather than crash the server process.
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: "internal error", message }, 500);
	}
}
