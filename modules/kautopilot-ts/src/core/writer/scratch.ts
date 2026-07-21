import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sessionDir } from "../artifacts";

// ============================================================================
// The deferred-writer scratch mailbox (specs/deferred-writer-relay.md §1):
//   ~/.kautopilot/<sessionId>/scratch/<phaseKey>/
//     writer.json                     — pinned account + kteam session id + status
//     turn-000N/{message.md, reply.json, meta.json, progress.log}
// All JSON writes are temp-file + rename (atomic) — the dashboard/`discussion`
// read them live. reply.json doubles as the turn's completion marker (kteam
// `wait --until-marker`), so there is no separate `done` sentinel.
// ============================================================================

export type WriterStatus = "idle" | "running" | "interrupted" | "failed";

/** On-disk writer.json schema version. 1 = the pre-kteam (tmux) harness era
 *  (`harnessSessionId` + `started`, no kteam session); 2 = the kteam harness.
 *  Stamped on every write so a legacy file is never silently misread as fresh.
 *  Module-private: callers ask via `isLegacyWriterState`, not the raw number. */
const WRITER_SCHEMA_VERSION = 2;

export interface WriterState {
	/** Schema version (see WRITER_SCHEMA_VERSION). Absent on tmux-era files. */
	schemaVersion?: number;
	phaseKey: string;
	/** Concrete claude wrapper binary — pinned at turn 1 (the pool is consulted
	 *  once per phase; kteam owns any later account failover). */
	account: string;
	/** The kteam session id for this phase — minted by `kteam start` on turn 1,
	 *  then `kteam send`-driven for every later turn. Undefined until turn 1
	 *  actually starts (the start-vs-send switch). */
	kteamSessionId?: string;
	/** Where the writer session runs (session.json.folder — the hub dir). */
	cwd: string;
	status: WriterStatus;
	/** Last completed (accepted) turn. */
	turns: number;
	createdAt: string;
	updatedAt: string;
}

export type TurnState = "sent" | "running" | "replied" | "invalid" | "failed";

export interface TurnMeta {
	turn: number;
	state: TurnState;
	sentAt: string;
	repliedAt?: string;
	attempts: number;
	/** SHA-256 of the RAW user message ("" when none) — idempotent re-invoke
	 *  detection compares like against like (never the composed message.md). */
	userMessageHash: string;
	/** The raw user message (truncated) — the discussion surface's user bubble. */
	userMessage?: string;
	/** Was this an approval (consistency) turn? Re-attach must not depend on the
	 *  current invocation's --approval flag. */
	approval?: boolean;
	/** The working version handed to the writer at compose time. Re-attach and
	 *  crash-recovery validate against THIS — never re-derive (a re-derive after
	 *  markPresented would mint a phantom version). */
	workingVersion: number;
	/** SHA-256 of the working artifact at compose time (single-file kinds) —
	 *  best-effort "revised:false must be untouched" check. */
	artifactHashAtSend?: string;
	/** The kteam session that ran this turn (for the discussion watch hint). */
	kteamSessionId?: string;
	/** kteam snapshot captured on failure (the diagnostic that replaced the old
	 *  tmux pane scrollback). */
	snapshot?: string;
	/** True once the reply passed validation AND enrichment/bookkeeping ran. */
	accepted?: boolean;
}

