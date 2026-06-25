import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sessionDir } from "./artifacts";
import { readConfig } from "./config";

// ============================================================================
// session.json — the one flat session's mutable metadata (§4, §11)
//
// Holds org/ticket binding, epoch, run/exec modes, parallelism, and the per-repo
// registry. There is NO group/member model: repos are entries here. Per-repo
// progress lives in `repos[]`; the WAL stays the source of truth for step state.
// ============================================================================

/** The two orgs kautopilot serves. The org is always asked, never auto-detected. */
export type Org = "liftoff" | "atomicloud";

/** Ticket system, fixed by the org's config. */
export type TicketSystem = "jira" | "clickup" | "none";

/** Where the controller loop runs (§6). No detached-Claude / `claude -p` path. */
export type RunMode = "current-session" | "sub-agent";

/** How a repo's plan is implemented at the `running` step (§6). */
export type ExecMode = "kloop" | "sub-agent";

/**
 * Per-session merge policy. Either way the binary always drives each PR to
 * ready-to-merge (CI green + threads resolved); `mergeMode` only decides what
 * happens THEN: `manual` asks the user before merging, `auto` merges itself. It
 * gates merge-/release-dependent downstream plans (see core/orchestration.ts).
 */
export type MergeMode = "manual" | "auto";

/**
 * AtomiCloud LPSM service-tree tags (atomicloud-only). Each tier has its own
 * naming theme: Landscape=environment (Pokémon), Cluster=Gemstone,
 * Platform=product/namespace (Functional Group; a ClickUp Space == a Platform),
 * Service=API/repo (Element/periodic-table), Module=free-form. All optional.
 */
export interface Lpsm {
	landscape?: string;
	cluster?: string;
	platform?: string;
	service?: string;
	module?: string;
}

/** A repo is a detail of the session — one (worktree, branch, plans[], PR, status). */
export interface RepoEntry {
	/** Logical repo name (also the key used by `next --repo <repo>`). */
	repo: string;
	/** Git root / remote the worktree derives from. */
	repoPath: string | null;
	/** Absolute worktrunk worktree path (null until seeded). */
	worktree: string | null;
	/** Branch for this repo's work (shared across epochs). */
	branch: string | null;
	/** Plan file basenames assigned to this repo. */
	plans: string[];
	/** Other repos that must reach a stable point first. */
	dependsOn: string[];
	prNumber: number | null;
	prUrl: string | null;
	/** This repo's current step (per-repo progress). */
	status: string;
	/** Per-repo exec-mode override (else the session default). */
	execMode?: ExecMode;
}

export interface SessionMeta {
	sessionId: string;
	/**
	 * The folder this session is associated with — the directory `kautopilot start`
	 * ran in. A session is NOT tied to any git repo or worktree: the repos it touches
	 * are decided by triage (`repos[]`), and each repo owns its own worktree. This is
	 * purely the bookkeeping location used to find a session again (`ps`/`continue`).
	 */
	folder: string;
	ticketId: string;
	/** The raw free-form request (ad-hoc, no ticket id). Drives brainstorm/create_ticket. */
	request?: string;
	org: Org;
	ticketSystem: TicketSystem;
	/** Whether the master spec is committed to each repo (atomicloud yes, liftoff no). */
	commitSpec: boolean;
	baseBranch: string;
	/** Epoch (delivery cycle): ticket → all PRs ready to merge. */
	epoch: number;
	runMode: RunMode;
	execMode: ExecMode;
	/** Whether the binary may merge a ready PR itself (`auto`) or must ask (`manual`). */
	mergeMode: MergeMode;
	maxParallelRepos: number;
	repos: RepoEntry[];
	/** AtomiCloud service-tree tags (atomicloud-only; undefined for liftoff). */
	lpsm?: Lpsm;
	/** Arbitrary user-supplied free-form tags, distinct from the structured lpsm. */
	tags?: string[];
}

// ============================================================================
// Org policy — fixed mapping, overridable per-org on disk
// ============================================================================

export interface OrgPolicy {
	org: Org;
	ticketSystem: TicketSystem;
	commitSpec: boolean;
	baseBranch: string;
}

/** Built-in org policy defaults (§10). Ultimate fallback when an org is absent
 * from the global config's `orgs` map. */
const ORG_DEFAULTS: Record<Org, OrgPolicy> = {
	liftoff: {
		org: "liftoff",
		ticketSystem: "jira",
		commitSpec: false,
		baseBranch: "master",
	},
	atomicloud: {
		org: "atomicloud",
		ticketSystem: "clickup",
		commitSpec: true,
		baseBranch: "main",
	},
};

export const ORGS: Org[] = ["liftoff", "atomicloud"];

export function isOrg(value: string): value is Org {
	return value === "liftoff" || value === "atomicloud";
}

/**
 * Resolve an org's policy from the GLOBAL config's `orgs` map (the single source
 * of truth). Falls back to the built-in ORG_DEFAULTS when the org is absent from
 * the config or the config cannot be read.
 */
export function resolveOrgPolicy(org: Org): OrgPolicy {
	try {
		const config = readConfig("");
		const entry = config?.orgs?.[org];
		if (entry) {
			return {
				org,
				ticketSystem: entry.ticketSystem,
				commitSpec: entry.commitSpec,
				baseBranch: entry.baseBranch,
			};
		}
	} catch {
		// Fall back to defaults on malformed/missing global config.
	}
	return { ...ORG_DEFAULTS[org] };
}

/**
 * Detect an org from a ticket id (§7.1 resolution precedence step 2). Jira-style
 * keys (PE-1234) map to liftoff; ClickUp numeric/CU- ids map to atomicloud.
 * Returns null when the id is ambiguous (caller then asks the user).
 */
export function detectOrgFromTicket(ticketId: string): Org | null {
	const id = ticketId.trim();
	if (/^[A-Z][A-Z0-9]+-\d+$/.test(id)) return "liftoff"; // Jira key, e.g. PE-1234
	if (/^(CU-|#)?[a-z0-9]{6,}$/i.test(id) && /\d/.test(id) && !/-\d+$/.test(id))
		return "atomicloud";
	return null;
}

// ============================================================================
// session.json I/O
// ============================================================================

function metaPath(sessionId: string): string {
	return join(sessionDir(sessionId), "session.json");
}

export function readSessionMeta(sessionId: string): SessionMeta | null {
	const path = metaPath(sessionId);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as SessionMeta;
	} catch {
		return null;
	}
}

export function writeSessionMeta(meta: SessionMeta): void {
	const path = metaPath(meta.sessionId);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
	renameSync(tmp, path);
}

/** Read → mutate → write atomically. Throws if the session has no meta yet. */
export function updateSessionMeta(
	sessionId: string,
	mutate: (meta: SessionMeta) => void,
): SessionMeta {
	const meta = readSessionMeta(sessionId);
	if (!meta) throw new Error(`No session.json for session ${sessionId}`);
	mutate(meta);
	writeSessionMeta(meta);
	return meta;
}

/** Find a repo entry by name, or null. */
export function findRepo(meta: SessionMeta, repo: string): RepoEntry | null {
	return meta.repos.find((r) => r.repo === repo) ?? null;
}
