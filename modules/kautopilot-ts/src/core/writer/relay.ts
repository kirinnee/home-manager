import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { plansRepoDir, revisionPath } from "../revisions";
import {
	readSessionMeta,
	type SessionMeta,
	updateSessionMeta,
} from "../session-meta";
import type { Config, EnrichedEnvelope, Envelope } from "../types";
import { validateEnvelope } from "./envelope";
import { stepExecution } from "./mode";
import { hasAlternative, pickAccount } from "./pool";
import {
	clearSentinel,
	hashMessage,
	lastProgress,
	lastTurn,
	listPhases,
	listTurns,
	phaseKeySafe,
	readTurnMessage,
	readTurnMeta,
	readTurnReplyRaw,
	readWriterState,
	sentinelExists,
	type TurnMeta,
	turnPaths,
	type WriterState,
	writeTurnMessage,
	writeTurnMeta,
	writeTurnReply,
	writeWriterState,
} from "./scratch";
import { WriterTmux, writerTmuxName, writerTmuxPrefix } from "./tmux";

// ============================================================================
// The relay turn engine: one `kautopilot relay` call = one writer-session turn.
// Recovery matrix, version prep (binary-minted), tmux spawn (+ corrective
// retries in the same conversation), envelope validation, enrichment, WAL.
// (specs/deferred-writer-relay.md §4)
// ============================================================================

