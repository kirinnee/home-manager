// The pins store: per-session, file-based, daemon-owned. Two halves, exactly like
// tasks-store.ts:
//
//  1. PURE parse/validate/cap functions — every field checked one at a time, a
//     malformed pin degrading to "that pin is gone" rather than a throw. Fully
//     unit-testable, no I/O.
//  2. `PinStore` — the I/O wrapper: `<sessionDir>/pins.json` written with
//     `atomicJson` (temp+rename) under a per-session SerialQueue.
//
// WHY THE WRITE PATH IS SHAPED THIS WAY:
//   • THE DAEMON IS THE SOLE WRITER. A store constructed without `role: 'daemon'`
//     refuses every write. The CLI and the UI go through `/v1/sessions/:id/pins`.
//     This is not ceremony: a torn write from two concurrent writers corrupted a
//     file in this tree on 2026-07-27 (kteam-prob.md), and a pin board that lies
//     about what is pinned is worse than none.
//   • WRITES ARE SERIALISED PER SESSION and ATOMIC (temp+rename), so two pins
//     arriving in the same tick are strictly ordered and a crash mid-write can
//     never leave a half-written file — the reader sees the old file or the new
//     one, never a torn one.
//   • MUTATION IS READ-MODIFY-WRITE UNDER THE LOCK (`mutate`), so a note added
//     while a message pin is being removed cannot lose the other's change.

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { sessionDir, type KTeamPaths } from './paths';
import { atomicJson, now } from './io';
import { SerialQueue } from './tasks-store';
import {
  MAX_AGENT_PINS_PER_SESSION,
  MAX_NOTE_LEN,
  MAX_PINS_PER_SESSION,
  PIN_BLOCK_KINDS,
  PIN_SCHEMA_VERSION,
  PREVIEW_LEN,
  PinError,
  emptySnapshot,
  type Pin,
  type PinBlockKind,
  type PinBy,
  type PinSnapshot,
} from './pins-types';

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/** A session id from a request is joined onto the sessions dir to locate its
 *  `pins.json`, so anything with a path separator, a dot (`..`), or a surprise
 *  character is rejected BEFORE it becomes a path. Real ids are
 *  `<base36>-<hex>` (e.g. `ms3g6a8p-71542ce1`) — no dots, no slashes. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const isSafeSessionId = (value: unknown): value is string => typeof value === 'string' && SESSION_ID.test(value);

export function pinFile(paths: KTeamPaths, sessionId: string): string {
  return `${sessionDir(paths, sessionId)}/pins.json`;
}

// ---------------------------------------------------------------------------
// Pure parsing — field by field, degrade to skip, never throw
// ---------------------------------------------------------------------------

const isBlockKind = (value: unknown): value is PinBlockKind =>
  typeof value === 'string' && (PIN_BLOCK_KINDS as readonly string[]).includes(value);

const isBy = (value: unknown): value is PinBy => value === 'human' || value === 'agent';

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Defensive parse of ONE pin. Returns null for anything malformed, so a single
 *  bad pin degrades to "that pin is gone", never to a throw. Provenance defaults
 *  defensively: a pin with no readable `by` is treated as the human's (the safe
 *  default — never invent an agent attribution that could mislead the lead). */
export function parsePin(value: unknown): Pin | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  const id = p['id'];
  const at = p['at'];
  if (typeof id !== 'string' || !id) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const by: PinBy = isBy(p['by']) ? p['by'] : 'human';
  const createdBy = str(p['createdBy']);
  const createdByName = str(p['createdByName']);
  const base = { id, at, by, createdBy, createdByName };

  if (p['kind'] === 'message') {
    const blockId = p['blockId'];
    const preview = p['preview'];
    if (typeof blockId !== 'string' || !blockId) return null;
    if (typeof preview !== 'string') return null;
    if (!isBlockKind(p['blockKind'])) return null;
    const ts = p['ts'];
    return {
      ...base,
      kind: 'message',
      blockId,
      blockKind: p['blockKind'],
      preview,
      ...(typeof ts === 'string' && ts ? { ts } : {}),
    };
  }
  if (p['kind'] === 'note') {
    const text = p['text'];
    // Never resurrect an empty note, and never one past the cap (refuse-not-
    // truncate holds on READ too, so a hand-edited file cannot smuggle an
    // oversized note back in).
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_NOTE_LEN) return null;
    const src = p['source'];
    let source: { blockId: string } | undefined;
    if (src && typeof src === 'object') {
      const blockId = (src as Record<string, unknown>)['blockId'];
      if (typeof blockId === 'string' && blockId) source = { blockId };
    }
    return { ...base, kind: 'note', text, ...(source ? { source } : {}) };
  }
  return null;
}

/** Parse a whole `pins.json` blob into a clean pin list: wrong version discarded
 *  (migration point), malformed pins skipped, duplicate ids and duplicate message
 *  blocks dropped, then capped. Never throws. */
export function parsePinFile(text: string | null): Pin[] {
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const raw = parsed as Record<string, unknown>;
  if (raw['v'] !== PIN_SCHEMA_VERSION) return [];
  const list = raw['pins'];
  if (!Array.isArray(list)) return [];
  return dedupePins(list.map(parsePin).filter((p): p is Pin => p !== null));
}

/** Drop duplicate ids and duplicate message blocks. The mutators never create
 *  them, but a hand-edited file might. Order is preserved (first wins). */
export function dedupePins(pins: readonly Pin[]): Pin[] {
  const seenIds = new Set<string>();
  const seenBlocks = new Set<string>();
  const out: Pin[] = [];
  for (const pin of pins) {
    if (seenIds.has(pin.id)) continue;
    if (pin.kind === 'message') {
      if (seenBlocks.has(pin.blockId)) continue;
      seenBlocks.add(pin.blockId);
    }
    seenIds.add(pin.id);
    out.push(pin);
  }
  return out;
}

