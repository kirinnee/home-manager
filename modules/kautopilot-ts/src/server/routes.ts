import { resolveConfig } from "../core/config";
import type { ArtifactKind } from "../core/revisions";
import {
	getDiff,
	getDoc,
	getHtmlDoc,
	getPlan,
	getPlanHtml,
	getSessionDetail,
	isDocKind,
	listSessionSummaries,
	storeFingerprint,
} from "./data";
import { SHELL_HTML } from "./page";

// The SPA shell with the configured kloop dashboard base URL injected, so
// session→kloop-run links target the configured `settings.kloopBaseUrl` (D3).
// Cached: config changes take effect on server restart.
let _shell: string | null = null;
function servedShell(): string {
	if (_shell == null) {
		let base = "http://localhost:47316";
		try {
			base = resolveConfig().settings.kloopBaseUrl;
		} catch {
			// no config file yet — fall back to the local kloop port
		}
		_shell = SHELL_HTML.replace("__KLOOP_BASE__", JSON.stringify(base));
	}
	return _shell;
}

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

// Serve a machine-generated infographic full-page. It's served same-origin (no
// iframe sandbox anymore), so block scripts via CSP to keep the "no JS" guarantee
// — the generated HTML is inline-CSS only and must never execute script.
function visualHtml(body: string): Response {
	return new Response(body, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy":
				"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; script-src 'none'",
		},
	});
}

function notFoundJson(): Response {
	return json({ error: "not found" }, 404);
}

/**
 * Serve a full-page HTML infographic. `rest` is the path parts AFTER `html`:
 *   <kind>[/v/<n>]                         — single-file artifact
 *   plans/<repo>/<plan>[/v/<n>]            — one plan's infographic
 * Served at a CLEAN, non-`/api` URL (`/sessions/:id/html/…`) since it returns a
 * standalone page, not JSON — `/api/*` is the JSON data surface. (The `/api/…/html/…`
 * path still resolves here too, for any older links.)
 */
function serveVisualHtml(id: string, rest: string[]): Response {
	const kind = rest[0];
	if (kind === "plans") {
		const repo = rest[1] ? decodeURIComponent(rest[1]) : "";
		const plan = rest[2] ? decodeURIComponent(rest[2]) : "";
		if (!repo || !plan) return notFoundJson();
		const version =
			rest[3] === "v" && rest[4] ? Number.parseInt(rest[4], 10) : undefined;
		const content = getPlanHtml(id, repo, plan, version);
		return content
			? visualHtml(content)
			: new Response("No visual version yet", { status: 404 });
	}
	if (!kind || !isDocKind(kind)) return notFoundJson();
	const version =
		rest[1] === "v" && rest[2] ? Number.parseInt(rest[2], 10) : undefined;
	const content = getHtmlDoc(id, kind as ArtifactKind, version);
	return content
		? visualHtml(content)
		: new Response("No visual version yet", { status: 404 });
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
		if (kind === "ticket" || kind === "ticket-draft") {
			const doc = getDoc(id, kind);
			return doc ? json(doc) : notFoundJson();
		}
		if (!kind || !isDocKind(kind)) return notFoundJson();
		const version =
			parts[5] === "v" && parts[6] ? Number.parseInt(parts[6], 10) : undefined;
		const doc = getDoc(id, kind, version);
		return doc ? json(doc) : notFoundJson();
	}

	// /api/sessions/:id/html/… — legacy alias; the clean URL is /sessions/:id/html/…
	if (section === "html") {
		return serveVisualHtml(id, parts.slice(4));
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
// Phases that mean "work in progress" (plan → implementation → polish); "none"
// and "done" are not active. See core/status.ts.
const ACTIVE_PHASES = new Set(["plan", "implementation", "polish"]);

/** Prometheus exposition of kautopilot's own session stats. Read per-scrape from
 *  the store (cheap — no LLM calls). */
function metricsResponse(): Response {
	const sessions = listSessionSummaries();
	const byPhase = new Map<string, number>();
	const byRepoStatus = new Map<string, number>();
	for (const s of sessions) {
		byPhase.set(s.phase, (byPhase.get(s.phase) ?? 0) + 1);
		for (const r of s.repos)
			byRepoStatus.set(r.status, (byRepoStatus.get(r.status) ?? 0) + 1);
	}
	const active = sessions.filter((s) => ACTIVE_PHASES.has(s.phase)).length;
	const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const lines = [
		"# HELP kautopilot_sessions_total Total kautopilot sessions in the store.",
		"# TYPE kautopilot_sessions_total gauge",
		`kautopilot_sessions_total ${sessions.length}`,
		"# HELP kautopilot_sessions_active Sessions in an in-progress phase (plan/implementation/polish).",
		"# TYPE kautopilot_sessions_active gauge",
		`kautopilot_sessions_active ${active}`,
		"# HELP kautopilot_sessions Sessions by phase.",
		"# TYPE kautopilot_sessions gauge",
		...[...byPhase]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([p, n]) => `kautopilot_sessions{phase="${esc(p)}"} ${n}`),
		"# HELP kautopilot_session_repos Per-repo work items by status.",
		"# TYPE kautopilot_session_repos gauge",
		...[...byRepoStatus]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([s, n]) => `kautopilot_session_repos{status="${esc(s)}"} ${n}`),
	];
	return new Response(`${lines.join("\n")}\n`, {
		headers: {
			"content-type": "text/plain; version=0.0.4; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

export function handleRequest(req: Request): Response {
	try {
		const url = new URL(req.url);
		if (req.method !== "GET" && req.method !== "HEAD") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		if (url.pathname === "/metrics") return metricsResponse();
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] === "api") {
			return handleApi(parts, url) ?? notFoundJson();
		}
		// Visual infographic at a clean, non-/api URL: /sessions/:id/html/… — a
		// standalone page (served before the SPA fallback; `html` is not a client route).
		if (parts[0] === "sessions" && parts.length >= 3 && parts[2] === "html") {
			return serveVisualHtml(decodeURIComponent(parts[1]), parts.slice(3));
		}
		// Every other path returns the SPA shell (stable, reload-safe URLs).
		return html(servedShell());
	} catch (err) {
		// A thrown error mid-request (e.g. a transient fs error reading
		// ~/.kautopilot) must return a 500 rather than crash the server process.
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: "internal error", message }, 500);
	}
}
