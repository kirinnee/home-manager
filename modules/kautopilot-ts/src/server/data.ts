import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionDir } from "../core/artifacts";
import {
	type ArtifactKind,
	htmlRevisionExists,
	listPlanSetVersions,
	listRevisions,
	listRevisionsWithEpoch,
	readHtmlRevision,
	readPlanHtml,
	readPlanList,
	readPlanSet,
	readRevision,
} from "../core/revisions";
import { readSessionMeta, type SessionMeta } from "../core/session-meta";
import { ensureStatus } from "../core/status";

// ============================================================================
// Read-only views of ~/.kautopilot for the `serve` web UI. Everything here
// re-reads disk on every call (no caching) so the UI always reflects the
// current session state.
// ============================================================================

/** Root of the session store. Resolved lazily so tests can swap $HOME. */
function storeRoot(): string {
	return `${process.env.HOME}/.kautopilot`;
}

/**
 * Enumerate session ids: direct children of ~/.kautopilot that contain a
 * session.json. Excludes the global `config.yaml`, the `orgs` dir, and any
 * other non-session entries. Tolerates a missing store (sandbox / empty HOME).
 */
function listSessionIds(): string[] {
	const root = storeRoot();
	if (!existsSync(root)) return [];
	const ids: string[] = [];
	for (const name of readdirSync(root)) {
		if (name === "orgs") continue;
		const dir = join(root, name);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		if (existsSync(join(dir, "session.json"))) ids.push(name);
	}
	return ids;
}

const DOC_KINDS = new Set<ArtifactKind>([
	"triage",
	"spec",
	"feedback",
	"brainstorm",
]);

export function isDocKind(kind: string): kind is ArtifactKind {
	return DOC_KINDS.has(kind as ArtifactKind);
}

/** Discover the repo names that have plan folders for an epoch of a session. */
function planRepos(sessionId: string, epoch: number): string[] {
	const dir = join(sessionDir(sessionId), "epoch", String(epoch), "plans");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => {
			try {
				return statSync(join(dir, name)).isDirectory();
			} catch {
				return false;
			}
		})
		.sort();
}

export interface SessionSummary {
	id: string;
	ticketId: string;
	org: string;
	ticketSystem: string;
	epoch: number;
	phase: string;
	repos: Array<{
		repo: string;
		status: string;
		prNumber: number | null;
		prUrl: string | null;
	}>;
}

function summarize(id: string, meta: SessionMeta): SessionSummary {
	const status = ensureStatus(id);
	return {
		id,
		ticketId: meta.ticketId || "—",
		org: meta.org,
		ticketSystem: meta.ticketSystem,
		epoch: meta.epoch,
		phase: status.phase,
		repos: meta.repos.map((r) => ({
			repo: r.repo,
			status: r.status,
			prNumber: r.prNumber,
			prUrl: r.prUrl,
		})),
	};
}

/** `[{ id, ticketId, org, epoch, phase, repos }]` for the index page. */
export function listSessionSummaries(): SessionSummary[] {
	const out: SessionSummary[] = [];
	for (const id of listSessionIds()) {
		const meta = readSessionMeta(id);
		if (meta) out.push(summarize(id, meta));
	}
	return out;
}

/**
 * A versioned artifact revision tagged with the epoch it was approved in.
 * `epoch` is null for epoch-agnostic artifacts (brainstorm precedes any epoch).
 */
export interface RevisionInfo {
	version: number;
	epoch: number | null;
}

/**
 * Brainstorm revisions are epoch-agnostic: brainstorm happens BEFORE the
 * ticket/epoch exists, so its versions are tagged with `epoch: null`.
 */
function brainstormRevisions(id: string): RevisionInfo[] {
	return listRevisions(id, "brainstorm").map((version) => ({
		version,
		epoch: null,
	}));
}

/** Plan-set revisions for a repo in an epoch (each round shares one version). */
function planRevisions(
	id: string,
	repo: string,
	epoch: number,
): RevisionInfo[] {
	return listPlanSetVersions(id, epoch, repo).map((version) => ({
		version,
		epoch,
	}));
}

export interface SessionDetail {
	meta: SessionMeta;
	phase: string;
	state: string;
	artifacts: {
		ticket: boolean;
		/** ticket-draft.md (ad-hoc sessions that brainstormed before a ticket). */
		ticketDraft: boolean;
		brainstorm: RevisionInfo[];
		triage: RevisionInfo[];
		spec: RevisionInfo[];
		feedback: RevisionInfo[];
		plans: Record<string, RevisionInfo[]>;
		/** Kloop run ids spawned by this session's execution (newest first). */
		kloopRuns: string[];
	};
}

