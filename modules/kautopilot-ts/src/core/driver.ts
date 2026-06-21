import { authoringRepoName } from "../phases/shared";
import { getStep } from "../steps/registry";
import { setCachedConfig } from "./agents";
import type {
	DoneDescriptor,
	NextResult,
	StepContext,
	StepDef,
	StepDescriptor,
	StepPhase,
} from "./descriptor";
import { appendEvent, readLog } from "./log";
import {
	type ArtifactKind,
	copyPlanSetToNext,
	copyToNextRevision,
} from "./revisions";
import {
	findRepo,
	type RepoEntry,
	readSessionMeta,
	type SessionMeta,
} from "./session-meta";
import type { Config } from "./types";

// ============================================================================
// Host-driven driver — `next` (block on code/detection, yield first
// interactive/agent step) and `complete` (validate → finalize → advance).
// The WAL is the source of truth; the cursor is recomputed from it every call,
// so `next` is idempotent and killing/re-running resumes exactly. (CLI-CONTRACT)
// ============================================================================

/** Entry step of the shared (session) timeline. */
const ENTRY_STEP = "resolve_org";

/** Entry step of a repo's execution/polish timeline (once plans are approved). */
const REPO_ENTRY = "seed";

/** Driver-special session gate: after plans approved, wait for every repo to be ready. */
const AWAIT_REPOS = "await_repos";

/** Map flat phase → legacy WAL phase marker so the existing reducer still works. */
const PHASE_MARKER: Record<StepPhase, string> = {
	plan: "phase1",
	execution: "phase2",
	polish: "phase3",
	feedback: "phase1",
};

/**
 * A cursor event carries both `step` and `to` in metadata. The pending step is
 * the `to` of the last such event (scope-filtered), or the entry step.
 */
function isCursorEvent(
	meta: Record<string, unknown> | undefined,
): meta is Record<string, unknown> {
	return !!meta && typeof meta.step === "string" && typeof meta.to === "string";
}

/** Whether this epoch's plans have been approved (gates repo timelines). */
function planApprovedThisEpoch(
	log: ReturnType<typeof readLog>,
	epoch: number,
): boolean {
	return log.some(
		(e) =>
			isCursorEvent(e.metadata) &&
			e.metadata.step === "finalize_plans" &&
			(e.metadata.repo ?? null) === null &&
			(e.version ?? 0) === epoch,
	);
}

/**
 * Compute the pending step name from the WAL — scope-aware (SPEC §13 #1, #11).
 * - Shared timeline (`repo == null`): only session-scoped cursor events (plan +
 *   feedback). Entry: `resolve_org`.
 * - Repo timeline (`repo == <name>`): only THIS epoch's events tagged with that
 *   repo. Entry: `seed`, available only once this epoch's plans are approved.
 * Recomputed every call → `next` is idempotent and resumes exactly.
 */
function pendingStep(
	sessionId: string,
	repo: string | null,
	epoch: number,
): string | null {
	const log = readLog(sessionId);
	let pending: string | null =
		repo == null
			? ENTRY_STEP
			: planApprovedThisEpoch(log, epoch)
				? REPO_ENTRY
				: null;
	for (const entry of log) {
		if (!isCursorEvent(entry.metadata)) continue;
		const evRepo = (entry.metadata.repo ?? null) as string | null;
		if (repo == null) {
			if (evRepo !== null) continue; // shared timeline: session-scoped only
		} else {
			if (evRepo !== repo) continue; // this repo only
			if ((entry.version ?? 0) !== epoch) continue; // this epoch only
		}
		const to = entry.metadata.to as string;
		pending = to === "done" ? null : to;
	}
	return pending;
}

function resolveRepo(
	meta: SessionMeta,
	def: StepDef,
	repoArg: string | null,
): RepoEntry | null {
	if (def.scope === "session") return null;
	if (repoArg) return findRepo(meta, repoArg);
	// Phase-1 one-repo flow: repo steps operate on the single registered repo.
	return meta.repos[0] ?? null;
}

