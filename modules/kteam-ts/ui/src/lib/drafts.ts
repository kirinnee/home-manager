// Per-session composer draft persistence — the SOLE owner of the
// `kteam-drafts-v1` localStorage key.
//
// This codebase keeps ONE owner per storage key (`kteam-theme`,
// `kteam-ui-controls-v1`); this is drafts' key and nothing else writes it.
//
// WHY THIS IS NOT A PLAIN `localStorage.setItem(sessionId, text)`:
//   - This fleet has 1000+ sessions. An unbounded map of drafts eventually
//     throws QuotaExceededError, so the store is LRU-capped by last-touched
//     (`at`) and every draft has a hard length cap.
//   - Empty/whitespace drafts are never stored — they waste a slot and a quota.
//   - A malformed payload must degrade to "no drafts", never throw at import
//     time, so parsing is fully defensive.
//   - A write failure must NEVER break sending: every write is wrapped, and a
//     quota failure retries once against an aggressively pruned store before
//     giving up silently.
//   - It is VERSIONED. A future shape change bumps the version and the old
//     payload is discarded (a clean migration point) rather than crashing on a
//     shape it does not understand.
//
// ATTACHMENTS ARE DELIBERATELY NOT PERSISTED. Only the text draft survives a
// reload; pending image uploads are page-owned object URLs that cannot be
// rehydrated, so persisting them would imply an attachment survived when it did
// not. The composer restores text only.

export const DRAFTS_KEY = 'kteam-drafts-v1';
export const DRAFTS_VERSION = 1;
/** LRU cap: at most this many sessions retain a draft, newest-touched kept. */
export const MAX_DRAFTS = 50;
/** Per-draft hard cap. Real chat drafts are far under this; a pathological
 *  paste is refused rather than truncated, so a restore returns exactly what
 *  was saved or nothing — never a silently shortened message. */
export const MAX_DRAFT_LEN = 16_000;

export interface DraftEntry {
  text: string;
  /** Epoch ms of the last touch; the LRU sort key. */
  at: number;
}

export interface DraftStore {
  v: number;
  drafts: Record<string, DraftEntry>;
}

export function emptyStore(): DraftStore {
  return { v: DRAFTS_VERSION, drafts: {} };
}

/** Defensive parse: any malformed, wrong-version, or non-conforming payload
 *  degrades to an empty store. Never throws. */
export function parseDraftStore(raw: string | null): DraftStore {
  if (!raw) return emptyStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStore();
  }
  if (!parsed || typeof parsed !== 'object') return emptyStore();
  const obj = parsed as Record<string, unknown>;
  // Version mismatch is a migration point: discard rather than risk reading a
  // shape this build does not understand.
  if (obj['v'] !== DRAFTS_VERSION) return emptyStore();
  const draftsRaw = obj['drafts'];
  if (!draftsRaw || typeof draftsRaw !== 'object') return emptyStore();

  const drafts: Record<string, DraftEntry> = {};
  for (const [key, value] of Object.entries(draftsRaw as Record<string, unknown>)) {
    if (!key || !value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const text = entry['text'];
    const at = entry['at'];
    if (typeof text !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) continue;
    // Never resurrect an empty/whitespace draft even if one slipped onto disk.
    if (text.trim().length === 0) continue;
    drafts[key] = { text, at };
  }
  return { v: DRAFTS_VERSION, drafts };
}

/** Keep only the `max` most-recently-touched drafts. */
export function evictLru(store: DraftStore, max = MAX_DRAFTS): DraftStore {
  const keys = Object.keys(store.drafts);
  if (keys.length <= max) return store;
  const kept = keys.sort((a, b) => (store.drafts[b]?.at ?? 0) - (store.drafts[a]?.at ?? 0)).slice(0, max);
  const drafts: Record<string, DraftEntry> = {};
  for (const key of kept) {
    const entry = store.drafts[key];
    if (entry) drafts[key] = entry;
  }
  return { v: DRAFTS_VERSION, drafts };
}

/** Pure upsert applying every retention rule:
 *   - empty/whitespace OR over the length cap → the session's draft is dropped
 *     (an oversized draft is refused, not truncated — see MAX_DRAFT_LEN);
 *   - otherwise the draft is stored with a fresh `at` and the store is
 *     LRU-capped. */
export function upsertDraft(store: DraftStore, sessionId: string, text: string, now: number): DraftStore {
  const drafts = { ...store.drafts };
  if (text.trim().length === 0 || text.length > MAX_DRAFT_LEN) {
    delete drafts[sessionId];
    return { v: DRAFTS_VERSION, drafts };
  }
  drafts[sessionId] = { text, at: now };
  return evictLru({ v: DRAFTS_VERSION, drafts });
}

/** Pure removal; returns the same reference when there was nothing to remove so
 *  callers can skip a needless write. */
export function removeDraft(store: DraftStore, sessionId: string): DraftStore {
  if (!(sessionId in store.drafts)) return store;
  const drafts = { ...store.drafts };
  delete drafts[sessionId];
  return { v: DRAFTS_VERSION, drafts };
}

function hasStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

function readStore(): DraftStore {
  if (!hasStorage()) return emptyStore();
  try {
    return parseDraftStore(localStorage.getItem(DRAFTS_KEY));
  } catch {
    return emptyStore();
  }
}

/** Write, swallowing every failure. A full quota retries once against a
 *  hard-pruned store; if even that fails we give up quietly — a failed draft
 *  save must never surface to, or block, the reader. */
function writeStore(store: DraftStore): void {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(store));
  } catch {
    try {
      const pruned = evictLru(store, Math.min(10, MAX_DRAFTS));
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(pruned));
    } catch {
      /* out of room and out of options: drop the draft rather than throw */
    }
  }
}

/** The saved text for a session, or '' when there is none. */
export function loadDraft(sessionId: string): string {
  if (!sessionId) return '';
  return readStore().drafts[sessionId]?.text ?? '';
}

/** Persist (or, for an empty/oversized draft, drop) a session's draft. */
export function saveDraft(sessionId: string, text: string, now: number = Date.now()): void {
  if (!sessionId) return;
  writeStore(upsertDraft(readStore(), sessionId, text, now));
}

/** Drop a session's draft. No-op (and no write) when there is nothing stored. */
export function clearDraft(sessionId: string): void {
  if (!sessionId) return;
  const store = readStore();
  const next = removeDraft(store, sessionId);
  if (next === store) return;
  writeStore(next);
}
