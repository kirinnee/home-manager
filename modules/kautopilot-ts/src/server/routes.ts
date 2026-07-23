import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../core/config";
import type { ArtifactKind } from "../core/revisions";
import { discussionPhases, readDiscussion } from "../core/writer/relay";
import { phaseKeySafe } from "../core/writer/scratch";
import { readConfigResponse, saveConfigPatch } from "./config-api";
import {
	getDiff,
	getDoc,
	getHtmlDoc,
	getPlan,
	getPlanHtml,
	isDocKind,
} from "./data";
import { SHELL_HTML } from "./page";
import {
	getSessionDetailCached,
	getStoreFingerprint,
	listSessionSummariesCached,
} from "./store-cache";

// Built SPA (Vite output, committed under ../../ui-dist): served when present;
// the legacy single-file shell remains the fallback so `serve` never 404s its
// own UI. ui-dist lives OUTSIDE src/ so the Bun runtime never bundles it.
const UI_DIST = fileURLToPath(new URL("../../ui-dist", import.meta.url));

// ============================================================================
// The request router for `kautopilot serve`. /api/* returns JSON read fresh
// from ~/.kautopilot (behind an mtime-keyed cache — see store-cache.ts); every
// other GET returns the SPA (built React app, or the legacy shell fallback), so
// each artifact/version/diff has a real, shareable, reload-safe URL.
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

/** kloop dashboard base (session→run links). Config-driven; cached per process. */
let _kloopBase: string | null = null;
function kloopBase(): string {
	if (_kloopBase == null) {
		_kloopBase = "http://localhost:47316";
		try {
			_kloopBase = resolveConfig().settings.kloopBaseUrl;
		} catch {
			// no config yet — fall back to the local kloop port
		}
	}
	return _kloopBase;
}

/** kteam daemon base (writer/reviewer session deep-links). kteam owns its own
 *  host/port (there is no kautopilot setting for it), so read kteam's env with
 *  its documented default. */
function kteamBase(): string {
	if (process.env.KTEAM_URL) return process.env.KTEAM_URL;
	const host = process.env.KTEAM_HOST ?? "127.0.0.1";
	const port = process.env.KTEAM_PORT ?? "7337";
	return `http://${host}:${port}`;
}

/**
 * Serve a full-page HTML infographic. `rest` is the path parts AFTER `html`:
 *   <kind>[/v/<n>]                         — single-file artifact
 *   plans/<repo>/<plan>[/v/<n>]            — one plan's infographic
 * Served at a CLEAN, non-`/api` URL (`/sessions/:id/html/…`) since it returns a
 * standalone page, not JSON.
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
 * Server-pushed live reload via Server-Sent Events. Polls the (shared,
 * throttled, async) store fingerprint every POLL_MS and emits `data: reload`
 * whenever it changes; sends a `: ping` heartbeat every HEARTBEAT_MS. mtime
 * polling (not fs.watch) so it works over docker bind mounts. All connected
 * clients share ONE fingerprint walk per interval (store-cache throttle).
 */