function buildContext(
	meta: SessionMeta,
	config: Config,
	def: StepDef,
	repoArg: string | null,
): StepContext {
	return {
		sessionId: meta.sessionId,
		meta,
		config,
		repo: resolveRepo(meta, def, repoArg),
		version: meta.epoch,
	};
}

/** Emit a phase marker if the pending step crosses into a new phase. */
function maybeEmitPhaseMarker(
	sessionId: string,
	phase: StepPhase,
	version: number,
): void {
	const marker = PHASE_MARKER[phase];
	const log = readLog(sessionId);
	// Find the most recent phaseN:started.
	let lastPhase: string | null = null;
	for (const e of log) {
		const m = /^(phase\d):started$/.exec(e.event);
		if (m) lastPhase = m[1];
	}
	if (lastPhase !== marker) {
		appendEvent(sessionId, {
			ts: new Date().toISOString(),
			event: `${marker}:started`,
			version,
		});
	}
}

function doneResult(
	meta: SessionMeta,
	phase: StepPhase | "done",
	reason: string,
): DoneDescriptor {
	return { done: true, sessionId: meta.sessionId, phase, reason };
}

/**
 * `kautopilot next` — resolve the session, run every `code` step inline (blocking
 * on detection), and stop at the first `interactive`/`agent` step, returning its
 * descriptor. Returns `{ done: true }` when the flat machine has no pending step.
 */
export async function runNext(
	sessionId: string,
	config: Config,
	repoArg: string | null = null,
): Promise<NextResult> {
	const meta = readSessionMeta(sessionId);
	if (!meta) throw new Error(`No session.json for session ${sessionId}`);

	// Drive getAgentPrompt off this session's resolved config (incl. org prompt
	// overrides) instead of the built-in DEFAULT_CONFIG.
	setCachedConfig(config);

	// Bound concurrency (SPEC §11): a not-yet-started repo is queued while
	// `maxParallelRepos` others are already in progress, capping token use. A repo
	// already in progress (status 'active') is never blocked — it just continues.
	if (repoArg != null) {
		const r = findRepo(meta, repoArg);
		if (r && r.status === "pending") {
			const active = meta.repos.filter((x) => x.status === "active").length;
			if (active >= meta.maxParallelRepos) {
				return doneResult(
					meta,
					"execution",
					`repo ${repoArg} is queued — ${active}/${meta.maxParallelRepos} repos already in progress; retry once one reaches ready-to-merge`,
				);
			}
		}
	}

	// Run code steps inline until we hit an interactive/agent step or finish.
	// Bounded to guard against a mis-wired transition cycle.
	for (let guard = 0; guard < 1000; guard++) {
		const freshMetaPre = readSessionMeta(sessionId) ?? meta;
		const stepName = pendingStep(sessionId, repoArg, freshMetaPre.epoch);
		if (stepName == null) {
			if (repoArg != null) {
				return doneResult(meta, "polish", `repo ${repoArg} is ready to merge`);
			}
			return doneResult(meta, "done", "session complete");
		}

		// Driver-special gate: bare `next` after plan approval waits for every repo
		// to reach ready-to-merge (driven via `next --repo`), then runs feedback.
		if (stepName === AWAIT_REPOS) {
			const notReady = freshMetaPre.repos.filter((r) => r.status !== "ready");
			if (freshMetaPre.repos.length === 0 || notReady.length > 0) {
				const drive = notReady
					.map((r) => `kautopilot next --repo ${r.repo}`)
					.join("; ");
				return doneResult(
					meta,
					"execution",
					`Plan approved — drive each repo to ready-to-merge: ${drive || "(no repos registered)"}`,
				);
			}
			appendEvent(sessionId, {
				ts: new Date().toISOString(),
				event: "await_repos:completed",
				version: freshMetaPre.epoch,
				metadata: { step: AWAIT_REPOS, to: "feedback_check", repo: null },
			});
			continue;
		}

		const def = getStep(stepName);
		if (!def) throw new Error(`Unknown step in registry: ${stepName}`);

		const freshMeta = freshMetaPre;
		maybeEmitPhaseMarker(sessionId, def.phase, freshMeta.epoch);
		const ctx = buildContext(freshMeta, config, def, repoArg);

		if (def.kind === "code") {
			if (!def.run) throw new Error(`code step ${stepName} has no run()`);
			const next = await def.run(ctx);
			appendEvent(sessionId, {
				ts: new Date().toISOString(),
				event: `${stepName}:completed`,
				version: freshMeta.epoch,
				repo: ctx.repo?.repo,
				metadata: {
					step: stepName,
					to: next ?? "done",
					repo: ctx.repo?.repo ?? null,
				},
			});
			continue; // advance to the next step inline
		}

		// interactive / agent — yield the descriptor.
		if (!def.prepare) throw new Error(`step ${stepName} has no prepare()`);
		const prepared = await def.prepare(ctx);
		appendEvent(sessionId, {
			ts: new Date().toISOString(),
			event: `${stepName}:started`,
			version: freshMeta.epoch,
			repo: ctx.repo?.repo,
			metadata: {
				stepType: def.kind,
				step: stepName,
				repo: ctx.repo?.repo ?? null,
			},
		});
		const descriptor: StepDescriptor = {
			done: false,
			sessionId,
			ticketId: freshMeta.ticketId,
			phase: def.phase,
			step: stepName,
			kind: def.kind,
			repo: ctx.repo?.repo ?? null,
			version: freshMeta.epoch,
			prompt: prepared.prompt,
			vars: prepared.vars,
			contract: prepared.contract,
			review: prepared.review ?? null,
		};
		return descriptor;
	}
	throw new Error("next: step transition guard tripped (possible cycle)");
}

