// Shared types for daemon-owned, per-session attention records.
//
// An attention board is deliberately not session status. Status is transient and
// may move as the harness resumes; an unresolved request stays here until an
// explicit resolution is recorded. The file therefore carries two bounded
// collections: active items (oldest first) and recent resolution audit entries.

export const ATTENTION_SCHEMA_VERSION = 1;

/** An active request is never evicted to make room. At the cap a new add is
 * refused, because silently dropping the oldest blocker would make the list
 * untrustworthy. */
export const MAX_ATTENTION_PER_SESSION = 20;

/** An agent loop cannot fill the whole board and crowd out daemon/human-raised
 * blockers. This counts active items whose raising actor is an agent. */
export const MAX_AGENT_ATTENTION_PER_SESSION = 10;

/** Resolution history is audit evidence, not an unbounded event journal. */
export const MAX_ATTENTION_RESOLUTIONS = 100;

export const MAX_ATTENTION_SUBJECT_LEN = 240;
export const MAX_ATTENTION_DETAIL_LEN = 2_000;
export const MAX_ATTENTION_SOURCE_REF_LEN = 512;

export const ATTENTION_SOURCES = ['task', 'question', 'permission', 'agent-raised'] as const;
export type AttentionSource = (typeof ATTENTION_SOURCES)[number];

/** Canonical ids stay sigil-free in storage and on the wire. Human-facing
 * references add `?`, so item A3 is written as `?A3` in messages. */
export type AttentionId = `A${number}`;
const ATTENTION_ID = /^A([1-9][0-9]*)$/u;

export function parseAttentionId(value: unknown): AttentionId | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/^\?/u, '');
  const match = raw.match(ATTENTION_ID);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
  return raw as AttentionId;
}

export function attentionReference(id: AttentionId): `?${AttentionId}` {
  return `?${id}`;
}

/** Provenance is always derived from the resolved actor. */
export type AttentionBy = 'human' | 'agent' | 'daemon';

/**
 * Attribution caveat: kteam currently uses one fleet admin bearer. A holder of
 * that token can deliberately omit or spoof `x-kteam-session-id`, so these
 * actor fields are an operational audit trail, not cryptographic per-session
 * authorization. Body-supplied, reserved, unknown, and cross-session actors
 * are still rejected; stronger proof requires per-session capabilities.
 */
export interface AttentionActor {
  /** `user`/blank means human; a canonical session id means an agent. `daemon`
   * is reserved for trusted in-process source reconciliation and is rejected
   * on the HTTP mutation path. Route wiring fills this from authenticated actor
   * context, never request JSON. */
  actor?: string | null;
  actorName?: string | null;
}

export interface AttentionItem {
  id: AttentionId;
  source: AttentionSource;
  /** Stable source identity used for idempotent integration, e.g. task F31 or
   * a question tool-use id. Null for a free-form explicit agent request. */
  sourceRef: string | null;
  subject: string;
  why: string;
  /** ISO timestamp. Display order is ascending: oldest unanswered first. */
  waitingSince: string;
  howToResolve: string;
  raisedBy: AttentionBy;
  raisedBySession: string | null;
  raisedByName: string | null;
}

/** A resolved item keeps the entire request plus the actor-stamped resolution.
 * This is what makes an agent clear visible and traceable. */
export interface ResolvedAttentionItem extends AttentionItem {
  resolvedAt: string;
  resolvedBy: AttentionBy;
  resolvedBySession: string | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
}

/** Whole-board shape returned by the API and carried by attention.updated. */
export interface AttentionSnapshot {
  v: number;
  sessionId: string;
  items: AttentionItem[];
  resolved: ResolvedAttentionItem[];
  /** Persisted in attention.json so a fleet badge reads one tiny scalar. */
  count: number;
  /** Corrupt entries are surfaced, never silently converted into a trusted
   * empty list. Writers refuse to overwrite a file with parse errors. */
  parseErrors: number;
  updatedAt: string;
}

export type AttentionErrorCode =
  | 'invalid'
  | 'too-long'
  | 'not-found'
  | 'forbidden'
  | 'rate-limited'
  | 'read-only'
  | 'full'
  | 'corrupt';

export class AttentionError extends Error {
  constructor(
    readonly code: AttentionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AttentionError';
  }
}

export function isAttentionError(value: unknown): value is AttentionError {
  return value instanceof AttentionError || (value instanceof Error && value.name === 'AttentionError');
}

export function emptyAttentionSnapshot(sessionId: string, at: string): AttentionSnapshot {
  return {
    v: ATTENTION_SCHEMA_VERSION,
    sessionId,
    items: [],
    resolved: [],
    count: 0,
    parseErrors: 0,
    updatedAt: at,
  };
}
