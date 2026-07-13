import { authoringRepoName } from "../phases/shared";
import { getStep } from "../steps/registry";
import { setCachedConfig } from "./agents";
import type {
	DoneDescriptor,
	NextResult,
	StepContext,
	StepDescriptor,
	StepPhase,
} from "./descriptor";
import { scopeLockKey, touchLock } from "./lock";
import { appendEvent, readLog } from "./log";
import { readOrchestration } from "./orchestration";
import {
	type ArtifactKind,
	copyPlanSetToNext,
	copyToNextRevision,
	latestRevisionOnDisk,
	listPlanSetVersions,
	plansRepoDir,
	revisionPath,
} from "./revisions";
import { computeSchedule } from "./scheduler";
import { readSessionMeta, type SessionMeta } from "./session-meta";
import type { Config } from "./types";
import { stepExecution } from "./writer/mode";

// ============================================================================
// Host-driven driver — `next` (block on code/detection, yield first
// interactive/agent step) and `complete` (validate → finalize → advance).
// The WAL is the source of truth; the cursor is recomputed from it every call,
// so `next` is idempotent and killing/re-running resumes exactly. (CLI-CONTRACT)
// ============================================================================

/** Entry step of the shared (session) timeline. */
const ENTRY_STEP = "resolve_org";

/** Driver-special session gate: after plans approved, wait for every repo to be ready. */
const AWAIT_REPOS = "await_repos";

