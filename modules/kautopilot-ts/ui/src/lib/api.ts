import type {
	ConfigResponse,
	ConfigSaveResult,
	ConfigView,
	Discussion,
	DiffView,
	DocView,
	ServerMeta,
	SessionDetail,
	SessionSummary,
} from "./types";

// Minimal fetch wrapper over the `kautopilot serve` /api surface. All paths are
// relative so requests hit whatever origin served the page (loopback viewer,
// docker dash, or the vite dev proxy).

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function getJson<T>(path: string): Promise<T> {
	const r = await fetch(`/api${path}`);
	if (!r.ok) throw new ApiError(r.status, `GET ${path} → ${r.status}`);
	return (await r.json()) as T;
}

export const api = {
	meta: () => getJson<ServerMeta>("/meta"),
	listSessions: () => getJson<SessionSummary[]>("/sessions"),
	session: (id: string) =>
		getJson<SessionDetail>(`/sessions/${encodeURIComponent(id)}`),
	doc: (id: string, kind: string, version?: number | null) =>
		getJson<DocView>(
			`/sessions/${encodeURIComponent(id)}/doc/${kind}${version ? `/v/${version}` : ""}`,
		),
	plans: (id: string, repo: string, version?: number | null) =>
		getJson<DocView>(
			`/sessions/${encodeURIComponent(id)}/plans/${encodeURIComponent(repo)}${version ? `/v/${version}` : ""}`,
		),
	diff: (
		id: string,
		kind: string | null,
		repo: string | null,
		search: string,
	) =>
		getJson<DiffView>(
			(repo
				? `/sessions/${encodeURIComponent(id)}/diff/plans/${encodeURIComponent(repo)}`
				: `/sessions/${encodeURIComponent(id)}/diff/${kind}`) + search,
		),
	discussionPhases: (id: string) =>
		getJson<string[]>(`/sessions/${encodeURIComponent(id)}/discussion`),
	discussion: (id: string, phaseKey: string) =>
		getJson<Discussion>(
			`/sessions/${encodeURIComponent(id)}/discussion/${encodeURIComponent(phaseKey)}`,
		),
	config: () => getJson<ConfigResponse>("/config"),
	async saveConfig(patch: {
		settings?: Partial<ConfigView["settings"]>;
		writer?: Partial<ConfigView["writer"]>;
		/** Revision from the last GET — the server rejects a stale PUT (409). */
		expectedRevision?: number | null;
	}): Promise<ConfigSaveResult> {
		const r = await fetch("/api/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(patch),
		});
		const body = (await r.json().catch(() => ({}))) as ConfigSaveResult;
		if (!r.ok)
			return {
				ok: false,
				conflict: body.conflict ?? r.status === 409,
				errors: body.errors ?? [`PUT /config → ${r.status}`],
			};
		return body;
	},
};
