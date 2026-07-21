import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authoringRepoName } from "../../phases/shared";
import { getStep } from "../../steps/registry";
import { setCachedConfig } from "../agents";
import type { StepContext } from "../descriptor";
import {
	alreadyPresented,
	artifactScope,
	artifactUrls,
	markPresented,
	mintOrReuseWorkingVersion,
	pendingStep,
	STEP_ARTIFACT,
} from "../driver";
import { scopeLockKey, touchLock } from "../lock";
import { appendEvent, readLog } from "../log";
import type { ArtifactKind } from "../revisions";
import { revisionPath } from "../revisions";
import {
	readSessionMeta,
	type SessionMeta,
	updateSessionMeta,
} from "../session-meta";
import type { Config, EnrichedEnvelope, Envelope } from "../types";
import { validateEnvelope } from "./envelope";
import {
	DaemonUnavailableError,
	WriterKteam,
	writerLabel,
	writerSessionName,
} from "./kteam";
import { stepExecution } from "./mode";
import { hasAlternative, pickAccount } from "./pool";
import {
	clearReply,
	hashMessage,
	isLegacyWriterState,
	lastProgress,
	lastTurn,
	listPhases,
	listTurns,
	readTurnMessage,
	readTurnMeta,
	readTurnReplyRaw,
	readWriterState,
	replyExists,
	type TurnMeta,
	turnPaths,
	type WriterState,
	writerJsonPath,
	writeTurnMessage,
	writeTurnMeta,
	writeTurnReply,
	writeWriterState,
} from "./scratch";

// ============================================================================
// The relay turn engine: one `kautopilot relay` call = one writer-session turn,
// now driven through a PERSISTENT kteamd session (WriterKteam) instead of
// kautopilot's own tmux. Recovery matrix, version prep (binary-minted),
// envelope validation, enrichment, and WAL are unchanged; the harness is
// kteam start/send + `wait --until-marker <reply.json>`. kteam owns the TUI,
// resume/crash-recovery, and account failover — so the spec's rebootstrap,
// fatal-pane scanning, and `--session-id`/`--resume` machinery are gone.
// (specs/deferred-writer-relay.md §4)
// ============================================================================

export interface RelayResult {
	ok: boolean;
	error?: string;
	envelope?: EnrichedEnvelope;
	phaseKey?: string;
	turn?: number;
	/** The kteam session that ran (or would run) the turn — the watch handle. */
	kteamSession?: string;
	/** Path to the meta.json holding the failure snapshot, when one was captured. */
	snapshotPath?: string;
	remediation?: string[];
}

interface PhaseInfo {
	step: string;
	kind: ArtifactKind;
	epoch: number;
	repo: string | null;
	phaseKey: string;
}

function resolvePhase(
	sessionId: string,
	meta: SessionMeta,
	config: Config,
): PhaseInfo | { error: string } {
	const step = pendingStep(sessionId);
	if (step == null) return { error: "no pending step" };
	const kind = STEP_ARTIFACT[step];
	if (!kind) return { error: `step ${step} is not a writer step` };
	if (stepExecution(step, meta, config) !== "deferred") {
		return {
			error: `step ${step} is not deferred (writerMode=${meta.writerMode ?? "inline"}) — run it inline per the descriptor`,
		};
	}
	const epoch = meta.epoch;
	// Plans author against the session's authoring repo (same as runRevise).
	const repo = kind === "plans" ? authoringRepoName(meta) : null;
	return {
		step,
		kind,
		epoch,
		repo,
		phaseKey: artifactScope(kind, epoch, repo),
	};
}

// --- envelope contract text ------------------------------------------------

const ENVELOPE_CONTRACT = `## Reply contract (EVERY turn)

Write \`{replyPath}\` as JSON matching EXACTLY this shape. It is your VERY LAST
action of the turn — the relay watches for this file and reads it the instant it
appears, so write it atomically (write a temp file, then rename it into place) and
never leave a half-written file:

\`\`\`jsonc
{
  "summary": "2-4 short lines: what happened this turn (max 600 chars)",
  "answers": [ { "question": "…", "answer": "…" } ],        // the user's last questions
  "questions": [                                             // ≤5, only what NEEDS the user
    { "id": "q1", "text": "…", "options": ["…", "…"] }       // options optional
  ],
  "openItems": [ "…" ],                                      // ≤10 × ≤200 chars
  "artifact": { "kind": "{kind}", "version": {workingVersion}, "revised": true|false },
  "reviews": { "clean": true, "rounds": 2, "unresolved": [] },   // ONLY if reviewers were provided
  "proposedCompletionMetadata": { }                          // once the phase looks approvable
}
\`\`\`

- \`revised: true\` ONLY when you actually edited the artifact this turn — the relay
  verifies the artifact AND its visual (vN.html) exist on disk and rejects otherwise.
- A pure Q&A turn: \`revised: false\`, leave the artifact untouched.
- Append one-line phase markers to \`{progressPath}\` as you work (drafting / reviewers /
  visual / finalizing) — the user watches this live.
- proposedCompletionMetadata shape for THIS step: {metadataSchema}`;

