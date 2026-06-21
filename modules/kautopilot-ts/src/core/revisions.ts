import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sessionDir } from "./artifacts";

// ============================================================================
// Versioned working artifacts (§8). triage / spec / plans / feedback / brainstorm
// are iterated through many versions; each approved version lands in the session
// store and is diffed against the previous, so the user reviews WHAT CHANGED.
// These are machine-local and NEVER committed.
//
// On-disk layout (under ~/.kautopilot/<sessionId>/):
//   brainstorm/vN.md                          — epoch-AGNOSTIC (global numbering)
//   epoch/<E>/triage/vN.md                     — per-epoch numbering (resets each epoch)
//   epoch/<E>/spec/vN.md
//   epoch/<E>/feedback/vN.md
//   epoch/<E>/plans/<repo>/<plan>/vN.md        — each plan is a folder of versions
// `epoch/<E>/` is the single source of truth; there is no separate frozen-snapshot
// store. `ticket.md` (flat, fetch_ticket) is NOT a revisions kind.
// ============================================================================

export type ArtifactKind =
	| "triage"
	| "spec"
	| "plans"
	| "feedback"
	| "brainstorm";

/** brainstorm is epoch-agnostic; every other kind is scoped to an epoch. */
function isEpochless(kind: ArtifactKind): boolean {
	return kind === "brainstorm";
}

/** Locator for an artifact within a session. */
export interface ArtifactRef {
	/** Epoch (delivery cycle). Ignored for brainstorm. */
	epoch?: number | null;
	/** Repo name — required for plans. */
	repo?: string | null;
	/** Plan basename (e.g. `plan-1`) — required for plans. */
	plan?: string | null;
}

/**
 * Directory that holds the `vN.md` files for an artifact:
 *   brainstorm                → `<sd>/brainstorm`
 *   triage|spec|feedback      → `<sd>/epoch/<E>/<kind>`
 *   plans                     → `<sd>/epoch/<E>/plans/<repo>/<plan>`
 */
function artifactDir(
	sessionId: string,
	kind: ArtifactKind,
	ref: ArtifactRef,
): string {
	const sd = sessionDir(sessionId);
	if (kind === "brainstorm") return join(sd, "brainstorm");
	const epoch = ref.epoch ?? 1;
	const base = join(sd, "epoch", String(epoch));
	if (kind === "plans") {
		return join(base, "plans", ref.repo ?? "default", ref.plan ?? "plan-1");
	}
	return join(base, kind);
}

/** Directory containing every plan FOLDER for a repo in an epoch. */
export function plansRepoDir(
	sessionId: string,
	epoch: number,
	repo: string,
): string {
	return join(sessionDir(sessionId), "epoch", String(epoch), "plans", repo);
}

/**
 * The version the WRITER currently edits: the latest on-disk revision, or v1
 * (seeded empty) when none exists. Versioning is FILE-BASED and minted explicitly
 * via {@link copyToNextRevision} on each user-facing presentation — NOT derived
 * from approval count — so a new version appears only when the agent calls
 * `revise`, never as a side effect of re-running `next`.
 */
export function currentRevisionPath(
	sessionId: string,
	kind: ArtifactKind,
	ref: ArtifactRef = {},
): { n: number; path: string } {
	const dir = artifactDir(sessionId, kind, ref);
	mkdirSync(dir, { recursive: true });
	const latest = latestRevisionOnDisk(sessionId, kind, ref);
	const n = latest === 0 ? 1 : latest;
	const path = join(dir, `v${n}.md`);
	if (latest === 0 && !existsSync(path)) writeFileSync(path, "");
	return { n, path };
}

/**
 * Mint the next revision of a single-doc artifact by copying the latest version
 * forward (`vN → vN+1`), returning the new number + path. This is what
 * `kautopilot revise` calls for brainstorm/triage/spec/feedback: copy, then the
 * agent edits the new file, then presents it. Creates v1 (empty) when none exists.
 */
