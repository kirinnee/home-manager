import { ensureGlobalConfig, resolveConfig, writeConfig } from "./config";
import { upsertSession } from "./db";
import { generateSessionId } from "./id";
import {
	normalizePhases,
	type Phase,
	type PhaseProposal,
	proposePhases,
} from "./phase-plan";
import {
	type ExecMode,
	type Lpsm,
	type MergeMode,
	type Org,
	type RunMode,
	resolveOrgPolicy,
	type SessionMeta,
	writeSessionMeta,
} from "./session-meta";
import type { Config } from "./types";

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
	/** Writer-step execution (default from config.writer.mode). Pinned here so
	 *  later config flips never affect an in-flight session. */
	writerMode?: "inline" | "deferred";
	/** Explicit phase set (CLI `--phases`). When omitted, resolved from the
	 *  request-text keyword heuristics, then `config.settings.phases.default`. */
	phases?: Phase[];
	/** Per-session merge policy (default `manual` — ask before merging). */
	mergeMode?: MergeMode;
	maxParallelRepos?: number;
	/** AtomiCloud service-tree tags (atomicloud-only; omit for liftoff). */
	lpsm?: Lpsm;
	/** Arbitrary user-supplied free-form tags, distinct from the structured lpsm. */
	tags?: string[];
}

/** The `proposePhases` config view derived from a resolved config. */
function phaseCfgView(config: Config): {
	keywords: Config["settings"]["phases"]["keywords"];
	defaultPhases: Phase[];
	confidenceThreshold: number;
} {
	const p = config.settings.phases;
	return {
		keywords: p.keywords,
		defaultPhases: p.default,
		confidenceThreshold: p.confidenceThreshold,
	};
}

/**
 * Resolve the phase plan for a new session at `start`, for both PINNING and the
 * confidence-gated propose/ask UX: an explicit `--phases` set is a firm proposal
 * (confidence 1); otherwise the keyword heuristics propose a set + confidence from
 * the request text. The chosen set is always echoed and always overridable.
 */
export function proposeStartPhasePlan(
	org: Org,
	opts: { explicit?: Phase[]; requestText?: string | null },
): PhaseProposal {
	ensureGlobalConfig();
	const config = resolveConfig(org);
	if (opts.explicit && opts.explicit.length > 0) {
		return {
			phases: normalizePhases(opts.explicit),
			confidence: 1,
			decision: "propose",
			reasons: ["explicit --phases"],
		};
	}
	return proposePhases(opts.requestText, phaseCfgView(config));
}

export function createSession(input: CreateSessionInput): SessionMeta {
	const sessionId = generateSessionId();
	const policy = resolveOrgPolicy(input.org);

	ensureGlobalConfig();
	const config = resolveConfig(input.org);
	writeConfig(sessionId, config);

	// Resolve + pin the phase set: an explicit set wins; otherwise the keyword
	// heuristics propose one from the request text. (core/phase-plan.ts)
	const phases =
		input.phases && input.phases.length > 0
			? normalizePhases(input.phases)
			: proposePhases(input.request, phaseCfgView(config)).phases;

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
		writerMode: input.writerMode ?? config.writer.mode,
		phases,
		mergeMode: input.mergeMode ?? "manual",
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