export interface RelayResult {
	ok: boolean;
	error?: string;
	envelope?: EnrichedEnvelope;
	phaseKey?: string;
	turn?: number;
	tmuxSession?: string;
	paneSnapshotPath?: string;
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

Write \`{replyPath}\` as JSON matching EXACTLY this shape, then \`touch {sentinelPath}\`
as your VERY LAST action (the relay only reads the reply after the sentinel appears):

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
	sentinelPath: string;
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
 * entirely (no phantom trailing versions at phase end).
 * `fullContract` forces turn-1-style assembly (rebootstrap) without re-minting
 * (pass `fixedWorkingVersion`) and without the turn-1 kickoff framing.
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
	fullContract?: boolean;
	fixedWorkingVersion?: number;
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
	const turnOneStyle = turn === 1 || (params.fullContract ?? false);

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

	// 2. Version prep — AFTER prepare; skipped on approval turns; pinned when the
	// caller already knows the version (rebootstrap re-compose must not re-mint).
	let workingVersion: number;
	let workingPath: string | null = null;
	if (params.fixedWorkingVersion != null) {
		workingVersion = params.fixedWorkingVersion;
		if (!approval) {
			workingPath =
				kind === "plans"
					? plansRepoDir(sessionId, epoch, repo ?? "default")
					: revisionPath(
							sessionId,
							kind,
							workingVersion,
							kind === "brainstorm" ? {} : { epoch },
						);
		}
	} else if (approval) {
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
			sentinelPath: paths.sentinel,
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
	} else if (turn === 1 && !params.fullContract) {
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
	params: { error: string; tmuxSession?: string; config: Config },
): RelayResult {
	turnMeta.state = "failed";
	writeTurnMeta(sessionId, phaseKey, turnMeta);
	writer.status = "failed";
	writeWriterState(sessionId, writer);
	relayEvent(sessionId, "relay:failed", phaseKey, turn, {
		error: params.error,
	});
	const remediation = [
		"Re-run `kautopilot relay` with no message to re-attach (cheapest — e.g. after a rate-limit window resets).",
	];
	remediation.push(
		hasAlternative(params.config.writer.pool, writer.account)
			? "If the harness conversation itself is lost, an automatic rebootstrap onto another pool account runs on the next re-attach."
			: "The pool has no alternative account — waiting is the only automatic recovery.",
	);
	remediation.push(
		"`kautopilot relay --fallback-inline` flips the REST of the session to inline. ⚠️ That runs the full writer workload (prompt + reviewers + visuals) in the MAIN session/account and cannot be undone this session — confirm with the user first.",
	);
	return {
		ok: false,
		error: params.error,
		phaseKey,
		turn,
		tmuxSession: params.tmuxSession,
		paneSnapshotPath: turnMeta.paneSnapshot
			? turnPaths(sessionId, phaseKey, turn).meta
			: undefined,
		remediation,
	};
}

// --- rebootstrap ------------------------------------------------------------------

/** Rebootstrap catch-up: the last 3 turns' summaries, plus open questions/items
 *  from EVERY prior turn (an early unresolved question must survive). */
function buildCatchUp(
	sessionId: string,
	phaseKey: string,
	turn: number,
): string {
	const lines: string[] = [];
	for (let t = 1; t < turn; t++) {
		const raw = readTurnReplyRaw(
			sessionId,
			phaseKey,
			t,
		) as Partial<EnrichedEnvelope> | null;
		if (!raw?.summary) continue;
		if (t >= turn - 3) lines.push(`- turn ${t}: ${raw.summary}`);
		for (const q of raw.questions ?? [])
			lines.push(`  - open question (turn ${t}): ${q.text}`);
		for (const o of raw.openItems ?? [])
			lines.push(`  - open item (turn ${t}): ${o}`);
	}
	return lines.length
		? `Prior discussion (last turns):\n${lines.join("\n")}\n`
		: "";
}

/**
 * The harness home lost the conversation: mint a new uuid, re-pick the account
 * (excluding the failed one when alternatives exist — a lost HOME on the same
 * account is still re-bootstrappable, so a single-account pool retries itself),
 * and rewrite THIS turn's message as a full turn-1-style contract + catch-up.
 * Turn numbering continues in the same scratch dir.
 */
async function rebootstrap(params: {
	sessionId: string;
	meta: SessionMeta;
	config: Config;
	step: string;
	kind: ArtifactKind;
	epoch: number;
	repo: string | null;
	phaseKey: string;
	turn: number;
	paths: ReturnType<typeof turnPaths>;
	writer: WriterState;
	userMessage: string;
	approval: boolean;
	workingVersion: number;
}): Promise<WriterState> {
	const {
		sessionId,
		meta,
		config,
		step,
		kind,
		epoch,
		repo,
		phaseKey,
		turn,
		paths,
		writer,
		userMessage,
		approval,
	} = params;
	const account = pickAccount(config.writer.pool, [writer.account]);
	const next: WriterState = {
		...writer,
		account,
		harnessSessionId: randomUUID(),
		status: "idle",
		started: false,
	};
	writeWriterState(sessionId, next);
	// Full turn-1-style message (contract + prompt + review + brief) + catch-up.
	// The working version is PINNED to what this turn already handed out — a
	// rebootstrap must never re-mint (the crashed turn's version may already be
	// presented, and a re-derive would copy it forward).
	const { message } = await composeMessage({
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
		fullContract: true,
		fixedWorkingVersion: params.workingVersion,
	});
	const catchUp = buildCatchUp(sessionId, phaseKey, turn);
	writeTurnMessage(
		sessionId,
		phaseKey,
		turn,
		`${message}\n\n---\n\n## REBOOTSTRAP\n\nYour previous conversation was lost — you are a FRESH session continuing this phase mid-flight (this is turn ${turn}).\n${catchUp}Continue from the artifact as it exists on disk. Finish turn ${turn}: write ${paths.reply}, then touch ${paths.sentinel}.`,
	);
	relayEvent(sessionId, "relay:rebootstrap", phaseKey, turn, {
		from: writer.account,
		to: account,
	});
	return next;
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
		tmux?: WriterTmux;
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
	const tmux = opts.tmux ?? new WriterTmux();
	const lockKey = scopeLockKey(sessionId, null);
	const msg = opts.message?.trim() ?? "";
	const msgHash = msg ? hashMessage(msg) : null;

	// --- writer session (pin the account at phase start) -------------------------
	let writer = readWriterState(sessionId, phaseKey);
	if (!writer) {
		writer = {
			phaseKey,
			account: pickAccount(config.writer.pool),
			harnessSessionId: randomUUID(),
			cwd: meta.folder,
			status: "idle",
			turns: 0,
			started: false,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeWriterState(sessionId, writer);
	}

	// --- recovery matrix (spec §4.3) ----------------------------------------------
	const last = lastTurn(sessionId, phaseKey);
	const lastMeta = last > 0 ? readTurnMeta(sessionId, phaseKey, last) : null;

	if (lastMeta) {
		// (0) Orphaned-but-alive tmux from a killed controller: /exit it gracefully
		// (lets the harness persist the conversation), then kill — a finished
		// writer left it idle; a half-done one gets re-attached with a fresh spawn
		// below, and two processes must never share the session.
		if (
			lastMeta.tmuxSession &&
			!lastMeta.accepted &&
			(await tmux.isSessionAlive(lastMeta.tmuxSession))
		) {
			await tmux.gracefulClose(lastMeta.tmuxSession);
		}
		// Accepted reply + no message OR the same user message (retry after the
		// envelope printed but before the skill recorded it) → return idempotently.
		// Hashes compare RAW user messages (userMessageHash), like for like. An
		// --approval invocation is a NEW turn even without a message — never
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
			// Stored in full: recovery recompose + rebootstrap rebuild the turn from
			// this copy (message.md may not exist yet on a mid-compose crash).
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

	// --- spawn / retry loop ----------------------------------------------------------
	const maxAttempts = 1 + config.writer.maxTurnRetries;
	let nudgeFile: string | null = null;
	if (reattach) {
		// ADOPTION fast-path: the writer finished (sentinel + reply on disk) while
		// the controller was dead — accept from disk without respawning. Acceptance
		// is idempotently re-runnable (markPresented skips when already marked), so
		// a crash between validation and enrichment lands here too.
		if (turnFinishedOnDisk(sessionId, phaseKey, turn)) {
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
			// Invalid on disk → fall through to a corrective respawn.
		}
		nudgeFile = writeNudge(
			paths.dir,
			turnMeta.attempts + 1,
			`You were sent turn ${turn} at ${turnMeta.sentAt} but the controller lost track of you. Re-read ${paths.message}, finish the turn, write ${paths.reply}, then touch ${paths.sentinel}.`,
		);
	}
	let resumeLossStreak = 0;

	while (turnMeta.attempts < maxAttempts) {
		turnMeta.attempts++;
		const attempt = turnMeta.attempts;
		const tmuxName = writerTmuxName(
			sessionId,
			phaseKeySafe(phaseKey),
			turn,
			attempt,
		);
		turnMeta.tmuxSession = tmuxName;
		turnMeta.state = "running";
		writeTurnMeta(sessionId, phaseKey, turnMeta);
		writer.status = "running";
		writeWriterState(sessionId, writer);
		// Spawn notice on stderr (stdout stays pure JSON): the live-watch line the
		// skill relays to the user.
		process.stderr.write(
			`writer turn ${turn} (attempt ${attempt}) on ${writer.account} — watch live: tmux attach -r -t ${tmuxName}\n`,
		);

		// Stale-marker hazard: a sentinel from a prior attempt must never read as
		// this attempt's completion.
		clearSentinel(sessionId, phaseKey, turn);

		touchLock(lockKey);
		const result = await tmux.runTurn({
			sessionName: tmuxName,
			binary: writer.account,
			harnessSessionId: writer.harnessSessionId,
			resume: writer.started,
			cwd: writer.cwd,
			messageFile: nudgeFile ?? paths.message,
			sentinelFile: paths.sentinel,
			timeoutMins: config.writer.turnTimeoutMins,
			// Heartbeat during the (possibly 30-min) sentinel wait — without it
			// the lock TTL (default 30 min) would reclaim a healthy long turn.
			onTick: () => touchLock(lockKey),
		});
		touchLock(lockKey);
		nudgeFile = null;

		if (result.delivered && !writer.started) {
			writer.started = true;
			writeWriterState(sessionId, writer);
		}

		// A `--session-id` launch that finds the conversation already exists (the
		// controller was killed mid-turn-1 AFTER delivery but before `started` was
		// persisted): flip to resume mode and retry — the conversation is real.
		if (result.outcome === "fatal" && result.fatalKind === "session_exists") {
			if (!writer.started) {
				writer.started = true;
				writeWriterState(sessionId, writer);
				continue;
			}
			// Already resuming and still "in use"? — treat as a died attempt.
			nudgeFile = writeNudge(
				paths.dir,
				attempt + 1,
				`Your previous attempt at turn ${turn} could not launch (session busy). Re-read ${paths.message}, finish the turn, write ${paths.reply}, then touch ${paths.sentinel}.`,
			);
			continue;
		}

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
			// Invalid → corrective retry in the same conversation.
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
					)}\nFix the problems, re-write ${paths.reply}, then touch ${paths.sentinel} again.`,
			);
			continue;
		}

		// died / timeout / fatal — persist the pane and classify.
		if (result.pane) turnMeta.paneSnapshot = result.pane;
		writeTurnMeta(sessionId, phaseKey, turnMeta);

		if (result.outcome === "fatal" && result.fatalKind === "resume_lost") {
			resumeLossStreak++;
			if (resumeLossStreak >= 2 || !writer.started) {
				writer = await rebootstrap({
					sessionId,
					meta,
					config,
					step,
					kind,
					epoch,
					repo,
					phaseKey,
					turn,
					paths,
					writer,
					userMessage: turnMeta.userMessage ?? msg,
					approval,
					workingVersion,
				});
				resumeLossStreak = 0;
				continue;
			}
			// One-off resume glitch: retry the same conversation once first.
			continue;
		}
		if (result.outcome === "fatal") {
			return failTurn(sessionId, phaseKey, turn, turnMeta, writer, {
				error: `writer session hit a fatal ${result.fatalKind} error — see the pane snapshot in meta.json`,
				tmuxSession: tmuxName,
				config,
			});
		}
		// died / timeout → nudge + retry (same conversation).
		nudgeFile = writeNudge(
			paths.dir,
			attempt + 1,
			`Your previous attempt at turn ${turn} ${result.outcome === "timeout" ? "timed out" : "exited early"}. Re-read ${paths.message}, finish the turn, write ${paths.reply}, then touch ${paths.sentinel}.`,
		);
	}

	return failTurn(sessionId, phaseKey, turn, turnMeta, writer, {
		error: `turn ${turn} failed after ${maxAttempts} attempts`,
		tmuxSession: turnMeta.tmuxSession,
		config,
	});
}

/** Corrective/nudge messages ride in a small addendum file (the bootstrap line
 *  points the writer at it instead of the full message.md). */
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

/** Kill every writer tmux session for a kautopilot session (stop/delete). */
export async function killWriterSessions(
	sessionId: string,
	tmux: WriterTmux = new WriterTmux(),
): Promise<number> {
	return tmux.killSessionsWithPrefix(writerTmuxPrefix(sessionId));
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
	tmuxSession?: string;
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
		// A turn whose sentinel is present but meta hasn't caught up is still
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
			tmuxSession: meta?.tmuxSession,
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

/** Whether a sentinel/tmux adoption is possible — used by tests. */
function turnFinishedOnDisk(
	sessionId: string,
	phaseKey: string,
	turn: number,
): boolean {
	return (
		sentinelExists(sessionId, phaseKey, turn) &&
		readTurnReplyRaw(sessionId, phaseKey, turn) != null
	);
}