/** Full detail for one session, or null when it has no session.json. */
export function getSessionDetail(id: string): SessionDetail | null {
	const meta = readSessionMeta(id);
	if (!meta) return null;
	const status = ensureStatus(id);
	// Epoch-scoped artifacts surface the CURRENT epoch; brainstorm is global.
	const epoch = meta.epoch;
	const plans: Record<string, RevisionInfo[]> = {};
	for (const repo of planRepos(id, epoch)) {
		plans[repo] = planRevisions(id, repo, epoch);
	}
	// Flatten the per-plan kloop run history into a deduped, newest-first list so
	// the session page can link straight to the kloop run viewer.
	const kloopRuns: string[] = [];
	for (const list of Object.values(status.planRuns ?? {})) {
		for (const runId of list) {
			if (runId && !kloopRuns.includes(runId)) kloopRuns.push(runId);
		}
	}
	kloopRuns.reverse();
	return {
		meta,
		phase: status.phase,
		state: status.state,
		artifacts: {
			ticket: existsSync(join(sessionDir(id), "ticket.md")),
			ticketDraft: existsSync(join(sessionDir(id), "ticket-draft.md")),
			brainstorm: brainstormRevisions(id),
			triage: listRevisionsWithEpoch(id, "triage", { epoch }),
			spec: listRevisionsWithEpoch(id, "spec", { epoch }),
			feedback: listRevisionsWithEpoch(id, "feedback", { epoch }),
			plans,
			kloopRuns,
		},
	};
}

export interface DocView {
	markdown: string;
	version: number | null;
	/** Each available version tagged with its approval epoch (for grouping). */
	versions: RevisionInfo[];
	/**
	 * For plans: each plan individually, so the viewer can tab between them. Each
	 * carries its own `htmlAvailable` — plans get one infographic PER plan, not merged.
	 */
	plans?: { name: string; markdown: string; htmlAvailable: boolean }[];
	/** Whether a sibling HTML infographic (vN.html) exists (single-file artifacts). */
	htmlAvailable?: boolean;
}

/** Read the ticket (unversioned) or a versioned doc artifact. */
export function getDoc(
	id: string,
	kind: "ticket" | "ticket-draft" | ArtifactKind,
	version?: number,
): DocView | null {
	const meta = readSessionMeta(id);
	if (meta == null) return null;
	if (kind === "ticket" || kind === "ticket-draft") {
		const file = kind === "ticket" ? "ticket.md" : "ticket-draft.md";
		const p = join(sessionDir(id), file);
		const markdown = existsSync(p) ? readFileSync(p, "utf-8") : "";
		return { markdown, version: null, versions: [] };
	}
	const epoch = meta.epoch;
	const versions =
		kind === "brainstorm"
			? brainstormRevisions(id)
			: listRevisionsWithEpoch(id, kind, { epoch });
	if (versions.length === 0)
		return { markdown: "", version: null, versions: [] };
	const v = version ?? versions[versions.length - 1].version;
	if (!versions.some((r) => r.version === v)) return null;
	const ref = kind === "brainstorm" ? {} : { epoch };
	return {
		markdown: readRevision(id, kind, v, ref),
		version: v,
		versions,
		htmlAvailable: htmlRevisionExists(id, kind, v, ref),
	};
}

/** Raw HTML infographic for a doc artifact version (vN.html), or null. */
export function getHtmlDoc(
	id: string,
	kind: ArtifactKind,
	version?: number,
): string | null {
	const meta = readSessionMeta(id);
	if (meta == null) return null;
	const epoch = meta.epoch;
	const versions =
		kind === "brainstorm"
			? brainstormRevisions(id)
			: listRevisionsWithEpoch(id, kind, { epoch });
	if (versions.length === 0) return null;
	const v = version ?? versions[versions.length - 1].version;
	if (!versions.some((r) => r.version === v)) return null;
	const ref = kind === "brainstorm" ? {} : { epoch };
	return readHtmlRevision(id, kind, v, ref);
}

