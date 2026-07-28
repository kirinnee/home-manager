// SOLE OWNER of `kteam-transcript-boundaries-v1`.
//
// `/clear` changes what the harness remembers, not what kteam retains as its
// audit record. This module therefore owns a VIEW boundary only:
//   - derive authoritative markers from the transcript when a harness writes one;
//   - fall back to durable journal evidence for harnesses/paths that write none;
//   - cache those boundaries defensively so a bounded replay tail, reload, or
//     reconnect cannot make cleared history reappear;
//   - project a filtered array for <Transcript> without mutating or deleting the
//     complete blocks used by send-ledger, pin, question, lineage, and analytics
//     consumers.
//
// Compaction is deliberately absent from this store. It preserves a summary in
// model context, so it is a divider (system-blocks.ts), never a history cut.

import { useSyncExternalStore } from 'react';
import type { KTeamEvent, SendRecord } from '../types';
import type { TranscriptBlock } from './transcript';

export const TRANSCRIPT_BOUNDARIES_KEY = 'kteam-transcript-boundaries-v1';
export const TRANSCRIPT_BOUNDARIES_VERSION = 1;
export const MAX_BOUNDARIES_PER_SESSION = 32;
export const MAX_BOUNDARY_SESSIONS = 200;

export type TranscriptBoundaryOrigin =
  | 'transcript'
  | 'send-ledger'
  | 'journal-send'
  | 'journal-queue'
  | 'journal-command';

export interface TranscriptBoundary {
  /** Stable cache/React identity. Queue boundaries keep the queue id when the
   *  provisional send is later replaced by a consumed event. */
  id: string;
  kind: 'clear';
  origin: TranscriptBoundaryOrigin;
  /** Daemon/harness-authored ISO timestamp. Browser clocks are never used for placement. */
  at: string;
  /** Per-session journal order when the source is journalled. */
  sequence?: number;
  /** Exact block identity when a real transcript marker exists. */
  anchorBlockId?: string;
  harness?: string;
}

export interface TranscriptBoundarySession {
  boundaries: TranscriptBoundary[];
  /** Revealing is durable, but only for this newest boundary id. A later clear
   *  gets a new id and hides history again by default. */
  revealedBoundaryId?: string;
  /** Epoch milliseconds of the last write, used only for session LRU eviction. */
  at: number;
}

export interface TranscriptBoundaryStore {
  v: typeof TRANSCRIPT_BOUNDARIES_VERSION;
  sessions: Record<string, TranscriptBoundarySession>;
}

export interface TranscriptBoundaryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const ORIGINS = new Set<TranscriptBoundaryOrigin>([
  'transcript',
  'send-ledger',
  'journal-send',
  'journal-queue',
  'journal-command',
]);

const EMPTY_SESSION: TranscriptBoundarySession = Object.freeze({ boundaries: [], at: 0 });