function envelopeContract(vars: {
	replyPath: string;
	progressPath: string;
	kind: string;
	workingVersion: number;
	metadataSchema: string;
}): string {
	let out = ENVELOPE_CONTRACT;
	for (const [k, v] of Object.entries(vars)) {
		out = out.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
	}
	return out;
}

/** Human description of the step's completion metadata for the contract. */
function describeMetadataSchema(step: string): string {
	switch (step) {
		case "triage":
			return `{ "complexity": "straightforward|moderate|complex", "repos": ["…"], "repoPaths": {"<repo>": "/abs/path"}, "dependsOn": {"<repo>": ["…"]}, "branchSlug": "short-slug" }`;
		case "write_master_plan":
			return `{ "mergeMode": "manual|auto", "prs": [...], "nodes": [...], "deps": [...] } (per the master-plan mechanics)`;
		case "feedback":
			return `{ "rules": ["generalized rule", …] }`;
		default:
			return `{} (this step has no completion metadata — omit the field)`;
	}
}

// --- WAL / enrichment helpers ------------------------------------------------

/** WAL append — metadata NEVER carries step/to (provably non-cursor events). */
function relayEvent(
	sessionId: string,
	event: string,
	phaseKey: string,
	turn: number,
	extra: Record<string, unknown> = {},
): void {
	appendEvent(sessionId, {
		ts: new Date().toISOString(),
		event,
		metadata: { phaseKey, turn, ...extra },
	});
}

/** Highest version already marked presented for a scope, or null — one WAL
 *  pass (never N × alreadyPresented re-parses). */
function lastPresentedVersion(
	sessionId: string,
	kind: ArtifactKind,
	epoch: number,
	repo: string | null,
): number | null {
	const scope = artifactScope(kind, epoch, repo);
	let max: number | null = null;
	for (const e of readLog(sessionId)) {
		if (
			e.event === "revise:present" &&
			e.metadata?.scope === scope &&
			typeof e.version === "number"
		) {
			max = max == null ? e.version : Math.max(max, e.version);
		}
	}
	return max;
}

/** Enrich an accepted envelope with binary-built links + provenance. */
function enrich(params: {
	envelope: Envelope;
	config: Config;
	sessionId: string;
	kind: ArtifactKind;
	epoch: number;
	repo: string | null;
	phaseKey: string;
	turn: number;
	account: string;
}): EnrichedEnvelope {
	const {
		envelope,
		config,
		sessionId,
		kind,
		epoch,
		repo,
		phaseKey,
		turn,
		account,
	} = params;
	// A revised turn links the just-presented working version; a Q&A turn links
	// the last presented version — or nothing when none has been presented yet.
	const version = envelope.artifact.revised
		? envelope.artifact.version
		: lastPresentedVersion(sessionId, kind, epoch, repo);
	let links: EnrichedEnvelope["links"] = {
		read: null,
		diff: null,
		visual: null,
	};
	if (version != null) {
		const urls = artifactUrls(config, sessionId, kind, version, repo);
		links = {
			read: urls.url,
			diff: version > 1 ? urls.diffUrl : null,
			visual: urls.visualUrl ?? null,
		};
	}
	return { ...envelope, links, turn, phaseKey, account };
}

// --- message composition ------------------------------------------------------

function readVisualBrief(config: Config): string | null {
	const path = config.writer.visualBriefPath.replace(
		/^~(?=\/)/,
		process.env.HOME ?? "~",
	);
	try {
		return existsSync(path) ? readFileSync(path, "utf-8") : null;
	} catch {
		return null;
	}
}

/**
 * Compose turn-N/message.md. ORDER MATTERS on turn 1: `prepare()` runs FIRST
 * (its {lastDiff}/currentRevisionPath must see the pre-mint state), THEN version
 * prep mints/reuses the working version. Approval turns skip version prep
 * entirely (no phantom trailing versions at phase end). Turn ≥2 lives in the
 * resumed kteam conversation, so it carries only the user's message + a
 * self-sufficient contract reminder (auto-compaction must never lose it).
 */