/** Map flat phase → legacy WAL phase marker so the existing reducer still works. */
const PHASE_MARKER: Record<StepPhase, string> = {
	plan: "phase1",
	execution: "phase2",
	feedback: "phase3",
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

/**
 * Compute the pending step name from the WAL — scope-aware (SPEC §13 #1, #11).
 * - Shared timeline (`repo == null`): only session-scoped cursor events (plan +
 *   feedback). Entry: `resolve_org`.
 * Recomputed every call → `next` is idempotent and resumes exactly.
 */
export function pendingStep(sessionId: string): string | null {
	const log = readLog(sessionId);
	let pending: string | null = ENTRY_STEP;
	for (const entry of log) {
		if (!isCursorEvent(entry.metadata)) continue;
		const evRepo = (entry.metadata.repo ?? null) as string | null;
		if (evRepo !== null) continue; // shared timeline: session-scoped only
		const to = entry.metadata.to as string;
		pending = to === "done" ? null : to;
	}
	return pending;
}

function buildContext(meta: SessionMeta, config: Config): StepContext {
	return {
		sessionId: meta.sessionId,
		meta,
		config,
		repo: null,
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
	if (repoArg != null) {
		throw new Error(
			"`kautopilot next --repo` has been removed. Use `kautopilot schedule` and `kautopilot record` for execution/polish.",
		);
	}
	const meta = readSessionMeta(sessionId);
	if (!meta) throw new Error(`No session.json for session ${sessionId}`);

	// Drive getAgentPrompt off this session's resolved config (incl. org prompt
	// overrides) instead of the built-in DEFAULT_CONFIG.
	setCachedConfig(config);

	// Run code steps inline until we hit an interactive/agent step or finish.
	// Bounded to guard against a mis-wired transition cycle.
	const lockKey = scopeLockKey(sessionId, null);
	for (let guard = 0; guard < 1000; guard++) {
		// Heartbeat: each completed inline step proves progress so the lock's TTL
		// backstop doesn't reclaim a healthy long run (see touchLock / lockTtlMs).
		touchLock(lockKey);
		const freshMetaPre = readSessionMeta(sessionId) ?? meta;
		const stepName = pendingStep(sessionId);
		if (stepName == null) {
			return doneResult(meta, "done", "session complete");
		}

		// Driver-special gate after plan approval: the skill drives execution via
		// `kautopilot schedule`/`record`. The binary does not run kloop or PR polish.
		if (stepName === AWAIT_REPOS) {
			const orch = readOrchestration(sessionId);
			if (orch) {
				const sched = computeSchedule(orch);
				if (!sched.allReady) {
					const hint =
						sched.ready.length > 0
							? `ready: ${sched.ready.map((p) => `${p.repo}/${p.plan}`).join(", ")}`
							: sched.toMerge.length > 0
								? `merge to unblock: ${sched.toMerge.map((m) => m.pr).join(", ")}`
								: sched.running.length > 0
									? `running: ${sched.running.map((p) => `${p.repo}/${p.plan}`).join(", ")}`
									: "see `kautopilot schedule`";
					return doneResult(
						meta,
						"execution",
						`Plan approved — drive the DAG with \`kautopilot schedule\`/\`record\` (binary no longer drives kloop). Frontier: ${hint}`,
					);
				}
			} else if (freshMetaPre.repos.length > 0) {
				return doneResult(
					meta,
					"execution",
					"Plan approved, but no orchestration.yaml exists. Re-run/approve the master plan so execution can be driven with `kautopilot schedule`/`record`.",
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
		const ctx = buildContext(freshMeta, config);

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
		const execution = stepExecution(stepName, freshMeta, config);
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
			execution,
		};
		// Deferred steps yield a LIGHTWEIGHT descriptor: the full prompt (with the
		// writer gate), review payload, and heavy vars (templates, inline diff text)
		// travel via the writer session's message.md — never through the main
		// context. Only cheap path-like vars survive. (spec §3)
		if (execution === "deferred") {
			descriptor.prompt =
				`This step is DEFERRED to the writer session. Do NOT run it inline — ` +
				`drive it with \`kautopilot relay\` per the kautopilot skill's relay.md. ` +
				`The binary sends the full step prompt to the writer itself.`;
			descriptor.review = null;
			descriptor.vars = Object.fromEntries(
				Object.entries(prepared.vars).filter(
					([, v]) => v == null || (!v.includes("\n") && v.length <= 256),
				),
			);
		}
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
export const STEP_ARTIFACT: Record<string, ArtifactKind> = {
	brainstorm: "brainstorm",
	triage: "triage",
	write_spec: "spec",
	write_master_plan: "master_plan",
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
	/** Full viewer URL for the new version (host already prefixed). */
	url?: string;
	/** Full viewer URL for the diff vs the previous version. */
	diffUrl?: string;
	/** Full viewer URL of the standalone HTML infographic page. */
	visualUrl?: string;
}

/**
 * The configured public viewer base URL, with any trailing slash trimmed so
 * it can be joined to `/sessions/...` paths. Defaults to the local serve port
 * unless a public domain is set in config.yaml.
 */
function viewerBase(config: Config): string {
	return config.settings.viewerBaseUrl.replace(/\/+$/, "");
}

/**
 * Has the current working version (`latest`) of an artifact already been presented?
 * The writer step mints v1 as the working copy BEFORE the agent has shown anything,
 * so the FIRST `revise` must present that working copy as-is — copying it forward
 * there would create a redundant, empty-diff duplicate (v2 == v1). We record a
 * `revise:present` event per (scope, version); a later `revise` (after feedback)
 * sees that marker and copies forward to preserve the version already shown.
 */
export function alreadyPresented(
	sessionId: string,
	scope: string,
	version: number,
): boolean {
	if (version < 1) return false;
	return readLog(sessionId).some(
		(e) =>
			e.event === "revise:present" &&
			e.version === version &&
			e.metadata?.scope === scope,
	);
}

export function markPresented(
	sessionId: string,
	scope: string,
	version: number,
): void {
	appendEvent(sessionId, {
		ts: new Date().toISOString(),
		event: "revise:present",
		version,
		metadata: { scope },
	});
}

/**
 * The revise scope string for an artifact — the key `revise:present` events are
 * recorded under, and (identically) the deferred writer's phaseKey. (spec §1)
 */
export function artifactScope(
	kind: ArtifactKind,
	epoch: number,
	repo?: string | null,
): string {
	if (kind === "brainstorm") return "brainstorm";
	if (kind === "plans") return `plans@${epoch}:${repo ?? "default"}`;
	return `${kind}@${epoch}`;
}

/**
 * Mint-or-reuse the working version of an artifact WITHOUT marking it presented:
 * reuse the latest version when it hasn't been shown to the user yet (the step's
 * v1 seed, or a copy left by a failed/Q&A relay turn), else copy vN→vN+1. Shared
 * by `runRevise` (which then marks presented immediately) and the relay's version
 * prep (which marks presented only when an accepted turn says `revised: true`).
 */
export function mintOrReuseWorkingVersion(
	sessionId: string,
	kind: ArtifactKind,
	epoch: number,
	repo?: string | null,
): { n: number; path: string; scope: string } {
	const scope = artifactScope(kind, epoch, repo);
	if (kind === "plans") {
		const r = repo ?? "default";
		const versions = listPlanSetVersions(sessionId, epoch, r);
		const latest = versions.length ? Math.max(...versions) : 0;
		if (latest >= 1 && !alreadyPresented(sessionId, scope, latest)) {
			return { n: latest, path: plansRepoDir(sessionId, epoch, r), scope };
		}
		const { n, dir } = copyPlanSetToNext(sessionId, epoch, r);
		return { n, path: dir, scope };
	}
	const ref = kind === "brainstorm" ? {} : { epoch };
	const latest = latestRevisionOnDisk(sessionId, kind, ref);
	if (latest >= 1 && !alreadyPresented(sessionId, scope, latest)) {
		// First presentation: show the step's working copy as-is (no redundant copy).
		return {
			n: latest,
			path: revisionPath(sessionId, kind, latest, ref),
			scope,
		};
	}
	const { n, path } = copyToNextRevision(sessionId, kind, ref);
	return { n, path, scope };
}

/**
 * FULL viewer URLs for version n of an artifact (host prefixed from config) —
 * the single URL constructor: `runRevise` and the relay's enrichment both use it
 * so the harness never hand-builds a version URL. Plans have no single visualUrl
 * (each plan carries its own `<plan>/vN.html`, surfaced in the dashboard tabs).
 */
export function artifactUrls(
	config: Config,
	sessionId: string,
	kind: ArtifactKind,
	n: number,
	repo?: string | null,
): { url: string; diffUrl: string; visualUrl?: string } {
	const viewer = viewerBase(config);
	if (kind === "plans") {
		const base = `${viewer}/sessions/${sessionId}/plans/${encodeURIComponent(repo ?? "default")}`;
		return {
			url: `${base}/v${n}`,
			diffUrl: `${base}/diff?from=${Math.max(1, n - 1)}&to=${n}`,
		};
	}
	const base = `${viewer}/sessions/${sessionId}/${kind}`;
	return {
		url: `${base}/v${n}`,
		diffUrl: `${base}/diff?from=${Math.max(1, n - 1)}&to=${n}`,
		visualUrl: `${viewer}/sessions/${sessionId}/html/${kind}/v/${n}`,
	};
}

/**
 * `kautopilot revise` — return the version to present for the CURRENT interactive
 * writer artifact. The FIRST call presents the working copy the step already minted
 * (v1) as-is; every later call (after the user gave feedback) copies the last-shown
 * version forward (`vN → vN+1`) so the earlier version is never overwritten. The
 * agent edits the returned path, then presents the returned viewer link. Only writer
 * steps (brainstorm, triage, write_spec, write_plans, feedback) are revisable.
 * Returns FULL viewer URLs (the configured `viewerBaseUrl` is prefixed here) so the
 * harness presents them verbatim and never hand-builds a host or version.
 */
export async function runRevise(
	sessionId: string,
	config: Config,
	repoArg: string | null = null,
): Promise<ReviseResult> {
	const meta = readSessionMeta(sessionId);
	if (!meta) throw new Error(`No session.json for session ${sessionId}`);
	setCachedConfig(config);

	// Every revisable writer step is session-scoped. A `revise --repo` arg is only
	// the plan-bucket selector below for `kind === "plans"`.
	const step = pendingStep(sessionId);
	if (step == null) return { ok: false, error: "no pending step to revise" };
	const kind = STEP_ARTIFACT[step];
	if (!kind) {
		return {
			ok: false,
			error: `step ${step} is not a versioned writer step (nothing to revise)`,
		};
	}
	// Deferred phases are version-managed by `kautopilot relay` — a main session
	// running `revise` out of habit would skew the relay's bookkeeping (mark a
	// version presented the relay never handled). (spec §3)
	if (stepExecution(step, meta, config) === "deferred") {
		return {
			ok: false,
			error: `step ${step} is deferred to the writer session — versions are minted by \`kautopilot relay\`, not \`revise\``,
		};
	}

	const epoch = meta.epoch;
	const repo = kind === "plans" ? (repoArg ?? authoringRepoName(meta)) : null;
	const { n, path, scope } = mintOrReuseWorkingVersion(
		sessionId,
		kind,
		epoch,
		repo,
	);
	markPresented(sessionId, scope, n);
	const urls = artifactUrls(config, sessionId, kind, n, repo);
	return { ok: true, version: n, path, ...urls };
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
	if (opts.repo != null) {
		return {
			ok: false,
			error:
				"`kautopilot complete --repo` has been removed. Use `kautopilot schedule` and `kautopilot record` for execution/polish.",
		};
	}
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
	const pending = pendingStep(sessionId);
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
		...buildContext(meta, config),
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
		for (const [key, spec] of Object.entries(
			contract.completionMetadataSchema,
		)) {
			// Only plain enum specs (e.g. "feedback|done", "manual|auto?") are
			// machine-checkable here; array/object/free-form shapes stay advisory
			// and are tolerated by finalize.
			const bare = spec.endsWith("?") ? spec.slice(0, -1) : spec;
			if (!/^[a-z_]+(\|[a-z_]+)+$/.test(bare)) continue;
			const allowed = bare.split("|");
			const value = opts.metadata?.[key];
			if (value === undefined || value === null) {
				// Missing keys stay tolerated for most steps (finalize handles the
				// omission) — EXCEPT feedback_check, whose finalize would default a
				// missing choice to "done" and silently end the session. Demand an
				// explicit choice instead.
				if (step === "feedback_check") {
					return {
						ok: false,
						error:
							`feedback_check requires an explicit choice: pass --metadata '{"choice":"feedback"}' ` +
							`to start a new planning epoch or --metadata '{"choice":"done"}' to end the session. ` +
							`Omitting it is NOT treated as done.`,
					};
				}
				continue;
			}
			if (typeof value !== "string" || !allowed.includes(value)) {
				return {
					ok: false,
					error: `invalid metadata "${key}": expected one of ${allowed.join("|")}, got ${JSON.stringify(value)}`,
				};
			}
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