export function emptyTranscriptBoundaryStore(): TranscriptBoundaryStore {
  return { v: TRANSCRIPT_BOUNDARIES_VERSION, sessions: {} };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function boundaryOrder(left: TranscriptBoundary, right: TranscriptBoundary): number {
  if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  const byTime = Date.parse(left.at) - Date.parse(right.at);
  return byTime || left.id.localeCompare(right.id);
}

export function parseTranscriptBoundary(value: unknown): TranscriptBoundary | null {
  const fields = object(value);
  if (!fields) return null;
  const id = boundedString(fields['id']);
  const origin = fields['origin'];
  const at = fields['at'];
  if (!id || fields['kind'] !== 'clear' || !ORIGINS.has(origin as TranscriptBoundaryOrigin) || !validIso(at)) {
    return null;
  }

  const rawSequence = fields['sequence'];
  const sequence =
    Number.isSafeInteger(rawSequence) && (rawSequence as number) >= 0 ? (rawSequence as number) : undefined;
  const anchorBlockId = boundedString(fields['anchorBlockId'], 1_024);
  // Every boundary needs a stable placement source. An unanchored,
  // unjournalled timestamp could only have come from a browser clock, which is
  // deliberately not comparable to a daemon/harness transcript clock.
  if (sequence === undefined && anchorBlockId === undefined && origin !== 'send-ledger') return null;

  const harness = boundedString(fields['harness'], 64);
  return {
    id,
    kind: 'clear',
    origin: origin as TranscriptBoundaryOrigin,
    at,
    ...(sequence === undefined ? {} : { sequence }),
    ...(anchorBlockId === undefined ? {} : { anchorBlockId }),
    ...(harness === undefined ? {} : { harness }),
  };
}

export function mergeTranscriptBoundaries(
  ...sources: ReadonlyArray<readonly TranscriptBoundary[]>
): TranscriptBoundary[] {
  const byId = new Map<string, TranscriptBoundary>();
  for (const source of sources) {
    for (const candidate of source) {
      const boundary = parseTranscriptBoundary(candidate);
      if (boundary) byId.set(boundary.id, boundary);
    }
  }
  return [...byId.values()].sort(boundaryOrder);
}

/** Defensive, field-by-field v1 read. One malformed boundary or session is
 *  dropped without taking valid siblings with it; unknown fields are ignored. */
export function parseTranscriptBoundaryStore(raw: string | null | undefined): TranscriptBoundaryStore {
  if (!raw) return emptyTranscriptBoundaryStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyTranscriptBoundaryStore();
  }
  const fields = object(parsed);
  const rawSessions = object(fields?.['sessions']);
  if (fields?.['v'] !== TRANSCRIPT_BOUNDARIES_VERSION || !rawSessions) return emptyTranscriptBoundaryStore();

  const entries: Array<[string, TranscriptBoundarySession]> = [];
  for (const [sessionId, rawEntry] of Object.entries(rawSessions)) {
    if (!sessionId || sessionId.length > 256) continue;
    const entry = object(rawEntry);
    const rawBoundaries = entry?.['boundaries'];
    const at = entry?.['at'];
    if (!Array.isArray(rawBoundaries) || typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue;
    const boundaries = mergeTranscriptBoundaries(
      rawBoundaries.flatMap(value => {
        const boundary = parseTranscriptBoundary(value);
        return boundary ? [boundary] : [];
      }),
    ).slice(-MAX_BOUNDARIES_PER_SESSION);
    if (boundaries.length === 0) continue;
    const revealedBoundaryId = boundedString(entry?.['revealedBoundaryId']);
    entries.push([
      sessionId,
      {
        boundaries,
        at,
        ...(revealedBoundaryId === undefined ? {} : { revealedBoundaryId }),
      },
    ]);
  }

  entries.sort((left, right) => right[1].at - left[1].at || left[0].localeCompare(right[0]));
  return {
    v: TRANSCRIPT_BOUNDARIES_VERSION,
    sessions: Object.fromEntries(entries.slice(0, MAX_BOUNDARY_SESSIONS)),
  };
}

function defaultStorage(): TranscriptBoundaryStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: TranscriptBoundaryStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : null;
  } catch {
    return null;
  }
}

export function loadTranscriptBoundaryStore(
  storage: TranscriptBoundaryStorage | null = defaultStorage(),
): TranscriptBoundaryStore {
  if (!storage) return emptyTranscriptBoundaryStore();
  try {
    return parseTranscriptBoundaryStore(storage.getItem(TRANSCRIPT_BOUNDARIES_KEY));
  } catch {
    return emptyTranscriptBoundaryStore();
  }
}