export interface CompleteResult {
	ok: boolean;
	recorded?: string;
	error?: string;
}

/** Which versioned artifact each interactive writer step authors. */
const STEP_ARTIFACT: Record<string, ArtifactKind> = {
	brainstorm: "brainstorm",
	triage: "triage",
	write_spec: "spec",
	write_plans: "plans",
	feedback: "feedback",
};

export interface ReviseResult {
	ok: boolean;
	error?: string;
	/** New version number that was minted. */
	version?: number;
	/** File (or plans dir) the agent should now edit for this new version. */
	path?: string;
	/** Viewer path for the new version (prefix with the configured base URL). */
	url?: string;
	/** Viewer path for the diff vs the previous version. */
	diffUrl?: string;
}

/**
 * `kautopilot revise` — mint the next version of the CURRENT interactive writer
 * artifact by copying the latest forward (file-based numbering). Each user-facing
 * presentation calls this: copy `vN → vN+1`, then the agent edits the returned
 * path, then presents the returned viewer link. Only writer steps (brainstorm,
 * triage, write_spec, write_plans, feedback) are revisable. Returns viewer PATHS
 * (the harness prefixes the configured base URL) so links are never hand-built.
 */
export async function runRevise(
	sessionId: string,
	config: Config,
	repoArg: string | null = null,
): Promise<ReviseResult> {
	const meta = readSessionMeta(sessionId);
	if (!meta) throw new Error(`No session.json for session ${sessionId}`);
	setCachedConfig(config);

	const step = pendingStep(sessionId, repoArg, meta.epoch);
	if (step == null) return { ok: false, error: "no pending step to revise" };
	const kind = STEP_ARTIFACT[step];
	if (!kind) {
		return {
			ok: false,
			error: `step ${step} is not a versioned writer step (nothing to revise)`,
		};
	}

	const epoch = meta.epoch;
	if (kind === "plans") {
		const repo = repoArg ?? authoringRepoName(meta);
		const { n, dir } = copyPlanSetToNext(sessionId, epoch, repo);
		const base = `/sessions/${sessionId}/plans/${encodeURIComponent(repo)}`;
		return {
			ok: true,
			version: n,
			path: dir,
			url: `${base}/v${n}`,
			diffUrl: `${base}/diff?from=${Math.max(1, n - 1)}&to=${n}`,
		};
	}

	const ref = kind === "brainstorm" ? {} : { epoch };
	const { n, path } = copyToNextRevision(sessionId, kind, ref);
	const base = `/sessions/${sessionId}/${kind}`;
	return {
		ok: true,
		version: n,
		path,
		url: `${base}/v${n}`,
		diffUrl: `${base}/diff?from=${Math.max(1, n - 1)}&to=${n}`,
	};
}

