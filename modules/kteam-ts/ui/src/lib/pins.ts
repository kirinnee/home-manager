// Per-session PINS — the SOLE owner of the `kteam-pins-v1` localStorage key.
//
// This codebase keeps ONE owner per storage key (`kteam-theme`,
// `kteam-ui-controls-v1`, `kteam-drafts-v1`); this is pins' key and nothing else
// writes it. The discipline is copied verbatim from drafts.ts, for the same
// reasons:
//   - This fleet has 1000+ sessions. An unbounded map eventually throws
//     QuotaExceededError, so the store is LRU-capped by last-touched (`at`) over
//     sessions, and each session's pin list is hard-capped.
//   - A malformed payload must degrade to "no pins", never throw at import time,
//     so parsing is fully defensive, field by field.
//   - A write failure must NEVER surface to the reader: every write is wrapped,
//     and a quota failure retries once against a hard-pruned store before giving
//     up silently.
//   - It is VERSIONED. A future shape change bumps the version and the old
//     payload is discarded (a clean migration point) rather than crashing on a
//     shape it does not understand. THIS IS ALSO THE PHASE-2 UPGRADE SEAM: pin
//     ids are UUIDs and timestamps are epoch ms, so the daemon-backed store can
//     one-time import these and then bump the key.
//
// TWO PIN KINDS, ONE STORE (see pinning-design.md §1): a `message` pin
// references a transcript block by its content-derived id and carries a stored
// PREVIEW so it stays legible even when its target block is not in the loaded
// window; a `note` pin is free text (a PR link, a status-report link) the reader
// wants at hand. Both share the same lifetime (per session) and the same
// surface (the Pins sheet), so they share the same key and retention rules.
//
// PHASE 1 IS PER-BROWSER. localStorage does not follow the reader from phone to
// desktop; the sheet says so plainly (PinSheet.tsx). Daemon-backed cross-device
// sync is phase 2 and is deliberately NOT built here.

export const PINS_KEY = 'kteam-pins-v1';
export const PINS_VERSION = 1;
/** LRU cap: at most this many sessions retain pins, newest-touched kept. */
export const MAX_PIN_SESSIONS = 50;
/** A pin board, not a second transcript. Adding past the cap drops the OLDEST
 *  pin in that session (never refuses the new one — the reader's latest intent
 *  wins). */
export const MAX_PINS_PER_SESSION = 20;
/** Per-note hard cap. A note over this is REFUSED, never truncated — the reader
 *  must never get back a silently shortened link (drafts.ts:30-33 rationale). */
export const MAX_NOTE_LEN = 500;
/** Stored message-pin preview length. This is derived DISPLAY data, so
 *  truncation here is fine (unlike a note). */
export const PREVIEW_LEN = 200;

/** The transcript block kinds a pin can point at. Mirrors TranscriptBlock.kind
 *  without importing it, so this pure module stays free of the transcript. */
export type PinBlockKind = 'user' | 'assistant' | 'thinking' | 'tools' | 'system' | 'notice';

export interface MessagePin {
  id: string;
  kind: 'message';
  /** TranscriptBlock.id — content-derived, stable across re-reads for Claude
   *  sessions (harness recordUuid); see pinning-design.md §6 for the codex
   *  caveat and the honest not-found path that covers it. */
  blockId: string;
  blockKind: PinBlockKind;
  /** First PREVIEW_LEN chars of the block text AT PIN TIME. Stored, not derived
   *  at render — this is what keeps a pin legible when its target block is not
   *  loaded. */
  preview: string;
  /** The block's record timestamp, for display. */
  ts?: string;
  /** Epoch ms pinned. */
  at: number;
}

export interface NotePin {
  id: string;
  kind: 'note';
  /** <= MAX_NOTE_LEN; URLs auto-linked at render. */
  text: string;
  /** Epoch ms created; bumped on edit. */
  at: number;
  /** OPTIONAL PROVENANCE for a note that was PINNED FROM A SELECTION rather than
   *  typed. A selection pin is a note (free text = the highlighted snippet), not
   *  a message pin — it captures the exact words, and the words ARE the note. But
   *  it is cheap to also remember which transcript block the snippet came from
   *  (the row already carries `data-block-id`), so a sourced note can offer a
   *  "Jump to source" back into the conversation, reusing the message-pin jump
   *  bridge. Only `blockId` is stored — it is the single cheap fact available at
   *  capture time (block kind/timestamp are not exposed as DOM attributes), and
   *  it is enough for an exact-id, honest-not-found jump. Absent for a typed
   *  note. See pin-selection.ts. */
  source?: { blockId: string };
}

export type Pin = MessagePin | NotePin;

