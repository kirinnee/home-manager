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
//     writer.json                     — pinned account + harness session id + status
//     turn-000N/{message.md, reply.json, meta.json, progress.log, done}
// All JSON writes are temp-file + rename (atomic) — the dashboard/`discussion`
// read them live.
// ============================================================================

export type WriterStatus = "idle" | "running" | "interrupted" | "failed";

export interface WriterState {
	phaseKey: string;
	/** Concrete claude wrapper binary — pinned at turn 1 (resume requires it). */
	account: string;
	/** Harness session uuid minted by kautopilot; --session-id then --resume. */
	harnessSessionId: string;
	/** Where the writer TUI is launched (session.json.folder — the hub dir). */
	cwd: string;
	status: WriterStatus;
	/** Last completed (accepted) turn. */
	turns: number;
	/** True once the harness conversation is known to exist (first attempt got
	 *  past input delivery) — the launch flag switch: false → `--session-id`,
	 *  true → `--resume`. */
	started: boolean;
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
	tmuxSession?: string;
	/** Pane scrollback captured on failure (diagnostic). */
	paneSnapshot?: string;
	/** True once the reply passed validation AND enrichment/bookkeeping ran. */
	accepted?: boolean;
}

/** phaseKey → a tmux-/filesystem-safe slug. */
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
		sentinel: join(dir, "done"),
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

function writerJsonPath(sessionId: string, phaseKey: string): string {
	return join(phaseDir(sessionId, phaseKey), "writer.json");
}

export function readWriterState(
	sessionId: string,
	phaseKey: string,
): WriterState | null {
	return readJson<WriterState>(writerJsonPath(sessionId, phaseKey));
}

export function writeWriterState(sessionId: string, state: WriterState): void {
	mkdirSync(phaseDir(sessionId, state.phaseKey), { recursive: true });
	writeJsonAtomic(writerJsonPath(sessionId, state.phaseKey), {
		...state,
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

/** Unlink a turn's sentinel — REQUIRED before every (re)spawn: a stale marker
 *  from a prior attempt must never read as this attempt's completion. */
export function clearSentinel(
	sessionId: string,
	phaseKey: string,
	turn: number,
): void {
	try {
		unlinkSync(turnPaths(sessionId, phaseKey, turn).sentinel);
	} catch {
		// absent is fine
	}
}

export function sentinelExists(
	sessionId: string,
	phaseKey: string,
	turn: number,
): boolean {
	return existsSync(turnPaths(sessionId, phaseKey, turn).sentinel);
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
