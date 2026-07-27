// Per-session PINS — DAEMON-BACKED. The daemon (src/pins-*.ts,
// `GET`/`POST /v1/sessions/:id/pins`) is the ONE source of truth:
//   - an agent can pin via `kteam pin`, and its pins are visibly tagged as
//     agent-made (provenance) so the reader can always tell who put a pin there;
//   - pins follow the reader across devices, converging live over the events
//     stream (a `pins.updated` event carrying the whole snapshot);
//   - ALL policy — caps (including the agent sub-cap), dedupe, ordering, preview
//     derivation, provenance stamping — runs daemon-side and nowhere else.
//
// What this module keeps client-side is deliberately policy-free:
//   1. A per-session in-memory CACHE of the last server snapshot, exposed
//      through the external-store contract the UI consumes (`getSnapshot()` /
//      `subscribe()`), so React reads are synchronous and stable.
//   2. An OPTIMISTIC ECHO on each mutation: the cache reflects the asked-for
//      change immediately, then the authoritative snapshot in the POST response
//      (or the live `pins.updated` event) overwrites it. The echo computes no
//      policy — if the daemon caps, dedupes, or reorders, that is what sticks.
//   3. Synchronous NOTE VALIDATION (empty / over-cap), because the sheet needs
//      its refuse-not-truncate feedback before any round-trip.
//
// The phase-1 client store (the `kteam-pins-v1` localStorage key with local
// caps, LRU and persistence-on-mutate) is GONE as a store. Its read path is
// retained for exactly one purpose: the one-time migration that imports a
// reader's existing localStorage pins into the daemon on first load of a
// session with no server pins (see `maybeMigrate`). Nothing writes that key any
// more, and the key is deliberately NOT deleted after import — a device whose
// migration has not run yet must keep its data recoverable.
//
// DEGRADATION: when the daemon is unreachable a session's status is `error`, so
// the sheet can say "can't reach pins" rather than render an empty list that
// looks like "you have no pins".

import { TOKEN } from './api';

/** Phase-1 localStorage key — retained READ-ONLY as the migration source. */
export const PINS_KEY = 'kteam-pins-v1';
/** Records which sessions have already had their localStorage pins imported, so
 *  the one-time migration never re-runs. */
const MIGRATED_KEY = 'kteam-pins-migrated-v1';
export const PINS_VERSION = 1;
/** Defensive per-session cap applied when READING the legacy localStorage
 *  payload for migration. The LIVE cap is the daemon's (src/pins-types.ts),
 *  which also enforces an agent sub-cap this client never needs to know. */
export const MAX_PINS_PER_SESSION = 20;
/** Per-note hard cap, mirrored from the daemon (src/pins-types.ts) so the sheet
 *  can refuse synchronously with a character count. A note over this is
 *  REFUSED, never truncated — the reader must never get back a silently
 *  shortened link (drafts.ts:30-33 rationale). The daemon re-validates. */
export const MAX_NOTE_LEN = 500;

/** The transcript block kinds a pin can point at. Mirrors TranscriptBlock.kind
 *  without importing it, so this pure module stays free of the transcript. */
export type PinBlockKind = 'user' | 'assistant' | 'thinking' | 'tools' | 'system' | 'notice';

/** Who created a pin. Stamped by the daemon from the resolved actor, never by a
 *  client. A pin with no `by` (a legacy localStorage pin, or an optimistic local
 *  echo awaiting the server round-trip) reads as the human — the safe default,
 *  so an agent attribution is never invented. */
export type PinBy = 'human' | 'agent';

/** Provenance shared by both pin kinds. All optional so legacy/echoed pins
 *  parse unchanged; `by` absent ⇒ human. */
export interface PinProvenance {
  by?: PinBy;
  /** The authoring agent's session id (attribution only), else null/absent. */
  createdBy?: string | null;
  /** The authoring agent's teammate callsign when known. */
  createdByName?: string | null;
}

export interface MessagePin extends PinProvenance {
  id: string;
  kind: 'message';
  /** TranscriptBlock.id — content-derived, stable across re-reads for Claude
   *  sessions (harness recordUuid); see pinning-design.md §6 for the codex
   *  caveat and the honest not-found path that covers it. */
  blockId: string;
  blockKind: PinBlockKind;
  /** First chars of the block text AT PIN TIME, derived by the daemon
   *  (pins-store.toPreview). Stored, not re-derived at render — this is what
   *  keeps a pin legible when its target block is not loaded. */
  preview: string;
  /** The block's record timestamp, for display. */
  ts?: string;
  /** Epoch ms pinned. */
  at: number;
}