export interface PinSessionEntry {
  pins: Pin[];
  /** LRU touch — epoch ms of the last mutation to this session's pins. */
  at: number;
}

export interface PinStore {
  v: number;
  sessions: Record<string, PinSessionEntry>;
}

export function emptyStore(): PinStore {
  return { v: PINS_VERSION, sessions: {} };
}

function isBlockKind(v: unknown): v is PinBlockKind {
  return v === 'user' || v === 'assistant' || v === 'thinking' || v === 'tools' || v === 'system' || v === 'notice';
}

/** Defensive per-field parse of ONE pin. Returns null for anything malformed,
 *  so a single bad pin degrades to "that pin is gone", never to a throw. */
export function parsePin(value: unknown): Pin | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  const id = p['id'];
  const at = p['at'];
  if (typeof id !== 'string' || !id) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (p['kind'] === 'message') {
    const blockId = p['blockId'];
    const preview = p['preview'];
    const blockKind = p['blockKind'];
    if (typeof blockId !== 'string' || !blockId) return null;
    if (typeof preview !== 'string') return null;
    if (!isBlockKind(blockKind)) return null;
    const ts = p['ts'];
    return {
      id,
      kind: 'message',
      blockId,
      blockKind,
      preview,
      at,
      ...(typeof ts === 'string' && ts ? { ts } : {}),
    };
  }
  if (p['kind'] === 'note') {
    const text = p['text'];
    // Never resurrect an empty/whitespace note even if one slipped onto disk,
    // and never resurrect one past the cap (refuse-not-truncate holds on read
    // too, so a tampered payload cannot smuggle an oversized note back in).
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_NOTE_LEN) return null;
    // Optional provenance: keep it only when it is a well-formed { blockId:string }.
    // A malformed source degrades the note to a plain typed note (never a throw,
    // never a bogus jump target).
    const src = p['source'];
    let source: { blockId: string } | undefined;
    if (src && typeof src === 'object') {
      const blockId = (src as Record<string, unknown>)['blockId'];
      if (typeof blockId === 'string' && blockId) source = { blockId };
    }
    return { id, kind: 'note', text, at, ...(source ? { source } : {}) };
  }
  return null;
}

/** Defensive parse: any malformed, wrong-version, or non-conforming payload
 *  degrades to an empty store. Never throws. */
export function parsePinStore(raw: string | null): PinStore {
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
  if (obj['v'] !== PINS_VERSION) return emptyStore();
  const sessionsRaw = obj['sessions'];
  if (!sessionsRaw || typeof sessionsRaw !== 'object') return emptyStore();

  const sessions: Record<string, PinSessionEntry> = {};
  for (const [key, value] of Object.entries(sessionsRaw as Record<string, unknown>)) {
    if (!key || !value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const at = entry['at'];
    const pinsRaw = entry['pins'];
    if (typeof at !== 'number' || !Number.isFinite(at) || !Array.isArray(pinsRaw)) continue;
    const pins: Pin[] = [];
    const seenIds = new Set<string>();
    const seenBlocks = new Set<string>();
    for (const raw of pinsRaw) {
      const pin = parsePin(raw);
      if (!pin) continue;
      // Drop duplicate ids and duplicate message blocks defensively — the
      // mutators never create them, but a hand-edited payload might.
      if (seenIds.has(pin.id)) continue;
      if (pin.kind === 'message') {
        if (seenBlocks.has(pin.blockId)) continue;
        seenBlocks.add(pin.blockId);
      }
      seenIds.add(pin.id);
      pins.push(pin);
    }
    if (pins.length === 0) continue; // an empty session wastes a slot and a quota
    sessions[key] = { pins: pins.slice(0, MAX_PINS_PER_SESSION), at };
  }
  return { v: PINS_VERSION, sessions };
}

/** Keep only the `max` most-recently-touched sessions. */
export function evictLru(store: PinStore, max = MAX_PIN_SESSIONS): PinStore {
  const keys = Object.keys(store.sessions);
  if (keys.length <= max) return store;
  const kept = keys.sort((a, b) => (store.sessions[b]?.at ?? 0) - (store.sessions[a]?.at ?? 0)).slice(0, max);
  const sessions: Record<string, PinSessionEntry> = {};
  for (const key of kept) {
    const entry = store.sessions[key];
    if (entry) sessions[key] = entry;
  }
  return { v: PINS_VERSION, sessions };
}

/** The pins for one session, in DISPLAY order (store order, newest-first on
 *  insert), or [] when there are none. */
export function sessionPins(store: PinStore, sessionId: string): Pin[] {
  return store.sessions[sessionId]?.pins ?? [];
}

/** Is this block already pinned in this session? */
export function isMessagePinned(store: PinStore, sessionId: string, blockId: string): boolean {
  return sessionPins(store, sessionId).some(p => p.kind === 'message' && p.blockId === blockId);
}

/** Truncate a block's text to a stored preview (PREVIEW_LEN, single-lined). */
export function toPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LEN ? `${flat.slice(0, PREVIEW_LEN)}…` : flat;
}