export function saveTranscriptBoundaryStore(
  store: TranscriptBoundaryStore,
  storage: TranscriptBoundaryStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(TRANSCRIPT_BOUNDARIES_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

type Listener = () => void;
let snapshot: TranscriptBoundaryStore | null = null;
const listeners = new Set<Listener>();

/** Identity-stable full-store snapshot for useSyncExternalStore. */
export function getTranscriptBoundaryStore(
  storage: TranscriptBoundaryStorage | null = defaultStorage(),
): TranscriptBoundaryStore {
  if (snapshot === null) snapshot = loadTranscriptBoundaryStore(storage);
  return snapshot;
}

export function subscribeTranscriptBoundaries(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publishTranscriptBoundaryStore(
  next: TranscriptBoundaryStore,
  storage: TranscriptBoundaryStorage | null,
): boolean {
  snapshot = next;
  const persisted = saveTranscriptBoundaryStore(next, storage);
  for (const listener of listeners) listener();
  return persisted;
}

function sameBoundaries(left: readonly TranscriptBoundary[], right: readonly TranscriptBoundary[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((boundary, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      boundary.id === other.id &&
      boundary.origin === other.origin &&
      boundary.at === other.at &&
      boundary.sequence === other.sequence &&
      boundary.anchorBlockId === other.anchorBlockId &&
      boundary.harness === other.harness
    );
  });
}

function capSessions(sessions: Record<string, TranscriptBoundarySession>): Record<string, TranscriptBoundarySession> {
  return Object.fromEntries(
    Object.entries(sessions)
      .sort((left, right) => right[1].at - left[1].at || left[0].localeCompare(right[0]))
      .slice(0, MAX_BOUNDARY_SESSIONS),
  );
}

/** Additively cache observed boundaries. A failed storage write still updates
 *  the in-memory snapshot for this tab and returns false. */
export function rememberTranscriptBoundaries(
  sessionId: string,
  observed: readonly TranscriptBoundary[],
  storage: TranscriptBoundaryStorage | null = defaultStorage(),
  at = Date.now(),
): boolean {
  if (!sessionId || !Number.isFinite(at)) return false;
  const additions = mergeTranscriptBoundaries(observed);
  if (additions.length === 0) return true;
  const current = getTranscriptBoundaryStore(storage);
  const existing = current.sessions[sessionId];
  const boundaries = mergeTranscriptBoundaries(existing?.boundaries ?? [], additions).slice(
    -MAX_BOUNDARIES_PER_SESSION,
  );
  if (existing && sameBoundaries(existing.boundaries, boundaries)) return true;

  const nextEntry: TranscriptBoundarySession = {
    boundaries,
    at,
    ...(existing?.revealedBoundaryId === undefined ? {} : { revealedBoundaryId: existing.revealedBoundaryId }),
  };
  return publishTranscriptBoundaryStore(
    {
      v: TRANSCRIPT_BOUNDARIES_VERSION,
      sessions: capSessions({ ...current.sessions, [sessionId]: nextEntry }),
    },
    storage,
  );
}

export function revealTranscriptHistory(
  sessionId: string,
  boundaryId: string,
  storage: TranscriptBoundaryStorage | null = defaultStorage(),
  at = Date.now(),
): boolean {
  const current = getTranscriptBoundaryStore(storage);
  const existing = current.sessions[sessionId];
  if (!existing || !existing.boundaries.some(boundary => boundary.id === boundaryId)) return false;
  if (existing.revealedBoundaryId === boundaryId) return true;
  return publishTranscriptBoundaryStore(
    {
      v: TRANSCRIPT_BOUNDARIES_VERSION,
      sessions: capSessions({
        ...current.sessions,
        [sessionId]: { ...existing, revealedBoundaryId: boundaryId, at },
      }),
    },
    storage,
  );
}

export function useTranscriptBoundarySession(sessionId: string): TranscriptBoundarySession {
  const store = useSyncExternalStore(
    subscribeTranscriptBoundaries,
    getTranscriptBoundaryStore,
    getTranscriptBoundaryStore,
  );
  return store.sessions[sessionId] ?? EMPTY_SESSION;
}

/** Test seam for module-local cache/listeners. */
export function resetTranscriptBoundaries(): void {
  snapshot = null;
  listeners.clear();
}

function eventData(event: KTeamEvent): Record<string, unknown> | undefined {
  return object(event.data);
}

function clearMessage(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '/clear';
}

function journalBoundary(
  event: KTeamEvent,
  id: string,
  origin: Exclude<TranscriptBoundaryOrigin, 'transcript'>,
  harness?: string,
): TranscriptBoundary | null {
  if (!validIso(event.time) || !Number.isSafeInteger(event.sequence) || event.sequence < 0) return null;
  return {
    id,
    kind: 'clear',
    origin,
    at: event.time,
    sequence: event.sequence,
    ...(harness ? { harness } : {}),
  };
}

/** Derive clear boundaries from durable daemon events.
 *
 * Idle Composer sends are recorded only after tmux delivery succeeds. Busy
 * native-queue sends are the documented send-time fallback for harnesses that
 * emit no marker; a later control.send_consumed with the same queue id upgrades
 * its timestamp without changing identity. queued-for-revive is not an applied
 * command and is therefore rejected. */
export function deriveJournalClearBoundaries(events: readonly KTeamEvent[], sessionId: string): TranscriptBoundary[] {
  const boundaries = new Map<string, TranscriptBoundary>();
  const humanClearQueues = new Set<string>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.sessionId !== sessionId) continue;
    const data = eventData(event);
    if (!data) continue;

    let boundary: TranscriptBoundary | null = null;
    // Peer sends are wrapped with attribution before reaching the harness, so
    // `/clear` is model-visible prose there, not a native local command.
    const humanSend = boundedString(data['from']) === undefined && boundedString(data['fromName']) === undefined;
    if (event.type === 'control.send' && humanSend && clearMessage(data['message'])) {
      boundary = journalBoundary(event, `send:${event.sequence}`, 'journal-send');
    } else if (
      event.type === 'control.send_queued' &&
      humanSend &&
      clearMessage(data['message']) &&
      data['native'] === true &&
      data['queuedForRevive'] !== true
    ) {
      const queueId = boundedString(data['queueId']);
      if (queueId) {
        humanClearQueues.add(queueId);
        boundary = journalBoundary(event, `queue:${queueId}`, 'journal-queue');
      }
    } else if (event.type === 'control.send_consumed' && clearMessage(data['message'])) {
      const queueId = boundedString(data['queueId']);
      // The consumed compatibility event omits sender attribution. Upgrade it
      // only when this replay slice also proved the originating queue entry was
      // human; the full send ledger covers older entries beyond the slice.
      if (queueId && humanClearQueues.has(queueId)) {
        boundary = journalBoundary(event, `queue:${queueId}`, 'journal-queue');
      }
    } else if (
      event.type === 'control.session_command' &&
      data['command'] === 'clear' &&
      data['disposition'] === 'handled-local'
    ) {
      boundary = journalBoundary(
        event,
        `command:${event.sequence}`,
        'journal-command',
        boundedString(data['harness'], 64),
      );
    }
    if (boundary) boundaries.set(boundary.id, boundary);
  }
  return [...boundaries.values()].sort(boundaryOrder);
}

/** The daemon send ledger is the long-horizon form of control.send: acceptedAt
 *  is server-authored, the logical message is retained past the journal tail,
 *  and a stable sendId survives reconnect/device changes. Held revive sends have
 *  not reached a harness; withdrawn sends were synchronously refused. Neither
 *  may create a context boundary. */
export function deriveLedgerClearBoundaries(records: readonly SendRecord[]): TranscriptBoundary[] {
  return records.flatMap(record => {
    if (
      record.message.trim() !== '/clear' ||
      record.from !== undefined ||
      record.fromName !== undefined ||
      record.held === true ||
      record.withdrawn === true ||
      !boundedString(record.sendId) ||
      !validIso(record.acceptedAt)
    ) {
      return [];
    }
    return [
      {
        id:
          record.path === 'native-inline' || record.path === 'native-file'
            ? `queue:${record.sendId}`
            : `ledger:${record.sendId}`,
        kind: 'clear' as const,
        origin: 'send-ledger' as const,
        at: record.acceptedAt,
      },
    ];
  });
}

/** Claude writes a real `/clear` command marker into the rotated transcript.
 *  When that marker reaches the current session stream it outranks clock
 *  placement by anchoring directly after its block. Codex currently emits no
 *  corresponding marker. */
export function deriveTranscriptClearBoundaries(blocks: readonly TranscriptBlock[]): TranscriptBoundary[] {
  return blocks.flatMap(block => {
    if (
      block.kind !== 'system' ||
      block.info.label !== 'command' ||
      block.info.summary?.trim() !== '/clear' ||
      !validIso(block.ts)
    ) {
      return [];
    }
    return [
      {
        id: `transcript:${block.id}`,
        kind: 'clear' as const,
        origin: 'transcript' as const,
        at: block.ts,
        anchorBlockId: block.id,
        harness: block.source,
      },
    ];
  });
}

/** Resolve against the complete built block list. Exact marker identity wins;
 *  journal time is a safe fallback because both it and record timestamps are
 *  daemon/harness authored. An unresolved boundary hides nothing. */
export function resolveTranscriptBoundaryIndex(
  blocks: readonly TranscriptBlock[],
  boundary: TranscriptBoundary,
): number | null {
  if (boundary.anchorBlockId) {
    const anchor = blocks.findIndex(block => block.id === boundary.anchorBlockId);
    if (anchor >= 0) return anchor + 1;
  }

  const boundaryAt = Date.parse(boundary.at);
  if (!Number.isFinite(boundaryAt)) return null;
  let lastTimestamp: number | undefined;
  let sawTimestamp = false;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const parsed = Date.parse('ts' in block ? (block.ts ?? '') : '');
    if (Number.isFinite(parsed)) {
      lastTimestamp = parsed;
      sawTimestamp = true;
    }
    if (lastTimestamp !== undefined && lastTimestamp > boundaryAt) return index;
  }
  return sawTimestamp ? blocks.length : null;
}

