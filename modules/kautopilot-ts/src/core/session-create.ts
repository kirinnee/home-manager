import { ensureGlobalConfig, resolveConfig, writeConfig } from "./config";
import { upsertSession } from "./db";
import { generateSessionId } from "./id";
import {
	type ExecMode,
	type Lpsm,
	type Org,
	type RunMode,
	resolveOrgPolicy,
	type SessionMeta,
	writeSessionMeta,
} from "./session-meta";

// ============================================================================
// Create a host-driven session: DB row + resolved config + session.json. Org is
// resolved by the caller (start) per precedence (--org → ticket → ask) and
// passed in here. (SPEC §10, §13 #5)
// ============================================================================

export interface CreateSessionInput {
	ticketId: string | null;
	/** The raw free-form request when there's no ticket id (ad-hoc flow). */
	request?: string;
	org: Org;
	/** The folder this session is associated with (where `kautopilot start` ran). */
	folder: string;
	runMode?: RunMode;
	execMode?: ExecMode;
	maxParallelRepos?: number;
	/** AtomiCloud service-tree tags (atomicloud-only; omit for liftoff). */
	lpsm?: Lpsm;
	/** Arbitrary user-supplied free-form tags, distinct from the structured lpsm. */
	tags?: string[];
}

export function createSession(input: CreateSessionInput): SessionMeta {
	const sessionId = generateSessionId();
	const policy = resolveOrgPolicy(input.org);

	ensureGlobalConfig();
	const config = resolveConfig(input.org);
	writeConfig(sessionId, config);

	const now = new Date().toISOString();
	upsertSession({
		id: sessionId,
		folder: input.folder,
		ticket_id: input.ticketId,
		local: input.ticketId ? 0 : 1,
		state: "running",
		created_at: now,
		updated_at: now,
	});

	const meta: SessionMeta = {
		sessionId,
		folder: input.folder,
		ticketId: input.ticketId ?? "",
		// Persist the raw request only for the ad-hoc (no-ticket) flow.
		...(input.request ? { request: input.request } : {}),
		org: input.org,
		ticketSystem: policy.ticketSystem,
		commitSpec: policy.commitSpec,
		baseBranch: policy.baseBranch,
		epoch: 1,
		runMode: input.runMode ?? config.settings.runMode,
		execMode: input.execMode ?? config.settings.execMode,
		maxParallelRepos:
			input.maxParallelRepos ?? config.settings.maxParallelRepos,
		repos: [],
		// Only set lpsm when provided — liftoff leaves it undefined.
		...(input.lpsm ? { lpsm: input.lpsm } : {}),
		// Only set free-form tags when non-empty.
		...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
	};
	writeSessionMeta(meta);
	return meta;
}