export function copyToNextRevision(
	sessionId: string,
	kind: ArtifactKind,
	ref: ArtifactRef = {},
): { n: number; path: string } {
	const dir = artifactDir(sessionId, kind, ref);
	mkdirSync(dir, { recursive: true });
	const latest = latestRevisionOnDisk(sessionId, kind, ref);
	if (latest === 0) {
		const path = join(dir, "v1.md");
		if (!existsSync(path)) writeFileSync(path, "");
		return { n: 1, path };
	}
	const next = latest + 1;
	copyFileSync(join(dir, `v${latest}.md`), join(dir, `v${next}.md`));
	return { n: next, path: join(dir, `v${next}.md`) };
}

/**
 * Mint the next plan-SET version for a repo: copy every plan folder's latest
 * version forward to one shared `v{N+1}`, returning the new set version + the repo
 * plans dir. (Plans are a set of folders sharing a version — `revise` advances the
 * whole set at once.) Creates v1 across existing plan folders when none exists.
 */
export function copyPlanSetToNext(
	sessionId: string,
	epoch: number,
	repo: string,
): { n: number; dir: string } {
	const dir = plansRepoDir(sessionId, epoch, repo);
	mkdirSync(dir, { recursive: true });
	const versions = listPlanSetVersions(sessionId, epoch, repo);
	const latest = versions.length ? Math.max(...versions) : 0;
	const next = latest === 0 ? 1 : latest + 1;
	for (const plan of readdirSync(dir)) {
		const planDir = join(dir, plan);
		try {
			readdirSync(planDir); // skip non-directory entries (throws → continue)
		} catch {
			continue;
		}
		const from = join(planDir, `v${latest}.md`);
		const to = join(planDir, `v${next}.md`);
		if (latest > 0 && existsSync(from) && !existsSync(to))
			copyFileSync(from, to);
	}
	return { n: next, dir };
}

/** Path of revision n (no creation). */
export function revisionPath(
	sessionId: string,
	kind: ArtifactKind,
	n: number,
	ref: ArtifactRef = {},
): string {
	return join(artifactDir(sessionId, kind, ref), `v${n}.md`);
}