async function composeMessage(params: {
	sessionId: string;
	meta: SessionMeta;
	config: Config;
	step: string;
	kind: ArtifactKind;
	epoch: number;
	repo: string | null;
	turn: number;
	paths: ReturnType<typeof turnPaths>;
	userMessage: string;
	approval: boolean;
}): Promise<{ message: string; workingVersion: number }> {
	const {
		sessionId,
		meta,
		config,
		step,
		kind,
		epoch,
		repo,
		turn,
		paths,
		userMessage,
		approval,
	} = params;
	const parts: string[] = [];
	const turnOneStyle = turn === 1;

	// 1. prepare() — turn 1 only (later turns live in the resumed conversation).
	let preparedPrompt: string | null = null;
	let reviewBlock: string | null = null;
	if (turnOneStyle) {
		const def = getStep(step);
		if (!def?.prepare) throw new Error(`step ${step} has no prepare()`);
		const ctx: StepContext = {
			sessionId,
			meta,
			config,
			repo: null,
			version: meta.epoch,
		};
		const prepared = await def.prepare(ctx);
		preparedPrompt = prepared.prompt;
		if (prepared.review) {
			reviewBlock =
				`## Reviewer fan-out (run these as parallel subagents on every revising turn${config.writer.reviewerModel ? `; model: ${config.writer.reviewerModel}` : ""})\n\n` +
				prepared.review.reviewers
					.map((r) => `### Reviewer: ${r.id}\n${r.prompt}`)
					.join("\n\n") +
				`\n\n### Synthesize\n${prepared.review.synthesize.prompt}\nWrite the synthesized list to: ${prepared.review.synthesize.outputFile}`;
		}
	}

	// 2. Version prep — AFTER prepare; skipped on approval turns (they must not
	// leave a phantom unpresented version behind at phase end).
	let workingVersion: number;
	let workingPath: string | null = null;
	if (approval) {
		workingVersion = lastPresentedVersion(sessionId, kind, epoch, repo) ?? 1;
	} else {
		const minted = mintOrReuseWorkingVersion(sessionId, kind, epoch, repo);
		workingVersion = minted.n;
		workingPath = minted.path;
	}

	// 3. Assemble.
	if (preparedPrompt) parts.push(preparedPrompt);
	if (reviewBlock) parts.push(reviewBlock);
	if (turnOneStyle) {
		const brief = readVisualBrief(config);
		parts.push(
			brief
				? `## Visual infographic brief (generate vN.html per revising turn)\n\n${brief}`
				: `## Visual infographic\n\nGenerate a standalone, infographic-style vN.html beside each revised artifact version. Use the frontend-design skill if available; otherwise apply strong visual-hierarchy principles.`,
		);
	}
	// The contract is in EVERY message — auto-compaction in a long writer
	// session must never lose it.
	parts.push(
		envelopeContract({
			replyPath: paths.reply,
			progressPath: paths.progress,
			kind,
			workingVersion,
			metadataSchema: describeMetadataSchema(step),
		}),
	);
	if (!turnOneStyle) {
		parts.push(
			`Visual brief: ${config.writer.visualBriefPath} (re-read it if it's no longer in your context).`,
		);
	}
	if (workingPath) {
		parts.push(
			`## Working version\n\nEdit **v${workingVersion}** at: ${workingPath}\n(Only edit it if this turn actually revises the artifact.)`,
		);
	}
	if (approval) {
		parts.push(
			`## The user APPROVED\n\nFinal consistency check: verify the artifact matches everything agreed in the discussion and that proposedCompletionMetadata is complete and correct. Do NOT revise (revised=false) unless something is genuinely broken — a revision forces a re-presentation round.`,
		);
	}
	if (userMessage) {
		parts.push(`## Message from the user (turn ${turn})\n\n${userMessage}`);
	} else if (turn === 1) {
		parts.push(
			`## Kickoff\n\nThis is turn 1 — begin the step's work now, then reply per the contract.`,
		);
	}
	return { message: parts.join("\n\n---\n\n"), workingVersion };
}

// --- accept / fail --------------------------------------------------------------

function acceptTurn(params: {
	sessionId: string;
	config: Config;
	kind: ArtifactKind;
	epoch: number;
	repo: string | null;
	phaseKey: string;
	turn: number;
	envelope: Envelope;
	writer: WriterState;
	turnMeta: TurnMeta;
}): RelayResult {
	const {
		sessionId,
		config,
		kind,
		epoch,
		repo,
		phaseKey,
		turn,
		envelope,
		writer,
		turnMeta,
	} = params;
	// Only a revising, accepted turn burns a presentation (idempotent on re-run).
	if (envelope.artifact.revised) {
		const scope = artifactScope(kind, epoch, repo);
		if (!alreadyPresented(sessionId, scope, envelope.artifact.version)) {
			markPresented(sessionId, scope, envelope.artifact.version);
		}
	}
	const enriched = enrich({
		envelope,
		config,
		sessionId,
		kind,
		epoch,
		repo,
		phaseKey,
		turn,
		account: writer.account,
	});
	writeTurnReply(sessionId, phaseKey, turn, enriched);
	turnMeta.state = "replied";
	turnMeta.repliedAt = new Date().toISOString();
	turnMeta.accepted = true;
	writeTurnMeta(sessionId, phaseKey, turnMeta);
	writer.status = "idle";
	writer.turns = turn;
	writeWriterState(sessionId, writer);
	relayEvent(sessionId, "relay:reply", phaseKey, turn, {
		revised: envelope.artifact.revised,
		version: envelope.artifact.version,
	});
	return { ok: true, envelope: enriched, phaseKey, turn };
}

