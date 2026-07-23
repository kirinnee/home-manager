import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readSessionMeta } from "../core/session-meta";
import {
	getSessionDetail,
	listSessionIds,
	type SessionDetail,
	type SessionSummary,
	storeRoot,
	summarize,
} from "./data";

// ============================================================================
// mtime-keyed store cache + async I/O for the `serve` hot paths.
//
// The legacy data layer re-read + re-parsed every session's session.json,
// log.jsonl and status.yaml on EVERY /api/sessions request (a full-store walk),
// and re-walked every artifact tree on EVERY SSE poll (once/sec PER connected
// client) — all synchronous, blocking the event loop. This module fixes both:
//
//  1. Async I/O (node:fs/promises) so the walk never blocks the event loop.
//  2. A per-session mtime key (session.json + log.jsonl) memoizes the expensive
//     summary/detail computation; a session that hasn't changed on disk is
//     served from cache without re-reading or replaying its WAL.
//  3. A single shared, throttled fingerprint so N SSE clients cause ONE walk per
//     interval, not N.
// ============================================================================

async function mtimeMs(path: string): Promise<number> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return 0;
	}
}

/** The inputs a session's summary derives from. status.yaml is a derived cache
 *  (rewritten by ensureStatus) so it is deliberately NOT part of the key —
 *  keying on it would churn the cache on the very first read. */
async function summaryKey(dir: string): Promise<string> {
	const [meta, log] = await Promise.all([
		mtimeMs(join(dir, "session.json")),
		mtimeMs(join(dir, "log.jsonl")),
	]);
	return `${meta}:${log}`;
}

/**
 * Detail additionally depends on the artifact trees. It must key on the
 * RECURSIVE max mtime of the epoch/brainstorm trees, not the shallow root-dir
 * mtimes: writing a NEW nested revision (e.g. `epoch/1/spec/v2.md`) bumps the
 * `epoch/1/spec` dir, not the `epoch` root, so a shallow key would serve the
 * stale revision list after the SSE-triggered refetch. `walkMax` catches both
 * new versions (dir mtime) and in-place edits (file mtime).
 */
async function detailKey(dir: string): Promise<string> {
	const [base, epoch, brainstorm, orch] = await Promise.all([
		summaryKey(dir),
		walkMax(join(dir, "epoch")),
		walkMax(join(dir, "brainstorm")),
		mtimeMs(join(dir, "orchestration.yaml")),
	]);
	return `${base}:${epoch}:${brainstorm}:${orch}`;
}

const summaryCache = new Map<string, { key: string; value: SessionSummary }>();
const detailCache = new Map<string, { key: string; value: SessionDetail }>();

/** Async, per-session-mtime-cached session index. On a cache hit a session
 *  costs two stats instead of a full meta+WAL read/replay. */
export async function listSessionSummariesCached(): Promise<SessionSummary[]> {
	const root = storeRoot();
	const ids = listSessionIds();
	const out = await Promise.all(
		ids.map(async (id) => {
			const dir = join(root, id);
			const key = await summaryKey(dir);
			const hit = summaryCache.get(id);
			if (hit && hit.key === key) return hit.value;
			const meta = readSessionMeta(id);
			if (!meta) return null;
			const value = summarize(id, meta);
			summaryCache.set(id, { key, value });
			return value;
		}),
	);
	// Drop cache entries for sessions that disappeared.
	const live = new Set(ids);
	for (const id of summaryCache.keys())
		if (!live.has(id)) summaryCache.delete(id);
	return out.filter((s): s is SessionSummary => s !== null);
}

/** Async, mtime-cached full session detail. */
export async function getSessionDetailCached(
	id: string,
): Promise<SessionDetail | null> {
	const dir = join(storeRoot(), id);
	const key = await detailKey(dir);
	const hit = detailCache.get(id);
	if (hit && hit.key === key) return hit.value;
	const value = getSessionDetail(id);
	if (value) detailCache.set(id, { key, value });
	else detailCache.delete(id);
	return value;
}

// ── shared, throttled live-reload fingerprint ──────────────────────────────

/** Async recursive max-mtime walk of one path (dir mtimes catch adds/removes;
 *  file mtimes catch in-place edits). */
async function walkMax(path: string): Promise<number> {
	let max = 0;
	let st: Awaited<ReturnType<typeof stat>>;
	try {
		st = await stat(path);
	} catch {
		return 0;
	}
	if (st.mtimeMs > max) max = st.mtimeMs;
	if (!st.isDirectory()) return max;
	let entries: string[];
	try {
		entries = await readdir(path);
	} catch {
		return max;
	}
	const kids = await Promise.all(entries.map((e) => walkMax(join(path, e))));
	for (const k of kids) if (k > max) max = k;
	return max;
}

/** Full-store fingerprint (async). Same change-detection semantics as the
 *  legacy sync walk: max mtime over the root, each session's log.jsonl +
 *  session.json, and the brainstorm/epoch artifact trees. */
export async function storeFingerprintAsync(): Promise<number> {
	const root = storeRoot();
	let max = await mtimeMs(root);
	if (max === 0) {
		// root may still exist with mtime 0 in exotic FS; fall through to sessions
	}
	const ids = listSessionIds();
	const perSession = await Promise.all(
		ids.map(async (id) => {
			const dir = join(root, id);
			const [log, meta, brainstorm, epoch] = await Promise.all([
				mtimeMs(join(dir, "log.jsonl")),
				mtimeMs(join(dir, "session.json")),
				walkMax(join(dir, "brainstorm")),
				walkMax(join(dir, "epoch")),
			]);
			return Math.max(log, meta, brainstorm, epoch);
		}),
	);
	for (const m of perSession) if (m > max) max = m;
	return max;
}

const THROTTLE_MS = 750;
let fpValue = 0;
let fpAt = 0;
let fpInFlight: Promise<number> | null = null;

/**
 * Shared, throttled fingerprint. Many SSE clients poll ~1/s; this collapses
 * them to at most one walk per THROTTLE_MS. Returns the last computed value
 * immediately when fresh; otherwise recomputes (deduping concurrent callers).
 */
export async function getStoreFingerprint(now: number): Promise<number> {
	if (now - fpAt < THROTTLE_MS) return fpValue;
	if (fpInFlight) return fpInFlight;
	fpInFlight = storeFingerprintAsync()
		.then((v) => {
			fpValue = v;
			fpAt = now;
			return v;
		})
		.finally(() => {
			fpInFlight = null;
		});
	return fpInFlight;
}

/** Test/util hook: clear all memoized state. */
export function clearStoreCache(): void {
	summaryCache.clear();
	detailCache.clear();
	fpValue = 0;
	fpAt = 0;
}