export interface NotePin extends PinProvenance {
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
  /** Epoch ms this cache entry was last written (snapshot applied or echoed). */
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
function parseProvenance(p: Record<string, unknown>): PinProvenance {
  const prov: PinProvenance = {};
  if (p['by'] === 'agent' || p['by'] === 'human') prov.by = p['by'];
  if (typeof p['createdBy'] === 'string' && p['createdBy']) prov.createdBy = p['createdBy'];
  if (typeof p['createdByName'] === 'string' && p['createdByName']) prov.createdByName = p['createdByName'];
  return prov;
}

export function parsePin(value: unknown): Pin | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  const id = p['id'];
  const at = p['at'];
  if (typeof id !== 'string' || !id) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const prov = parseProvenance(p);
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
      ...prov,
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
    return { id, kind: 'note', text, at, ...prov, ...(source ? { source } : {}) };
  }
  return null;
}

/** Defensive parse of the LEGACY localStorage payload (migration source only).
 *  Any malformed, wrong-version, or non-conforming payload degrades to an empty
 *  store. Never throws. */
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
      // phase-1 mutators never created them, but a hand-edited payload might.
      if (seenIds.has(pin.id)) continue;
      if (pin.kind === 'message') {
        if (seenBlocks.has(pin.blockId)) continue;
        seenBlocks.add(pin.blockId);
      }
      seenIds.add(pin.id);
      pins.push(pin);
    }
    if (pins.length === 0) continue;
    sessions[key] = { pins: pins.slice(0, MAX_PINS_PER_SESSION), at };
  }
  return { v: PINS_VERSION, sessions };
}

/** The pins for one session, in DISPLAY order (the daemon's order), or [] when
 *  there are none. */
export function sessionPins(store: PinStore, sessionId: string): Pin[] {
  return store.sessions[sessionId]?.pins ?? [];
}

/** Is this block already pinned in this session? */
export function isMessagePinned(store: PinStore, sessionId: string, blockId: string): boolean {
  return sessionPins(store, sessionId).some(p => p.kind === 'message' && p.blockId === blockId);
}

export type NoteResult = { ok: true } | { ok: false; reason: 'empty' | 'too-long' };

/** Synchronous note validation, so the sheet can refuse before any round-trip.
 *  Empty/whitespace is refused silently (`empty`); over-cap is refused loudly
 *  (`too-long`) so the sheet can show the count — a link is never silently
 *  shortened. The daemon re-validates with the same rules (pins-store). */