function failTurn(
	sessionId: string,
	phaseKey: string,
	turn: number,
	turnMeta: TurnMeta,
	writer: WriterState,
	params: { error: string; kteamSession?: string; config: Config },
): RelayResult {
	turnMeta.state = "failed";
	writeTurnMeta(sessionId, phaseKey, turnMeta);
	writer.status = "failed";
	writeWriterState(sessionId, writer);
	relayEvent(sessionId, "relay:failed", phaseKey, turn, {
		error: params.error,
	});
	const remediation = [
		"Re-run `kautopilot relay` with no message to re-attach — `kteam send` auto-revives the writer session (cheapest; e.g. after a rate-limit window resets).",
	];
	remediation.push(
		hasAlternative(params.config.writer.pool, writer.account)
			? "kteam handles account failover within the session; the pool's other accounts are used automatically if the daemon rotates."
			: "The pool has a single account — waiting for it to recover is the only automatic path.",
	);
	remediation.push(
		"`kautopilot relay --fallback-inline` flips the REST of the session to inline. ⚠️ That runs the full writer workload (prompt + reviewers + visuals) in the MAIN session/account and cannot be undone this session — confirm with the user first.",
	);
	return {
		ok: false,
		error: params.error,
		phaseKey,
		turn,
		kteamSession: params.kteamSession,
		snapshotPath: turnMeta.snapshot
			? turnPaths(sessionId, phaseKey, turn).meta
			: undefined,
		remediation,
	};
}

/** Loud refusal when a phase's writer.json predates the kteam harness (tmux
 *  era). Starting a fresh kteam writer would leave the old tmux writer running
 *  (invisible to label-based cleanup) to race on reply.json, so we start
 *  nothing and point the operator at the stale state to finish or delete. */
function migrationRequiredResult(
	sessionId: string,
	phaseKey: string,
): RelayResult {
	const statePath = writerJsonPath(sessionId, phaseKey);
	const scratchDir = dirname(statePath);
	return {
		ok: false,
		error: `writer.json for phase ${phaseKey} is from the pre-kteam (tmux) harness — refusing to start a competing writer that could race the old session on reply.json.`,
		phaseKey,
		remediation: [
			`Finish or stop the old deferred writer session, then retry. Its state file: ${statePath}`,
			`To discard it and start fresh on kteam, delete the phase scratch dir: ${scratchDir}`,
			`(An old tmux writer is not tracked by the new \`kteam ps --label kauto-<sessionId>\` cleanup — check \`tmux ls\` for a stray \`kap-${sessionId}-*\` session and kill it too.)`,
		],
	};
}

/** Loud, non-corrupting failure when kteamd is unreachable: the turn stays
 *  re-attachable (state reverted to "sent", writer "interrupted"), never marked
 *  failed — the next `relay` re-attaches once the daemon is back. */
function daemonDownResult(
	phaseKey: string | undefined,
	turn: number | undefined,
	message: string,
): RelayResult {
	return {
		ok: false,
		error: message,
		phaseKey,
		turn,
		remediation: [
			"Start the daemon: `kteam daemon start` (or `kteam daemon status` to check it).",
			"Then re-run `kautopilot relay` with no message to re-attach — no turn state was lost.",
		],
	};
}

// ============================================================================
// The engine
// ============================================================================