/**
 * `kautopilot complete <step>` — validate the step is pending for this scope,
 * validate the contract (output present, metadata schema), run finalize, snapshot
 * if directed, and append the canonical completionEvent (carrying the cursor `to`).
 */
export async function runComplete(
	sessionId: string,
	config: Config,
	step: string | undefined,
	opts: {
		output?: string;
		metadata?: Record<string, unknown>;
		repo?: string | null;
	},
): Promise<CompleteResult> {
	const meta = readSessionMeta(sessionId);
	if (!meta) throw new Error(`No session.json for session ${sessionId}`);

	// Drive getAgentPrompt off this session's resolved config (incl. org prompt
	// overrides) instead of the built-in DEFAULT_CONFIG.
	setCachedConfig(config);

	// The binary owns "which step" — the WAL cursor is the source of truth, so we
	// complete whatever step is actually pending for this scope, never a name the
	// caller remembered. `step` is an OPTIONAL assertion: if supplied and it does
	// not match the pending step, reject as stale (the caller is out of sync, e.g.
	// driving from memory) rather than silently completing the wrong thing.
	const repoArg = opts.repo ?? null;
	const pending = pendingStep(sessionId, repoArg, meta.epoch);
	if (pending == null) {
		return { ok: false, error: "no pending step to complete for this scope" };
	}
	if (step != null && pending !== step) {
		return {
			ok: false,
			error: `stale step: pending=${pending}, got=${step} (re-run \`next\` to re-sync — do not track steps yourself)`,
		};
	}
	// From here on, the pending step is authoritative regardless of what was passed.
	step = pending;

	const def = getStep(step);
	if (!def) return { ok: false, error: `unknown step: ${step}` };
	if (def.kind === "code")
		return {
			ok: false,
			error: `code step ${step} is not completable by the harness`,
		};
	if (!def.finalize) throw new Error(`step ${step} has no finalize()`);

	const ctx: StepContext = {
		...buildContext(meta, config, def, repoArg),
		output: opts.output,
		metadata: opts.metadata,
	};

	// Contract validation is the binary's job (artifact presence, not consent).
	const prepared = await def.prepare?.(ctx);
	const contract = prepared?.contract;
	if (contract?.outputFile && opts.output) {
		const { existsSync } = await import("node:fs");
		if (!existsSync(opts.output)) {
			return { ok: false, error: `output file not found: ${opts.output}` };
		}
	}
	if (contract?.completionMetadataSchema) {
		for (const key of Object.keys(contract.completionMetadataSchema)) {
			// presence is advisory; missing optional keys are tolerated by finalize.
			void key;
		}
	}

	const next = await def.finalize(ctx);
	const completionEvent = contract?.completionEvent ?? `${step}:completed`;
	appendEvent(sessionId, {
		ts: new Date().toISOString(),
		event: completionEvent,
		version: meta.epoch,
		repo: ctx.repo?.repo,
		metadata: {
			step,
			to: next ?? "done",
			repo: ctx.repo?.repo ?? null,
			...(opts.metadata ?? {}),
		},
	});
	return { ok: true, recorded: completionEvent };
}