/** phaseKey → a filesystem-safe slug. */
export function phaseKeySafe(phaseKey: string): string {
	return phaseKey.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function phaseDir(sessionId: string, phaseKey: string): string {
	return join(sessionDir(sessionId), "scratch", phaseKeySafe(phaseKey));
}

function turnDir(sessionId: string, phaseKey: string, turn: number): string {
	return join(
		phaseDir(sessionId, phaseKey),
		`turn-${String(turn).padStart(4, "0")}`,
	);
}

export function turnPaths(sessionId: string, phaseKey: string, turn: number) {
	const dir = turnDir(sessionId, phaseKey, turn);
	return {
		dir,
		message: join(dir, "message.md"),
		reply: join(dir, "reply.json"),
		meta: join(dir, "meta.json"),
		progress: join(dir, "progress.log"),
	};
}

/** Atomic JSON write: temp-file + rename. */
function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

// --- writer.json --------------------------------------------------------------

export function writerJsonPath(sessionId: string, phaseKey: string): string {
	return join(phaseDir(sessionId, phaseKey), "writer.json");
}

export function readWriterState(
	sessionId: string,
	phaseKey: string,
): WriterState | null {
	return readJson<WriterState>(writerJsonPath(sessionId, phaseKey));
}

/**
 * True when a writer.json was written by the pre-kteam (tmux) harness: it lacks
 * the current `schemaVersion` AND carries a tmux-era field (`harnessSessionId`
 * or `started`) the kteam shape never writes. The relay uses this to REFUSE
 * starting a competing writer over an in-flight legacy session (which the new
 * label-based cleanup can't see or stop). A fresh kteam writer.json — even
 * before turn 1, when `kteamSessionId` is still absent — is never legacy: it
 * carries `schemaVersion`.
 */
export function isLegacyWriterState(state: WriterState | null): boolean {
	if (!state) return false;
	const raw = state as unknown as Record<string, unknown>;
	if (raw.schemaVersion === WRITER_SCHEMA_VERSION) return false;
	return "harnessSessionId" in raw || "started" in raw;
}

export function writeWriterState(sessionId: string, state: WriterState): void {
	mkdirSync(phaseDir(sessionId, state.phaseKey), { recursive: true });
	writeJsonAtomic(writerJsonPath(sessionId, state.phaseKey), {
		...state,
		schemaVersion: WRITER_SCHEMA_VERSION,
		updatedAt: new Date().toISOString(),
	});
}

// --- turn dirs -----------------------------------------------------------------

/** All turn numbers present on disk for a phase, ascending. */
export function listTurns(sessionId: string, phaseKey: string): number[] {
	const dir = phaseDir(sessionId, phaseKey);
	if (!existsSync(dir)) return [];
	const turns: number[] = [];
	for (const name of readdirSync(dir)) {
		const m = /^turn-(\d{4})$/.exec(name);
		if (m) turns.push(Number(m[1]));
	}
	return turns.sort((a, b) => a - b);
}

export function lastTurn(sessionId: string, phaseKey: string): number {
	const turns = listTurns(sessionId, phaseKey);
	return turns.length ? turns[turns.length - 1] : 0;
}

export function readTurnMeta(
	sessionId: string,
	phaseKey: string,
	turn: number,
): TurnMeta | null {
	return readJson<TurnMeta>(turnPaths(sessionId, phaseKey, turn).meta);
}

export function writeTurnMeta(
	sessionId: string,
	phaseKey: string,
	meta: TurnMeta,
): void {
	const paths = turnPaths(sessionId, phaseKey, meta.turn);
	mkdirSync(paths.dir, { recursive: true });
	writeJsonAtomic(paths.meta, meta);
}

/** Raw reply.json (unvalidated — callers validate). */
export function readTurnReplyRaw(
	sessionId: string,
	phaseKey: string,
	turn: number,
): unknown | null {
	return readJson<unknown>(turnPaths(sessionId, phaseKey, turn).reply);
}

export function writeTurnReply(
	sessionId: string,
	phaseKey: string,
	turn: number,
	value: unknown,
): void {
	writeJsonAtomic(turnPaths(sessionId, phaseKey, turn).reply, value);
}

export function writeTurnMessage(
	sessionId: string,
	phaseKey: string,
	turn: number,
	message: string,
): void {
	const paths = turnPaths(sessionId, phaseKey, turn);
	mkdirSync(paths.dir, { recursive: true });
	writeFileSync(paths.message, message);
}

export function readTurnMessage(
	sessionId: string,
	phaseKey: string,
	turn: number,
): string | null {
	const p = turnPaths(sessionId, phaseKey, turn).message;
	return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

/** Last line of a turn's progress.log, or null. */
export function lastProgress(
	sessionId: string,
	phaseKey: string,
	turn: number,
): string | null {
	const p = turnPaths(sessionId, phaseKey, turn).progress;
	if (!existsSync(p)) return null;
	const lines = readFileSync(p, "utf-8").trim().split("\n").filter(Boolean);
	return lines.length ? lines[lines.length - 1] : null;
}

/** Delete a turn's reply.json — REQUIRED before every (re)send: reply.json is
 *  the `kteam wait --until-marker` completion marker, so a stale one from a
 *  prior attempt must never read as this attempt's envelope. */
export function clearReply(
	sessionId: string,
	phaseKey: string,
	turn: number,
): void {
	try {
		unlinkSync(turnPaths(sessionId, phaseKey, turn).reply);
	} catch {
		// absent is fine
	}
}

export function replyExists(
	sessionId: string,
	phaseKey: string,
	turn: number,
): boolean {
	return existsSync(turnPaths(sessionId, phaseKey, turn).reply);
}

export function hashMessage(message: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(message);
	return hasher.digest("hex");
}

/** Every phaseKey with a scratch dir for this session. */
export function listPhases(sessionId: string): string[] {
	const dir = join(sessionDir(sessionId), "scratch");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) =>
		existsSync(join(dir, name, "writer.json")),
	);
}