/** Enforce the caps on a pin list, newest-first order preserved. Two caps, in
 *  order:
 *   1. the AGENT sub-cap — keep only the newest {@link MAX_AGENT_PINS_PER_SESSION}
 *      agent pins, dropping the oldest agent pins beyond it. Human pins are never
 *      dropped here, so an agent can never evict the human's board.
 *   2. the TOTAL cap — keep only the newest {@link MAX_PINS_PER_SESSION} pins
 *      overall.
 *  "Newest" is list position: the mutators insert at the front, so index 0 is
 *  newest. This is total and deterministic. */
export function applyCaps(pins: readonly Pin[]): Pin[] {
  let agentSeen = 0;
  const afterAgentCap = pins.filter(pin => {
    if (pin.by !== 'agent') return true;
    agentSeen += 1;
    return agentSeen <= MAX_AGENT_PINS_PER_SESSION;
  });
  return afterAgentCap.slice(0, MAX_PINS_PER_SESSION);
}

/** Truncate a block's text to a stored preview (single-lined, PREVIEW_LEN). */
export function toPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LEN ? `${flat.slice(0, PREVIEW_LEN)}…` : flat;
}

/** Refuse an over-cap note with a message that names the cap AND the actual
 *  length, so the caller can fix it instead of guessing. NEVER truncates. */
export function validateNoteText(value: unknown): string {
  if (typeof value !== 'string') throw new PinError('invalid', 'note text is required and must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new PinError('invalid', 'note text may not be blank');
  if (value.length > MAX_NOTE_LEN) {
    throw new PinError(
      'too-long',
      `note is ${value.length} characters; the maximum is ${MAX_NOTE_LEN} (not truncated)`,
    );
  }
  return value;
}

/** Serialise a snapshot for disk: an explicit whitelist, so nothing derived can
 *  leak in. */
export function serializeSnapshot(snapshot: PinSnapshot): PinSnapshot {
  return {
    v: PIN_SCHEMA_VERSION,
    sessionId: snapshot.sessionId,
    pins: snapshot.pins.map(serializePin),
    updatedAt: snapshot.updatedAt,
  };
}

function serializePin(pin: Pin): Pin {
  const base = {
    id: pin.id,
    at: pin.at,
    by: pin.by,
    createdBy: pin.createdBy,
    createdByName: pin.createdByName,
  };
  return pin.kind === 'message'
    ? {
        ...base,
        kind: 'message',
        blockId: pin.blockId,
        blockKind: pin.blockKind,
        preview: pin.preview,
        ...(pin.ts ? { ts: pin.ts } : {}),
      }
    : { ...base, kind: 'note', text: pin.text, ...(pin.source ? { source: { blockId: pin.source.blockId } } : {}) };
}

// ---------------------------------------------------------------------------
// The I/O store
// ---------------------------------------------------------------------------

export type PinStoreRole = 'daemon' | 'reader';

export interface PinStoreOptions {
  /** Only a `daemon` store may write; anything else gets PinError('read-only').
   *  Default `reader`, so a store is read-only unless someone deliberately says
   *  otherwise. */
  role?: PinStoreRole;
}

export class PinStore {
  private readonly role: PinStoreRole;
  private readonly queue = new SerialQueue();

  constructor(
    private readonly paths: KTeamPaths,
    options: PinStoreOptions = {},
  ) {
    this.role = options.role ?? 'reader';
  }

  get writable(): boolean {
    return this.role === 'daemon';
  }

  file(sessionId: string): string {
    return pinFile(this.paths, sessionId);
  }

  private assertWritable(): void {
    if (this.role !== 'daemon') {
      throw new PinError('read-only', 'pins are daemon-owned: send this write to the daemon via /v1/sessions/:id/pins');
    }
  }

  /** Read a session's pins. Returns [] for absent OR unreadable OR malformed —
   *  all three mean the same thing to a reader, and none may throw. */
  async read(sessionId: string): Promise<Pin[]> {
    if (!isSafeSessionId(sessionId)) return [];
    const file = pinFile(this.paths, sessionId);
    if (!existsSync(file)) return [];
    const text = await readFile(file, 'utf8').catch(() => null);
    return parsePinFile(text);
  }

  /** Read as a full snapshot (the shape the API returns). */
  async snapshot(sessionId: string): Promise<PinSnapshot> {
    const pins = await this.read(sessionId);
    return { v: PIN_SCHEMA_VERSION, sessionId, pins, updatedAt: now() };
  }

  /** READ → transform → WRITE under one hold of the session's lock. `transform`
   *  receives the current (parsed, de-duplicated) pin list and returns the
   *  desired next list; caps and dedupe are applied here, so a transform cannot
   *  smuggle past them. Returns the written snapshot. A transform that throws
   *  writes nothing (validation belongs inside it). */
  async mutate(sessionId: string, transform: (current: Pin[]) => Pin[]): Promise<PinSnapshot> {
    this.assertWritable();
    if (!isSafeSessionId(sessionId)) throw new PinError('invalid', `not a valid session id: ${String(sessionId)}`);
    return this.queue.run(sessionId, async () => {
      const current = await this.read(sessionId);
      const next = applyCaps(dedupePins(transform(current)));
      const at = now();
      const snapshot: PinSnapshot = { v: PIN_SCHEMA_VERSION, sessionId, pins: next, updatedAt: at };
      await atomicJson(pinFile(this.paths, sessionId), serializeSnapshot(snapshot));
      return snapshot;
    });
  }
}

export { PIN_SCHEMA_VERSION, emptySnapshot };