export function validateNote(text: string): NoteResult {
  if (text.trim().length === 0) return { ok: false, reason: 'empty' };
  if (text.length > MAX_NOTE_LEN) return { ok: false, reason: 'too-long' };
  return { ok: true };
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

// ---- legacy localStorage (migration source only) ----------------------------

function hasStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

/** Read the phase-1 localStorage store. Retained ONLY so its pins can be imported
 *  into the daemon once (see `maybeMigrate`); nothing writes this key any more,
 *  and nothing deletes it — a device whose migration has not run yet must keep
 *  its data recoverable. */
export function readStore(): PinStore {
  if (!hasStorage()) return emptyStore();
  try {
    return parsePinStore(localStorage.getItem(PINS_KEY));
  } catch {
    return emptyStore();
  }
}

function migratedSessions(): Set<string> {
  if (!hasStorage()) return new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(MIGRATED_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function markMigrated(sessionId: string): void {
  if (!hasStorage()) return;
  try {
    const set = migratedSessions();
    set.add(sessionId);
    localStorage.setItem(MIGRATED_KEY, JSON.stringify([...set]));
  } catch {
    /* a full quota just means we may re-attempt the import; it dedupes server-side */
  }
}

// ---- server transport -------------------------------------------------------

/** The whole board for one session, as the daemon returns it. */
export interface PinSnapshot {
  v: number;
  sessionId: string;
  pins: Pin[];
  updatedAt: string;
}

function pinPath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/pins`;
}

/** A minimal authenticated fetch to the pins routes. Kept here (not in lib/api.ts)
 *  so the whole pins feature is self-contained. Mints an `x-kteam-request-id` per
 *  mutation so a retried POST adds at most one pin (daemon dedupe). */
async function pinFetch(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (method !== 'GET' && !headers.has('x-kteam-request-id')) headers.set('x-kteam-request-id', uuid());
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Parse a daemon snapshot into a clean, de-duplicated pin list. Defensive: a
 *  malformed body degrades to an empty list, never a throw. */
export function parseServerPins(value: unknown): Pin[] {
  if (!value || typeof value !== 'object') return [];
  const list = (value as Record<string, unknown>)['pins'];
  if (!Array.isArray(list)) return [];
  const pins: Pin[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const pin = parsePin(raw);
    if (pin && !seen.has(pin.id)) {
      seen.add(pin.id);
      pins.push(pin);
    }
  }
  return pins;
}

// ---- subscribable singleton -------------------------------------------------
//
// The hook layer (hooks/usePins.ts) reads through this via useSyncExternalStore.
// It keeps an in-memory per-session CACHE so React gets a stable reference
// between updates and the synchronous readers (TranscriptRow's
// `isMessagePinned`) keep working. The source of truth is the daemon:
// `hydrate()` GETs a session on demand, `applyServerSnapshot()` applies a
// GET/POST body or a live `pins.updated` event verbatim (no client-side caps or
// reordering), and every mutation echoes into the cache, POSTs the action, then
// reconciles against the server's returned snapshot.

type Listener = () => void;

/** Per-session degradation state, surfaced so the sheet can be honest about a
 *  daemon it cannot reach rather than showing an empty list. */
export type PinSessionStatus = 'idle' | 'loading' | 'ready' | 'error';

class PinsStore {
  // Cache starts EMPTY (not from localStorage): the daemon is the source of
  // truth, and localStorage is imported through the migration path only.
  private snapshot: PinStore = emptyStore();
  private listeners = new Set<Listener>();
  private statuses = new Map<string, PinSessionStatus>();
  private inflight = new Map<string, Promise<void>>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PinStore => this.snapshot;

  status(sessionId: string): PinSessionStatus {
    return this.statuses.get(sessionId) ?? 'idle';
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private setStatus(sessionId: string, status: PinSessionStatus): void {
    if (this.statuses.get(sessionId) === status) return;
    this.statuses.set(sessionId, status);
    this.emit();
  }

  /** Replace one session's cached pin list wholesale. No policy runs here — no
   *  caps, no dedupe, no ordering rules; those are the daemon's alone. */
  private put(sessionId: string, pins: Pin[]): void {
    const sessions = { ...this.snapshot.sessions };
    if (pins.length === 0) delete sessions[sessionId];
    else sessions[sessionId] = { pins, at: Date.now() };
    this.snapshot = { v: PINS_VERSION, sessions };
    this.emit();
  }

  /** Replace one session's pins from an authoritative server snapshot (a GET/POST
   *  body or a live `pins.updated` event). The cache IS the daemon's list. */
  applyServerSnapshot(sessionId: string, value: unknown): void {
    this.put(sessionId, parseServerPins(value));
  }

  /** Fetch a session's pins from the daemon. Idempotent: a second call while the
   *  first is in flight (or after it succeeded) is a no-op. On failure the status
   *  becomes `error` so the sheet degrades honestly. */
  hydrate(sessionId: string): Promise<void> {
    if (!sessionId) return Promise.resolve();
    const existing = this.inflight.get(sessionId);
    if (existing) return existing;
    if (this.statuses.get(sessionId) === 'ready') return Promise.resolve();
    this.setStatus(sessionId, 'loading');
    const run = (async () => {
      try {
        const body = await pinFetch(pinPath(sessionId));
        this.applyServerSnapshot(sessionId, body);
        this.setStatus(sessionId, 'ready');
        await this.maybeMigrate(sessionId, parseServerPins(body).length);
      } catch {
        this.setStatus(sessionId, 'error');
      } finally {
        this.inflight.delete(sessionId);
      }
    })();
    this.inflight.set(sessionId, run);
    return run;
  }

  /** One-time import of the reader's phase-1 localStorage pins for a session that
   *  has none server-side yet. Safe to retry — the daemon dedupes by id. */
  private async maybeMigrate(sessionId: string, serverCount: number): Promise<void> {
    if (serverCount > 0) return;
    if (migratedSessions().has(sessionId)) return;
    const local = sessionPins(readStore(), sessionId);
    markMigrated(sessionId); // mark first, so a failed import never loops forever
    if (local.length === 0) return;
    try {
      const body = await pinFetch(pinPath(sessionId), {
        method: 'POST',
        body: JSON.stringify({ action: 'import', pins: local }),
      });
      this.applyServerSnapshot(sessionId, body);
    } catch {
      /* the reader still has their localStorage copy; the sheet shows the error */
    }
  }

  /** Echo `pins` into the cache so the UI reflects the asked-for change at once,
   *  POST `body`, then reconcile from the server snapshot — whatever the daemon
   *  decided (caps, dedupe, ordering, provenance) overwrites the echo. On
   *  failure, re-hydrate to resync and flag the error. */
  private mutate(sessionId: string, pins: Pin[], body: unknown): void {
    this.put(sessionId, pins);
    void (async () => {
      try {
        const result = await pinFetch(pinPath(sessionId), { method: 'POST', body: JSON.stringify(body) });
        this.applyServerSnapshot(sessionId, result);
        this.setStatus(sessionId, 'ready');
      } catch {
        this.setStatus(sessionId, 'error');
        // Resync from the daemon so the echo never lingers as a lie.
        this.statuses.delete(sessionId);
        void this.hydrate(sessionId);
      }
    })();
  }

  /** Add a free-text note. Validation is synchronous so the sheet gets its
   *  empty/too-long feedback before the round-trip; the daemon assigns the real
   *  id and provenance (the echoed id is provisional and replaced on reconcile).
   *
   *  `source` marks a note pinned FROM A SELECTION (pin-selection.ts): the
   *  caller has already truncated the snippet to fit the cap (a snippet is
   *  display data, not a link, so truncation-with-ellipsis is honest there —
   *  the source jump gets you the full text). */
  addNote(sessionId: string, text: string, now: number = Date.now(), source?: { blockId: string }): NoteResult {
    const valid = validateNote(text);
    if (!valid.ok) return valid;
    const note: NotePin = { id: uuid(), kind: 'note', text, at: now, ...(source ? { source } : {}) };
    this.mutate(sessionId, [note, ...sessionPins(this.snapshot, sessionId)], {
      action: 'add',
      kind: 'note',
      text,
      ...(source ? { source } : {}),
    });
    return valid;
  }

  /** Edit a note in place. Same validation as add; a no-op edit (identical text
   *  or unknown id) skips the round-trip. */
  editNote(sessionId: string, id: string, text: string, now: number = Date.now()): NoteResult {
    const valid = validateNote(text);
    if (!valid.ok) return valid;
    const pins = sessionPins(this.snapshot, sessionId);
    const target = pins.find((p): p is NotePin => p.kind === 'note' && p.id === id);
    if (!target || target.text === text) return valid;
    this.mutate(
      sessionId,
      pins.map(p => (p.kind === 'note' && p.id === id ? { ...p, text, at: now } : p)),
      { action: 'edit', id, text },
    );
    return valid;
  }

  /** Pin a message, or unpin it when its block is already pinned. The echoed
   *  preview is the caller's raw text; the daemon derives the stored preview
   *  (pins-store.toPreview) and the reconcile replaces the echo. */
  toggleMessage(
    sessionId: string,
    input: { blockId: string; blockKind: PinBlockKind; preview: string; ts?: string },
    now: number = Date.now(),
  ): void {
    const pins = sessionPins(this.snapshot, sessionId);
    const existing = pins.find(p => p.kind === 'message' && p.blockId === input.blockId);
    if (existing) {
      this.mutate(
        sessionId,
        pins.filter(p => p.id !== existing.id),
        { action: 'remove', id: existing.id },
      );
      return;
    }
    const pin: MessagePin = {
      id: uuid(),
      kind: 'message',
      blockId: input.blockId,
      blockKind: input.blockKind,
      preview: input.preview,
      at: now,
      ...(input.ts ? { ts: input.ts } : {}),
    };
    this.mutate(sessionId, [pin, ...pins], {
      action: 'add',
      kind: 'message',
      blockId: input.blockId,
      blockKind: input.blockKind,
      preview: input.preview,
      ...(input.ts ? { ts: input.ts } : {}),
    });
  }

  /** Remove any pin by id. A miss is a silent no-op (no round-trip). */
  remove(sessionId: string, id: string): void {
    const pins = sessionPins(this.snapshot, sessionId);
    const next = pins.filter(p => p.id !== id);
    if (next.length === pins.length) return;
    this.mutate(sessionId, next, { action: 'remove', id });
  }

  /** Undo a delete by re-adding the pin server-side. Position is NOT restored —
   *  a re-created pin goes to the front (newest-first), the daemon mints a fresh
   *  id, and provenance is re-stamped from the current actor. The echo matches
   *  that (front insert), so undo never shows an order the server will contradict. */
  readd(sessionId: string, pin: Pin, now: number = Date.now()): void {
    const body =
      pin.kind === 'note'
        ? { action: 'add', kind: 'note', text: pin.text, ...(pin.source ? { source: pin.source } : {}) }
        : {
            action: 'add',
            kind: 'message',
            blockId: pin.blockId,
            blockKind: pin.blockKind,
            preview: pin.preview,
            ...(pin.ts ? { ts: pin.ts } : {}),
          };
    const rest = sessionPins(this.snapshot, sessionId).filter(p => p.id !== pin.id);
    this.mutate(sessionId, [{ ...pin, at: now }, ...rest], body);
  }
}

/** A daemon-portable id for the request-id header and the provisional echo.
 *  crypto.randomUUID is available in the UI's secure context (Cloudflare
 *  tunnel, HTTPS); fall back to a timestamp-random id where it is not. */
function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const pinsStore = new PinsStore();