/** Write a session's pin list back, refreshing its LRU touch and re-capping the
 *  whole store. An empty list REMOVES the session (no empty slots). */
function putSession(store: PinStore, sessionId: string, pins: Pin[], now: number): PinStore {
  const sessions = { ...store.sessions };
  if (pins.length === 0) {
    delete sessions[sessionId];
    return { v: PINS_VERSION, sessions };
  }
  sessions[sessionId] = { pins: pins.slice(0, MAX_PINS_PER_SESSION), at: now };
  return evictLru({ v: PINS_VERSION, sessions });
}

/** Toggle a message pin. Pinning an already-pinned block is a no-op on the DATA
 *  (dedupe by blockId); the caller flashes the existing entry instead. Newest
 *  pins go to the FRONT (display order). */
export function toggleMessagePin(
  store: PinStore,
  sessionId: string,
  input: { id: string; blockId: string; blockKind: PinBlockKind; preview: string; ts?: string },
  now: number,
): PinStore {
  const pins = sessionPins(store, sessionId);
  if (pins.some(p => p.kind === 'message' && p.blockId === input.blockId)) {
    // Unpin toggles OFF an existing pin.
    const next = pins.filter(p => !(p.kind === 'message' && p.blockId === input.blockId));
    if (next.length === pins.length) return store;
    return putSession(store, sessionId, next, now);
  }
  const pin: MessagePin = {
    id: input.id,
    kind: 'message',
    blockId: input.blockId,
    blockKind: input.blockKind,
    preview: toPreview(input.preview),
    at: now,
    ...(input.ts ? { ts: input.ts } : {}),
  };
  return putSession(store, sessionId, [pin, ...pins], now);
}

export type NoteResult = { ok: true; store: PinStore } | { ok: false; reason: 'empty' | 'too-long' };

/** Add a free-text note. Empty/whitespace is refused silently (`empty`);
 *  over-cap is refused loudly (`too-long`) so the sheet can show the count —
 *  a link is never silently shortened. Newest note goes to the FRONT.
 *
 *  `source` marks a note pinned FROM A SELECTION (pin-selection.ts): the caller
 *  has already truncated the snippet to fit the cap (a snippet is display data,
 *  not a link, so truncation-with-ellipsis is honest there — the source jump
 *  gets you the full text), so this path treats over-cap the same for both. */
export function addNote(
  store: PinStore,
  sessionId: string,
  text: string,
  id: string,
  now: number,
  source?: { blockId: string },
): NoteResult {
  if (text.trim().length === 0) return { ok: false, reason: 'empty' };
  if (text.length > MAX_NOTE_LEN) return { ok: false, reason: 'too-long' };
  const note: NotePin = { id, kind: 'note', text, at: now, ...(source ? { source } : {}) };
  return { ok: true, store: putSession(store, sessionId, [note, ...sessionPins(store, sessionId)], now) };
}

/** Edit a note in place, keeping its position. Same caps as add. A no-op edit
 *  (identical text) returns the store unchanged so callers can skip a write. */
export function editNote(store: PinStore, sessionId: string, id: string, text: string, now: number): NoteResult {
  if (text.trim().length === 0) return { ok: false, reason: 'empty' };
  if (text.length > MAX_NOTE_LEN) return { ok: false, reason: 'too-long' };
  const pins = sessionPins(store, sessionId);
  let changed = false;
  const next = pins.map(p => {
    if (p.kind === 'note' && p.id === id) {
      if (p.text === text) return p;
      changed = true;
      return { ...p, text, at: now };
    }
    return p;
  });
  if (!changed) return { ok: true, store };
  return { ok: true, store: putSession(store, sessionId, next, now) };
}

/** Remove any pin by id. Returns the same reference when nothing matched so
 *  callers can skip a needless write. */
export function removePin(store: PinStore, sessionId: string, id: string, now: number): PinStore {
  const pins = sessionPins(store, sessionId);
  const next = pins.filter(p => p.id !== id);
  if (next.length === pins.length) return store;
  return putSession(store, sessionId, next, now);
}

/** Re-insert a removed pin at a given index (undo). Clamped into range; caps
 *  still apply. */