/** Read a repo's plan set, latest or a specific plan-set version (current epoch). */
export function getPlan(
	id: string,
	repo: string,
	version?: number,
): DocView | null {
	const meta = readSessionMeta(id);
	if (meta == null) return null;
	const epoch = meta.epoch;
	const versions = planRevisions(id, repo, epoch);
	if (versions.length === 0)
		return { markdown: "", version: null, versions: [] };
	const v = version ?? versions[versions.length - 1].version;
	if (!versions.some((r) => r.version === v)) return null;
	return {
		markdown: readPlanSet(id, epoch, repo, v),
		version: v,
		versions,
		plans: readPlanList(id, epoch, repo, v),
	};
}

/**
 * Raw HTML infographic for a SINGLE plan (repo + plan + version). Resolves the
 * version exactly like getPlan, then reads that plan's `<plan>/vN.html`.
 */
export function getPlanHtml(
	id: string,
	repo: string,
	plan: string,
	version?: number,
): string | null {
	const meta = readSessionMeta(id);
	if (meta == null) return null;
	const epoch = meta.epoch;
	const versions = planRevisions(id, repo, epoch);
	if (versions.length === 0) return null;
	const v = version ?? versions[versions.length - 1].version;
	if (!versions.some((r) => r.version === v)) return null;
	return readPlanHtml(id, epoch, repo, plan, v);
}

/**
 * A cheap "did anything change?" fingerprint over the whole store: the max
 * mtimeMs across the top-level ~/.kautopilot dir, each session's log.jsonl,
 * session.json and revisions dir. Used by the SSE live-reload endpoint, which
 * polls this (mtime polling — fs.watch/inotify is unreliable over docker bind
 * mounts) and pushes a reload when the value changes. Tolerates a missing store.
 */
export function storeFingerprint(): number {
	const root = storeRoot();
	if (!existsSync(root)) return 0;
	let max = 0;
	const bump = (p: string): void => {
		try {
			const m = statSync(p).mtimeMs;
			if (m > max) max = m;
		} catch {
			// ignore unreadable entries
		}
	};
	// Recursively bump over the artifact trees so both new versions (dir mtime
	// changes) and in-place edits to a revision file (file mtime changes) are
	// detected. The trees are shallow (brainstorm/vN.md, epoch/<E>/<kind>/vN.md,
	// epoch/<E>/plans/<repo>/<plan>/vN.md), so this is cheap.
	const walk = (p: string): void => {
		bump(p);
		let entries: string[];
		try {
			if (!statSync(p).isDirectory()) return;
			entries = readdirSync(p);
		} catch {
			return;
		}
		for (const e of entries) walk(join(p, e));
	};
	bump(root);
	for (const id of listSessionIds()) {
		const dir = join(root, id);
		bump(join(dir, "log.jsonl"));
		bump(join(dir, "session.json"));
		walk(join(dir, "brainstorm"));
		walk(join(dir, "epoch"));
	}
	return max;
}

export interface DiffView {
	kind: string;
	fromVersion: number;
	toVersion: number;
	/** Raw markdown of each side — the client renders a markdown REDLINE (ins/del). */
	fromMarkdown: string;
	toMarkdown: string;
	/** All available version numbers (ascending) — for the from/to pickers. */
	versions: number[];
}

/**
 * The two version texts to diff (default vN-1 → vN). The client renders a
 * markdown redline (rendered prose with inline insertions/deletions), NOT a
 * code-style line diff — so raw markdown is returned, not a unified diff string.
 */
export function getDiff(
	id: string,
	kind: ArtifactKind,
	opts: { from?: number; to?: number; repo?: string | null },
): DiffView | null {
	const meta = readSessionMeta(id);
	if (meta == null) return null;
	// Epoch-scoped kinds diff within the current epoch; brainstorm is global.
	const epoch = kind === "brainstorm" ? null : meta.epoch;
	const planSet = kind === "plans" && opts.repo != null;
	const repo = opts.repo ?? "default";
	const versions = planSet
		? listPlanSetVersions(id, epoch ?? 1, repo)
		: listRevisions(id, kind, { epoch });
	const latest = versions.length ? Math.max(...versions) : 0;
	if (latest <= 0) return null;
	const to = opts.to ?? latest;
	const from = opts.from ?? to - 1;
	const read = (n: number): string =>
		planSet
			? readPlanSet(id, epoch ?? 1, repo, n)
			: readRevision(id, kind, n, { epoch });
	return {
		kind,
		fromVersion: from,
		toVersion: to,
		fromMarkdown: from >= 1 ? read(from) : "",
		toMarkdown: read(to),
		versions: [...versions].sort((a, b) => a - b),
	};
}