/** Highest revision number present on disk (0 when none). */
export function latestRevisionOnDisk(
	sessionId: string,
	kind: ArtifactKind,
	ref: ArtifactRef = {},
): number {
	const dir = artifactDir(sessionId, kind, ref);
	if (!existsSync(dir)) return 0;
	let max = 0;
	for (const name of readdirSync(dir)) {
		const m = /^v(\d+)\.md$/.exec(name);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return max;
}

function readArtifactText(
	sessionId: string,
	kind: ArtifactKind,
	n: number,
	ref: ArtifactRef,
): string {
	const p = revisionPath(sessionId, kind, n, ref);
	return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

/** All revision version numbers present on disk for an artifact, ascending. */
export function listRevisions(
	sessionId: string,
	kind: ArtifactKind,
	ref: ArtifactRef = {},
): number[] {
	const dir = artifactDir(sessionId, kind, ref);
	if (!existsSync(dir)) return [];
	const versions: number[] = [];
	for (const name of readdirSync(dir)) {
		const m = /^v(\d+)\.md$/.exec(name);
		if (m) versions.push(Number(m[1]));
	}
	return versions.sort((a, b) => a - b);
}

/**
 * Like {@link listRevisions} but tags each on-disk revision with its epoch.
 * For epoch-scoped kinds the epoch is the ref's epoch (per-epoch numbering, so
 * every returned version belongs to that one epoch). For brainstorm the epoch is
 * always null (it precedes any epoch — data.ts special-cases brainstorm).
 */
export function listRevisionsWithEpoch(
	sessionId: string,
	kind: ArtifactKind,
	ref: ArtifactRef = {},
): { version: number; epoch: number | null }[] {
	const versions = listRevisions(sessionId, kind, ref);
	const epoch = isEpochless(kind) ? null : (ref.epoch ?? 1);
	return versions.map((version) => ({ version, epoch }));
}

/**
 * All plan-set version numbers present for a repo in an epoch (the union of `vN`
 * across that repo's plan folders), ascending. Plans written in one round share a
 * version, so these are the reviewable plan-set versions.
 */
export function listPlanSetVersions(
	sessionId: string,
	epoch: number,
	repo: string,
): number[] {
	const dir = plansRepoDir(sessionId, epoch, repo);
	if (!existsSync(dir)) return [];
	const versions = new Set<number>();
	for (const plan of readdirSync(dir)) {
		let entries: string[];
		try {
			entries = readdirSync(join(dir, plan));
		} catch {
			continue;
		}
		for (const name of entries) {
			const m = /^v(\d+)\.md$/.exec(name);
			if (m) versions.add(Number(m[1]));
		}
	}
	return [...versions].sort((a, b) => a - b);
}

/**
 * Concatenated markdown of every plan in a repo at plan-set version `n`, rendered
 * as `### <plan>\n<content>` blocks (the review view). Folders without that exact
 * version are skipped.
 */
export function readPlanSet(
	sessionId: string,
	epoch: number,
	repo: string,
	n: number,
): string {
	const dir = plansRepoDir(sessionId, epoch, repo);
	if (!existsSync(dir)) return "";
	return readdirSync(dir)
		.sort()
		.map((plan) => {
			const p = join(dir, plan, `v${n}.md`);
			return existsSync(p) ? `### ${plan}\n${readFileSync(p, "utf-8")}` : null;
		})
		.filter((s): s is string => s !== null)
		.join("\n\n");
}

/** Markdown content of revision n. */
export function readRevision(
	sessionId: string,
	kind: ArtifactKind,
	n: number,
	ref: ArtifactRef = {},
): string {
	return readArtifactText(sessionId, kind, n, ref);
}

/**
 * Unified line diff between two revisions (default n-1 → n). Pure (no external
 * `diff` binary): a minimal LCS-free line comparison good enough for review.
 */
export function diffRevisions(
	sessionId: string,
	kind: ArtifactKind,
	opts?: {
		from?: number;
		to?: number;
		epoch?: number | null;
		repo?: string | null;
		plan?: string | null;
	},
): string {
	const ref: ArtifactRef = {
		epoch: opts?.epoch,
		repo: opts?.repo,
		plan: opts?.plan,
	};
	// Plans without a specific plan folder diff the whole plan SET for the repo.
	const planSet = kind === "plans" && ref.plan == null;
	const epoch = ref.epoch ?? 1;
	const repo = ref.repo ?? "default";
	const read = (n: number): string =>
		planSet
			? readPlanSet(sessionId, epoch, repo, n)
			: readArtifactText(sessionId, kind, n, ref);
	const versions = planSet
		? listPlanSetVersions(sessionId, epoch, repo)
		: listRevisions(sessionId, kind, ref);
	const latest = versions.length ? Math.max(...versions) : 0;
	const to = opts?.to ?? latest;
	const from = opts?.from ?? to - 1;
	if (to <= 0) return `No revisions of ${kind} yet.`;
	const before = from >= 1 ? read(from) : "";
	const after = read(to);
	return renderDiff(before, after, `${kind} v${from} → v${to}`);
}

function renderDiff(before: string, after: string, label: string): string {
	const a = before.split("\n");
	const b = after.split("\n");
	const out: string[] = [`--- ${label} ---`];
	const max = Math.max(a.length, b.length);
	const aSet = new Set(a);
	const bSet = new Set(b);
	for (let i = 0; i < max; i++) {
		const al = a[i];
		const bl = b[i];
		if (al === bl) continue;
		if (al !== undefined && !bSet.has(al)) out.push(`- ${al}`);
		if (bl !== undefined && !aSet.has(bl)) out.push(`+ ${bl}`);
	}
	if (out.length === 1) out.push("(no textual changes)");
	return out.join("\n");
}