export function insertPinAt(store: PinStore, sessionId: string, pin: Pin, index: number, now: number): PinStore {
  const pins = sessionPins(store, sessionId).filter(p => p.id !== pin.id);
  const at = Math.max(0, Math.min(index, pins.length));
  const next = [...pins.slice(0, at), pin, ...pins.slice(at)];
  return putSession(store, sessionId, next, now);
}

// ---- GitHub PR link recognition (display only) ------------------------------
//
// A note that is EXACTLY one GitHub PR URL renders as a compact chip
// `<repo>#<n>` with the full URL as title/aria-label. That is the whole "richer
// PR link" story for phase 1 — no fetching of title/state (the UI has no GitHub
// credentials; an unauthenticated call would rate-limit and leak the repo name
// to a third party from every reader's browser — pinning-design.md §4/§9).

export interface GithubPr {
  org: string;
  repo: string;
  number: number;
  url: string;
}

const GH_PR = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#][^\s]*)?$/i;

/** Recognise a note whose ENTIRE text is one GitHub PR URL. Returns null
 *  otherwise (including a URL with trailing prose — that is not "a PR link",
 *  it is a note that mentions one, and it linkifies normally). */
export function parseGithubPr(text: string): GithubPr | null {
  const trimmed = text.trim();
  const m = GH_PR.exec(trimmed);
  if (!m) return null;
  const [, org, repo, num] = m;
  if (!org || !repo || !num) return null;
  const n = Number(num);
  if (!Number.isFinite(n)) return null;
  return { org, repo, number: n, url: trimmed };
}

// ---- persistence ------------------------------------------------------------

function hasStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

export function readStore(): PinStore {
  if (!hasStorage()) return emptyStore();
  try {
    return parsePinStore(localStorage.getItem(PINS_KEY));
  } catch {
    return emptyStore();
  }
}

/** Write, swallowing every failure. A full quota retries once against a
 *  hard-pruned store; if even that fails we give up quietly — a failed pin save
 *  must never surface to, or block, the reader. */
function writeStore(store: PinStore): void {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(store));
  } catch {
    try {
      const pruned = evictLru(store, Math.min(10, MAX_PIN_SESSIONS));
      localStorage.setItem(PINS_KEY, JSON.stringify(pruned));
    } catch {
      /* out of room and out of options: drop the write rather than throw */
    }
  }
}

// ---- subscribable singleton -------------------------------------------------
//
// The hook layer (hooks/usePins.ts) reads through this via useSyncExternalStore.
// It keeps an in-memory snapshot so React gets a stable reference between
// mutations, listens to the cross-tab `storage` event, and notifies local
// subscribers on every write. Writes are last-write-wins across tabs, which is
// acceptable at this scale (pinning-design.md §3).

type Listener = () => void;

class PinsStore {
  private snapshot: PinStore = readStore();
  private listeners = new Set<Listener>();
  private bound = false;

  private ensureBound(): void {
    if (this.bound || typeof window === 'undefined') return;
    this.bound = true;
    window.addEventListener('storage', event => {
      if (event.key !== null && event.key !== PINS_KEY) return;
      this.snapshot = readStore();
      this.emit();
    });
  }

  subscribe = (listener: Listener): (() => void) => {
    this.ensureBound();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PinStore => this.snapshot;

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Apply a pure transform, persist, and notify — the one write path. */
  private commit(next: PinStore): void {
    if (next === this.snapshot) return;
    this.snapshot = next;
    writeStore(next);
    this.emit();
  }

  addNote(sessionId: string, text: string, now: number = Date.now(), source?: { blockId: string }): NoteResult {
    const result = addNote(this.snapshot, sessionId, text, uuid(), now, source);
    if (result.ok) this.commit(result.store);
    return result;
  }

  editNote(sessionId: string, id: string, text: string, now: number = Date.now()): NoteResult {
    const result = editNote(this.snapshot, sessionId, id, text, now);
    if (result.ok) this.commit(result.store);
    return result;
  }

  toggleMessage(
    sessionId: string,
    input: { blockId: string; blockKind: PinBlockKind; preview: string; ts?: string },
    now: number = Date.now(),
  ): void {
    this.commit(toggleMessagePin(this.snapshot, sessionId, { id: uuid(), ...input }, now));
  }

  remove(sessionId: string, id: string, now: number = Date.now()): void {
    this.commit(removePin(this.snapshot, sessionId, id, now));
  }

  insertAt(sessionId: string, pin: Pin, index: number, now: number = Date.now()): void {
    this.commit(insertPinAt(this.snapshot, sessionId, pin, index, now));
  }
}

/** A daemon-portable id. crypto.randomUUID is available in the UI's secure
 *  context (Cloudflare tunnel, HTTPS); fall back to a timestamp-random id where
 *  it is not so a pin never fails to get an id. */
function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const pinsStore = new PinsStore();