function eventsStream(): Response {
	const encoder = new TextEncoder();
	let last = -1;
	let poll: ReturnType<typeof setInterval> | undefined;
	let beat: ReturnType<typeof setInterval> | undefined;
	const stream = new ReadableStream({
		async start(controller) {
			controller.enqueue(encoder.encode(": connected\n\n"));
			last = await getStoreFingerprint(Date.now()).catch(() => last);
			poll = setInterval(() => {
				getStoreFingerprint(Date.now())
					.then((fp) => {
						if (fp !== last) {
							last = fp;
							controller.enqueue(encoder.encode("data: reload\n\n"));
						}
					})
					.catch(() => {
						// transient read error; try again next tick
					});
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

/** Minimal shape of the Bun server object we use (requestIP for the loopback
 *  gate on config writes). */
interface ServeServer {
	requestIP?: (req: Request) => { address: string } | null;
}

/** True when the request originates from loopback. Config writes are gated on
 *  this so `serve --host 0.0.0.0` (and the docker dash, which binds 0.0.0.0)
 *  can be read by remote viewers but never rewritten by them — bind-to-localhost
 *  is only the default, not an authorization mechanism. Mirrors kloop's gate. */
function isLoopback(server: ServeServer | undefined, req: Request): boolean {
	try {
		const ip = server?.requestIP?.(req)?.address ?? "";
		return (
			ip === "127.0.0.1" ||
			ip === "::1" ||
			ip.endsWith(":127.0.0.1") ||
			ip === "::ffff:127.0.0.1"
		);
	} catch {
		return false;
	}
}

/** Route the /api/* surface. Returns null when the path is not an API route. */
async function handleApi(
	parts: string[],
	url: URL,
	req: Request,
	server: ServeServer | undefined,
): Promise<Response | null> {
	// /api/events — SSE live-reload stream.
	if (parts.length === 2 && parts[1] === "events") {
		return eventsStream();
	}

	// /api/meta — server-side bases + version for the SPA (kloop/kteam links).
	if (parts.length === 2 && parts[1] === "meta") {
		return json({
			version: process.env.npm_package_version ?? "",
			kloopBase: kloopBase(),
			kteamBase: kteamBase(),
		});
	}

	// /api/config — GET the editable config + fleet wrappers; PUT a patch.
	if (parts.length === 2 && parts[1] === "config") {
		if (req.method === "PUT") {
			// Config mutation is loopback-only (see isLoopback): a remote viewer of
			// a `--host`-exposed server must never rewrite writer pools / settings.
			if (!isLoopback(server, req))
				return json(
					{ ok: false, errors: ["config edits are localhost-only"] },
					403,
				);
			let patch: unknown;
			try {
				patch = await req.json();
			} catch {
				return json({ ok: false, errors: ["invalid JSON body"] }, 400);
			}
			const result = saveConfigPatch(patch as never);
			const status = result.ok ? 200 : result.conflict ? 409 : 400;
			return json(result, status);
		}
		if (req.method === "GET") return json(readConfigResponse());
		return json({ error: "method not allowed" }, 405);
	}

	// /api/sessions
	if (parts.length === 2 && parts[1] === "sessions") {
		return json(await listSessionSummariesCached());
	}
	if (parts[1] !== "sessions" || parts.length < 3) return notFoundJson();
	const id = decodeURIComponent(parts[2]);

	// /api/sessions/:id
	if (parts.length === 3) {
		const detail = await getSessionDetailCached(id);
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

	// /api/sessions/:id/discussion[/:phaseKey]
	if (section === "discussion") {
		if (parts.length === 4) return json(discussionPhases(id));
		const phaseKey = decodeURIComponent(parts[4] ?? "");
		if (!phaseKey) return notFoundJson();
		const d = readDiscussion(id, phaseKeySafe(phaseKey));
		return d.writer || d.turns.length > 0 ? json(d) : notFoundJson();
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

/** Phases that mean "work in progress" (plan → implementation → polish); "none"
 *  and "done" are not active. See core/status.ts. */
const ACTIVE_PHASES = new Set(["plan", "implementation", "polish"]);

/** Prometheus exposition of kautopilot's own session stats (read per-scrape,
 *  behind the same mtime cache — cheap, no LLM calls). */
async function metricsResponse(): Promise<Response> {
	const sessions = await listSessionSummariesCached();
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

/**
 * Serve the built SPA (ui-dist) when present, else the legacy single-file
 * shell. Hashed assets are served immutable; every client-side route falls back
 * to index.html so deep links reload-safely. The path is confined to UI_DIST.
 */
function serveUi(pathname: string): Response {
	const distIndex = join(UI_DIST, "index.html");
	if (existsSync(distIndex)) {
		if (pathname !== "/") {
			const assetPath = normalize(join(UI_DIST, pathname));
			if (
				!assetPath.endsWith("/index.html") &&
				assetPath.startsWith(`${UI_DIST}/`) &&
				existsSync(assetPath)
			) {
				return new Response(Bun.file(assetPath), {
					headers: {
						"cache-control": "public, max-age=31536000, immutable",
					},
				});
			}
		}
		return new Response(Bun.file(distIndex), {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	}
	// Legacy fallback: the single-file shell (kloop base injected once).
	return html(legacyShell());
}

let _legacyShell: string | null = null;
function legacyShell(): string {
	if (_legacyShell == null)
		_legacyShell = SHELL_HTML.replace(
			"__KLOOP_BASE__",
			JSON.stringify(kloopBase()),
		);
	return _legacyShell;
}

export async function handleRequest(
	req: Request,
	server?: ServeServer,
): Promise<Response> {
	try {
		const url = new URL(req.url);
		const method = req.method;
		if (method !== "GET" && method !== "HEAD" && method !== "PUT") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		if (url.pathname === "/metrics") return await metricsResponse();
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] === "api") {
			return (await handleApi(parts, url, req, server)) ?? notFoundJson();
		}
		if (method === "PUT")
			return new Response("Method Not Allowed", { status: 405 });
		// Visual infographic at a clean, non-/api URL: /sessions/:id/html/… — a
		// standalone page (served before the SPA fallback; `html` is not a client route).
		if (parts[0] === "sessions" && parts.length >= 3 && parts[2] === "html") {
			return serveVisualHtml(decodeURIComponent(parts[1]), parts.slice(3));
		}
		// Every other path returns the SPA (stable, reload-safe URLs).
		return serveUi(url.pathname);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: "internal error", message }, 500);
	}
}