export async function runRelay(
	sessionId: string,
	config: Config,
	opts: {
		message?: string;
		approval?: boolean;
		fallbackInline?: boolean;
		harness?: WriterKteam;
	},
): Promise<RelayResult> {
	const meta = readSessionMeta(sessionId);
	if (!meta) throw new Error(`No session.json for session ${sessionId}`);
	setCachedConfig(config);

	// --- explicit escape hatch --------------------------------------------------
	if (opts.fallbackInline) {
		const phaseForEvent = (() => {
			const step = pendingStep(sessionId);
			const kind = step ? STEP_ARTIFACT[step] : undefined;
			if (!kind) return step ?? "?";
			const repo = kind === "plans" ? authoringRepoName(meta) : null;
			return artifactScope(kind, meta.epoch, repo);
		})();
		updateSessionMeta(sessionId, (m) => {
			m.writerMode = "inline";
		});
		relayEvent(sessionId, "relay:fallback_inline", phaseForEvent, 0);
		return {
			ok: true,
			remediation: [
				"writerMode is now inline for the REST of this session (cannot switch back).",
				"Re-run `kautopilot next` — the descriptor returns inline with the full prompt.",
				"⚠️ inline runs the full writer workload (prompt + reviewers + visuals) in THIS session/account.",
			],
		};
	}

	const phase = resolvePhase(sessionId, meta, config);
	if ("error" in phase) return { ok: false, error: phase.error };
	const { step, kind, epoch, repo, phaseKey } = phase;
	const harness = opts.harness ?? new WriterKteam();
	const lockKey = scopeLockKey(sessionId, null);
	const msg = opts.message?.trim() ?? "";
	const msgHash = msg ? hashMessage(msg) : null;

	// --- legacy-state guard: NEVER start a competing writer over a tmux-era session
	// (its process is invisible to the new label-based cleanup and would race on
	// reply.json). Refuse loudly and tell the operator to finish/delete it.
	const existing = readWriterState(sessionId, phaseKey);
	if (isLegacyWriterState(existing)) {
		return migrationRequiredResult(sessionId, phaseKey);
	}

	// --- daemon-down guard (spec §4.4): fail loudly BEFORE touching turn state ---
	if (!(await harness.daemonReachable())) {
		return daemonDownResult(
			phaseKey,
			undefined,
			"kteam daemon is unreachable — the deferred writer runs on kteamd, which is not responding.",
		);
	}

	// --- writer session (pin the account at phase start) -------------------------
	let writer = existing;
	if (!writer) {
		writer = {
			phaseKey,
			account: pickAccount(config.writer.pool),
			cwd: meta.folder,
			status: "idle",
			turns: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeWriterState(sessionId, writer);
	}

	// --- recovery matrix (spec §4.3) ----------------------------------------------
	const last = lastTurn(sessionId, phaseKey);
	const lastMeta = last > 0 ? readTurnMeta(sessionId, phaseKey, last) : null;

	if (lastMeta) {
		// Accepted reply + no message OR the same user message (retry after the
		// envelope printed but before the skill recorded it) → return idempotently.
		// An --approval invocation is a NEW turn even without a message — never
		// swallowed by the idempotent return (unless the last turn WAS the approval).
		if (
			lastMeta.accepted &&
			(!msg || msgHash === lastMeta.userMessageHash) &&
			(!opts.approval || lastMeta.approval)
		) {
			const raw = readTurnReplyRaw(sessionId, phaseKey, last);
			if (raw != null) {
				return {
					ok: true,
					envelope: raw as EnrichedEnvelope,
					phaseKey,
					turn: last,
				};
			}
		}
		// Unaccepted turn + a NEW different message → refuse (turn in flight).
		if (!lastMeta.accepted && msg && msgHash !== lastMeta.userMessageHash) {
			return {
				ok: false,
				error: `turn ${last} is still in flight (state=${lastMeta.state}) — re-run \`relay\` with no message to re-attach, or wait for it to fail`,
				phaseKey,
				turn: last,
			};
		}
	}

	// Re-attach an unaccepted last turn; else compose turn N+1.
	const reattach = lastMeta != null && !lastMeta.accepted;
	const turn = reattach ? last : last + 1;
	const paths = turnPaths(sessionId, phaseKey, turn);
	// The approval-ness of a re-attached turn comes from its STORED meta — never
	// from this invocation's --approval flag (the documented recovery call passes
	// no flags; re-deriving from the flag would mint a phantom version).
	const approval = reattach
		? (lastMeta?.approval ?? false)
		: (opts.approval ?? false);
	let workingVersion: number;
	let turnMeta: TurnMeta;

	if (!reattach) {
		if (!msg && turn > 1 && !approval) {
			return {
				ok: false,
				error:
					"a new turn needs --message/--message-file (the user's answers/feedback); re-running with no message only re-presents or re-attaches",
			};
		}
		// Meta is written FIRST (state "sent", pre-compose) so a crash between the
		// two writes leaves a re-attachable turn, never an orphaned dir that the
		// next relay would silently skip past (turn 1's prompt would be lost).
		turnMeta = {
			turn,
			state: "sent",
			sentAt: new Date().toISOString(),
			attempts: 0,
			userMessageHash: msgHash ?? "",
			// Stored in full: recovery recompose rebuilds the turn from this copy
			// (message.md may not exist yet on a mid-compose crash).
			userMessage: msg || undefined,
			approval,
			workingVersion: 0, // filled in right below, post-compose
		};
		writeTurnMeta(sessionId, phaseKey, turnMeta);
		const composed = await composeMessage({
			sessionId,
			meta,
			config,
			step,
			kind,
			epoch,
			repo,
			turn,
			paths,
			userMessage: msg,
			approval,
		});
		workingVersion = composed.workingVersion;
		writeTurnMessage(sessionId, phaseKey, turn, composed.message);
		turnMeta.workingVersion = workingVersion;
		turnMeta.artifactHashAtSend = hashWorkingArtifact(
			sessionId,
			kind,
			epoch,
			workingVersion,
		);
		writeTurnMeta(sessionId, phaseKey, turnMeta);
		relayEvent(sessionId, "relay:sent", phaseKey, turn, { approval });
	} else {
		turnMeta = lastMeta as TurnMeta;
		// A fresh relay invocation gets a fresh attempt budget — a turn that
		// burned its retries (e.g. during a rate-limit window) must be retryable
		// later, not permanently wedged at attempts >= max.
		if (turnMeta.attempts >= 1 + config.writer.maxTurnRetries) {
			turnMeta.attempts = 0;
		}
		// Re-attach: validate against the version the crashed turn actually handed
		// out (stored in meta) — NEVER re-derive: after a crash inside acceptTurn
		// (markPresented done, accepted-flag not yet written) a re-derive would
		// copy the now-presented version forward and reject the writer's reply.
		workingVersion =
			turnMeta.workingVersion > 0
				? turnMeta.workingVersion
				: approval
					? (lastPresentedVersion(sessionId, kind, epoch, repo) ?? 1)
					: mintOrReuseWorkingVersion(sessionId, kind, epoch, repo).n;
		// A meta written pre-compose but never post-compose (crash mid-compose) has
		// workingVersion 0 and possibly no message.md — recompose in place.
		if (
			turnMeta.workingVersion === 0 ||
			readTurnMessage(sessionId, phaseKey, turn) == null
		) {
			const composed = await composeMessage({
				sessionId,
				meta,
				config,
				step,
				kind,
				epoch,
				repo,
				turn,
				paths,
				userMessage: turnMeta.userMessage ?? "",
				approval,
			});
			workingVersion = composed.workingVersion;
			writeTurnMessage(sessionId, phaseKey, turn, composed.message);
			turnMeta.workingVersion = workingVersion;
			writeTurnMeta(sessionId, phaseKey, turnMeta);
		}
	}

	// --- send / retry loop ----------------------------------------------------------
	const maxAttempts = 1 + config.writer.maxTurnRetries;
	// On a re-attach, the first message is a nudge (not the original) — the writer
	// is mid-turn in its kteam session and just needs to finish + emit reply.json.
	let nudgeFile: string | null = reattach
		? writeNudge(
				paths.dir,
				turnMeta.attempts + 1,
				`You were sent turn ${turn} at ${turnMeta.sentAt} but the controller lost track of you. Re-read ${paths.message}, finish the turn, then write ${paths.reply} (atomically) as your last action.`,
			)
		: null;

	// ADOPTION fast-path: the writer finished (reply.json on disk) while the
	// controller was dead — accept from disk without re-sending. Acceptance is
	// idempotently re-runnable (markPresented skips when already marked), so a
	// crash between validation and enrichment lands here too.
	if (reattach && turnFinishedOnDisk(sessionId, phaseKey, turn)) {
		const raw = readTurnReplyRaw(sessionId, phaseKey, turn);
		const check = validateEnvelope({
			raw,
			sessionId,
			kind,
			epoch,
			repo,
			workingVersion,
		});
		if (check.ok && check.envelope) {
			return acceptTurn({
				sessionId,
				config,
				kind,
				epoch,
				repo,
				phaseKey,
				turn,
				envelope: check.envelope,
				writer,
				turnMeta,
			});
		}
		// Invalid on disk → fall through to a corrective re-send.
	}

	while (turnMeta.attempts < maxAttempts) {
		turnMeta.attempts++;
		const attempt = turnMeta.attempts;
		turnMeta.state = "running";
		writeTurnMeta(sessionId, phaseKey, turnMeta);
		writer.status = "running";
		writeWriterState(sessionId, writer);
		// Spawn notice on stderr (stdout stays pure JSON): the live-watch line the
		// skill relays to the user.
		const watch = writer.kteamSessionId
			? `kteam attach ${writer.kteamSessionId}`
			: `kteam ps -l ${writerLabel(sessionId)}`;
		process.stderr.write(
			`writer turn ${turn} (attempt ${attempt}) on ${writer.account} — watch live: ${watch}\n`,
		);

		// Marker hygiene: a reply.json from a prior attempt must never read as this
		// attempt's completion.
		clearReply(sessionId, phaseKey, turn);

		touchLock(lockKey);
		let result: Awaited<ReturnType<WriterKteam["runTurn"]>>;
		try {
			result = await harness.runTurn({
				kteamSessionId: writer.kteamSessionId,
				account: writer.account,
				name: writerSessionName(kind),
				label: writerLabel(sessionId),
				cwd: writer.cwd,
				messageFile: nudgeFile ?? paths.message,
				markerFile: paths.reply,
				timeoutMins: config.writer.turnTimeoutMins,
				// Persist the freshly-minted kteam id SYNCHRONOUSLY, before the first
				// wait — so a daemon failure mid-wait leaves a re-attachable turn
				// pointing at the real session, never orphans it into a rival start.
				onSessionCreated: (id) => {
					writer.kteamSessionId = id;
					writeWriterState(sessionId, writer);
				},
				// Heartbeat during the (possibly 30-min) turn — without it the lock
				// TTL (default 30 min) would reclaim a healthy long turn.
				onTick: () => touchLock(lockKey),
			});
		} catch (err) {
			if (err instanceof DaemonUnavailableError) {
				// Daemon went down mid-turn: leave the turn re-attachable, don't fail it.
				turnMeta.state = "sent";
				turnMeta.attempts = Math.max(0, turnMeta.attempts - 1);
				writeTurnMeta(sessionId, phaseKey, turnMeta);
				writer.status = "interrupted";
				writeWriterState(sessionId, writer);
				return daemonDownResult(phaseKey, turn, err.message);
			}
			throw err;
		}
		touchLock(lockKey);
		nudgeFile = null;

		// `onSessionCreated` already persisted a freshly-minted id before the wait;
		// this is a belt-and-suspenders sync for any path that didn't (a no-op on
		// the send path, where the id was already known).
		if (result.kteamSessionId !== writer.kteamSessionId) {
			writer.kteamSessionId = result.kteamSessionId;
			writeWriterState(sessionId, writer);
		}
		turnMeta.kteamSessionId = result.kteamSessionId;

		if (result.outcome === "done") {
			const raw = readTurnReplyRaw(sessionId, phaseKey, turn);
			const check = validateEnvelope({
				raw,
				sessionId,
				kind,
				epoch,
				repo,
				workingVersion,
			});
			// Best-effort "revised:false must be untouched": compare the working
			// artifact's hash against what it was at compose time (single-file kinds).
			if (
				check.ok &&
				check.envelope &&
				!check.envelope.artifact.revised &&
				turnMeta.artifactHashAtSend &&
				hashWorkingArtifact(sessionId, kind, epoch, workingVersion) !==
					turnMeta.artifactHashAtSend
			) {
				check.ok = false;
				check.errors.push(
					`artifact.revised is false but the working version changed on disk — either set revised: true (and generate the visual) or revert your edits`,
				);
			}
			if (check.ok && check.envelope) {
				return acceptTurn({
					sessionId,
					config,
					kind,
					epoch,
					repo,
					phaseKey,
					turn,
					envelope: check.envelope,
					writer,
					turnMeta,
				});
			}
			// Invalid → corrective retry in the SAME kteam session (a `send`).
			turnMeta.state = "invalid";
			writeTurnMeta(sessionId, phaseKey, turnMeta);
			relayEvent(sessionId, "relay:invalid", phaseKey, turn, {
				errors: check.errors,
			});
			nudgeFile = writeNudge(
				paths.dir,
				attempt + 1,
				`Your reply.json for turn ${turn} failed validation:\n${check.errors
					.map((e) => `- ${e}`)
					.join(
						"\n",
					)}\nFix the problems, then re-write ${paths.reply} (atomically) as your last action.`,
			);
			continue;
		}

		// needs_attention / failed / timeout — persist the snapshot + classify.
		if (result.snapshot) turnMeta.snapshot = result.snapshot;
		writeTurnMeta(sessionId, phaseKey, turnMeta);
		// kteam owns crash recovery + account failover, so these are transient from
		// the relay's view: nudge + re-send (auto-revives a finished session), up to
		// the retry budget.
		const why =
			result.outcome === "timeout"
				? "timed out"
				: result.outcome === "failed"
					? `ended without an envelope (kteam status: ${result.status ?? "unknown"})`
					: `handed control back without an envelope (kteam status: ${result.status ?? "unknown"})`;
		nudgeFile = writeNudge(
			paths.dir,
			attempt + 1,
			`Your previous attempt at turn ${turn} ${why}. Re-read ${paths.message}, finish the turn, then write ${paths.reply} (atomically) as your last action.`,
		);
	}

	return failTurn(sessionId, phaseKey, turn, turnMeta, writer, {
		error: `turn ${turn} failed after ${maxAttempts} attempts`,
		kteamSession: writer.kteamSessionId,
		config,
	});
}

/** Corrective/nudge messages ride in a small addendum file, delivered via
 *  `kteam send`; the writer still has the full message.md in its context. */
function writeNudge(dir: string, attempt: number, text: string): string {
	const file = join(dir, `addendum-a${attempt}.md`);
	writeFileSync(file, text);
	return file;
}

/** SHA-256 of the working artifact (single-file kinds; "" for plans/missing) —
 *  the best-effort `revised:false` untouched check. */
function hashWorkingArtifact(
	sessionId: string,
	kind: ArtifactKind,
	epoch: number,
	version: number,
): string {
	if (kind === "plans") return ""; // plan sets: skip (per-plan hashing is v2)
	const path = revisionPath(
		sessionId,
		kind,
		version,
		kind === "brainstorm" ? {} : { epoch },
	);
	try {
		return existsSync(path) ? hashMessage(readFileSync(path, "utf-8")) : "";
	} catch {
		return "";
	}
}

// ============================================================================
// stop/delete + discussion surfaces
// ============================================================================

/** Stop every live writer kteam session for a kautopilot session (stop/delete),
 *  found by its ownership label. */
export async function killWriterSessions(
	sessionId: string,
	harness: WriterKteam = new WriterKteam(),
): Promise<number> {
	return harness.stopByLabel(writerLabel(sessionId));
}

/** Mark running writers interrupted (stop — re-attachable, NOT terminal). */
export function markWritersInterrupted(sessionId: string): void {
	for (const phase of listPhases(sessionId)) {
		const w = readWriterState(sessionId, phase);
		if (w && w.status === "running") {
			w.status = "interrupted";
			writeWriterState(sessionId, w);
		}
	}
}

export interface DiscussionTurn {
	turn: number;
	state: string;
	sentAt?: string;
	repliedAt?: string;
	attempts: number;
	elapsedMs: number | null;
	lastProgress: string | null;
	/** The kteam session that ran this turn (the watch handle). */
	kteamSessionId?: string;
	/** The user's raw message for this turn (the chat timeline's user bubble). */
	userMessage: string | null;
	approval: boolean;
	envelope: unknown | null;
}

export interface Discussion {
	phaseKey: string;
	writer: WriterState | null;
	turns: DiscussionTurn[];
}

/** Read the discussion (turn list) for a phase — the capture surface. */
export function readDiscussion(
	sessionId: string,
	phaseKey: string,
): Discussion {
	const writer = readWriterState(sessionId, phaseKey);
	const turns: DiscussionTurn[] = [];
	for (const t of listTurns(sessionId, phaseKey)) {
		const meta = readTurnMeta(sessionId, phaseKey, t);
		const accepted = meta?.accepted ?? false;
		// A turn whose reply.json is present but meta hasn't caught up is still
		// in-progress from the reader's perspective — only accepted turns expose
		// their (validated + enriched) envelope.
		turns.push({
			turn: t,
			state: meta?.state ?? "sent",
			sentAt: meta?.sentAt,
			repliedAt: meta?.repliedAt,
			attempts: meta?.attempts ?? 0,
			elapsedMs: meta?.sentAt
				? (meta.repliedAt ? new Date(meta.repliedAt).getTime() : Date.now()) -
					new Date(meta.sentAt).getTime()
				: null,
			lastProgress: lastProgress(sessionId, phaseKey, t),
			kteamSessionId: meta?.kteamSessionId,
			userMessage: meta?.userMessage ?? null,
			approval: meta?.approval ?? false,
			envelope: accepted ? readTurnReplyRaw(sessionId, phaseKey, t) : null,
		});
	}
	return { phaseKey, writer, turns };
}

/** Phases with a writer session, most-recently-updated LAST (so callers taking
 *  the last entry get the active phase, not alphabetical accident). */
export function discussionPhases(sessionId: string): string[] {
	return listPhases(sessionId)
		.map((phase) => ({
			phase,
			at: readWriterState(sessionId, phase)?.updatedAt ?? "",
		}))
		.sort((a, b) => a.at.localeCompare(b.at))
		.map((p) => p.phase);
}

/** Whether reply.json (the completion marker) is present + readable for a turn. */
function turnFinishedOnDisk(
	sessionId: string,
	phaseKey: string,
	turn: number,
): boolean {
	return (
		replyExists(sessionId, phaseKey, turn) &&
		readTurnReplyRaw(sessionId, phaseKey, turn) != null
	);
}