function clearDividerBlock(boundary: TranscriptBoundary): TranscriptBlock {
  return {
    id: `boundary:${boundary.id}`,
    kind: 'system',
    ts: boundary.at,
    source: 'kteam',
    info: {
      label: 'context cleared',
      summary: 'model context reset',
      divider: 'clear',
      raw: 'The model’s context was cleared here. kteam kept the earlier transcript as an audit trail; it is hidden from this view by default because the model no longer has it.',
    },
  };
}

export interface TranscriptBoundaryProjection {
  blocks: TranscriptBlock[];
  /** Original blocks hidden above the newest unrevealed clear. */
  hidden: number;
  activeBoundary?: TranscriptBoundary;
}

/** Insert clear dividers and hide history above the newest one by default.
 *  Boundaries at index zero separate nothing in the loaded window and are
 *  omitted. Multiple evidence sources resolving to the same index collapse to
 *  one divider (the newest evidence wins). */
export function applyTranscriptBoundaries(
  blocks: readonly TranscriptBlock[],
  boundaries: readonly TranscriptBoundary[],
  revealedBoundaryId?: string,
): TranscriptBoundaryProjection {
  const resolved = mergeTranscriptBoundaries(boundaries)
    .flatMap(boundary => {
      const index = resolveTranscriptBoundaryIndex(blocks, boundary);
      return index !== null && index > 0 ? [{ boundary, index }] : [];
    })
    .sort((left, right) => left.index - right.index || boundaryOrder(left.boundary, right.boundary));

  const byIndex = new Map<number, TranscriptBoundary>();
  for (const placement of resolved) byIndex.set(placement.index, placement.boundary);
  const placements = [...byIndex.entries()]
    .map(([index, boundary]) => ({ index, boundary }))
    .sort((left, right) => left.index - right.index);
  if (placements.length === 0) return { blocks: [...blocks], hidden: 0 };

  const projected: TranscriptBlock[] = [];
  for (let index = 0; index <= blocks.length; index += 1) {
    const boundary = byIndex.get(index);
    if (boundary) projected.push(clearDividerBlock(boundary));
    if (index < blocks.length) projected.push(blocks[index]!);
  }

  const active = placements[placements.length - 1]!;
  if (revealedBoundaryId === active.boundary.id) {
    return { blocks: projected, hidden: 0, activeBoundary: active.boundary };
  }
  const dividerIndex = projected.findIndex(block => block.id === `boundary:${active.boundary.id}`);
  return {
    blocks: dividerIndex < 0 ? projected : projected.slice(dividerIndex),
    hidden: active.index,
    activeBoundary: active.boundary,
  };
}
