// Shared types and constants for daemon-owned, per-session PINS (phase 2 of the
// pinning feature: pinning-design.md §2/§7, agent-pins-recommendation.md).
//
// Phase 1 kept pins in the browser's localStorage (`kteam-pins-v1`,
// ui/src/lib/pins.ts) so they could ship without a daemon restart. That store is
// per-browser and no agent can reach it. Phase 2 moves the pins into the daemon:
// one small JSON file per session, mutated ONLY through the daemon, so
//   • an agent can pin via `kteam pin` (a CLI in the `kteam task` mould), and
//   • pins follow the reader between phone and desktop over the events stream.
//
// The item shape is deliberately the daemon-portable superset of the phase-1
// `Pin` (ids stay strings, timestamps stay epoch ms) so the client store can
// one-time IMPORT its local pins on first load — plus the two things a shared,
// agent-writable board needs that a private browser store did not:
//   • PROVENANCE (`by` + who): a pin an agent made must be visibly distinct from
//     one the human made. The fleet learned this the hard way when a teammate
//     answered a question meant for the human and the lead could not tell a human
//     decision from an agent's inference afterwards. The daemon is the SOLE
//     authority on `by`; a client cannot forge it (see pins-service.ts).
//   • an AGENT SUB-CAP so an agent that pins on every turn cannot crowd the
//     human's own pins off their own board.

export const PIN_SCHEMA_VERSION = 1;

/** A pin board, not a second transcript. Adding past this drops the OLDEST pin
 *  (never refuses the new one — the latest intent wins), mirroring phase 1. */
export const MAX_PINS_PER_SESSION = 20;

/** Of the {@link MAX_PINS_PER_SESSION}, at most this many may be AGENT-authored.
 *  This is the anti-spam core (agent-pins-recommendation.md §4.3): an agent stuck
 *  in a pin-every-turn loop can never evict the human's own pins, because its
 *  slice is capped separately and the human's pins are never dropped to make room
 *  for an agent's. */
export const MAX_AGENT_PINS_PER_SESSION = 10;

/** Per-note hard cap. Over this is REFUSED, never truncated — a link must never
 *  come back silently shortened (drafts.ts / phase-1 rationale). */
export const MAX_NOTE_LEN = 500;

/** Stored message-pin preview length. Derived DISPLAY data, so truncation here is
 *  fine (unlike a note). */
export const PREVIEW_LEN = 200;

/** Who created a pin. Derived server-side from the resolved actor, never taken
 *  from the request body. */
export type PinBy = 'human' | 'agent';

/** The transcript block kinds a message pin can point at. Mirrors the UI's
 *  TranscriptBlock.kind without importing it. */
export const PIN_BLOCK_KINDS = ['user', 'assistant', 'thinking', 'tools', 'system', 'notice'] as const;
export type PinBlockKind = (typeof PIN_BLOCK_KINDS)[number];

/** Fields every pin carries, whatever its kind. `createdBy`/`createdByName` are
 *  attribution only (the agent's session id + callsign); a human pin leaves them
 *  null. */
interface PinBase {
  id: string;
  /** Epoch ms created; bumped on a note edit. */
  at: number;
  by: PinBy;
  /** The authoring agent's session id, or null for a human. */
  createdBy: string | null;
  /** The authoring agent's teammate callsign when known, else null. */
  createdByName: string | null;
}

export interface MessagePin extends PinBase {
  kind: 'message';
  /** TranscriptBlock.id — content-derived, stable across re-reads for Claude
   *  sessions; see pinning-design.md §6 for the codex caveat + honest not-found. */
  blockId: string;
  blockKind: PinBlockKind;
  /** First PREVIEW_LEN chars of the block text at pin time — stored, so the pin
   *  stays legible when its target block is not in the loaded window. */
  preview: string;
  /** The block's record timestamp, for display. */
  ts?: string;
}

export interface NotePin extends PinBase {
  kind: 'note';
  /** <= MAX_NOTE_LEN; URLs auto-linked at render. */
  text: string;
  /** Optional provenance for a note pinned FROM A SELECTION: the block the
   *  snippet came from, enabling a "jump to source". Absent for a typed note. */
  source?: { blockId: string };
}

export type Pin = MessagePin | NotePin;

/** The whole board for one session, as stored on disk and returned by the API. */
export interface PinSnapshot {
  v: number;
  sessionId: string;
  pins: Pin[];
  /** ISO of the last mutation (or of an empty read). */
  updatedAt: string;
}

/** Who is asking, resolved server-side from the token/actor context (never from
 *  the body). `actor === 'user'` (or a null/blank session id) reads as the human;
 *  any resolved session id reads as an agent. Mirrors `resolveTaskActor`. */
export interface PinActor {
  /** The resolved actor string: `'user'` for the human, else a session id. */
  actor?: string | null;
  /** The teammate callsign when the actor is an agent, else null. */
  actorName?: string | null;
}

export type PinErrorCode = 'invalid' | 'too-long' | 'not-found' | 'forbidden' | 'rate-limited' | 'read-only';

/** The one error type the pins subsystem throws for a caller mistake. The route
 *  layer maps `.code` to an HTTP status; a non-PinError is a genuine bug and is
 *  rethrown so the caller's 500 handling still applies. */
export class PinError extends Error {
  constructor(
    readonly code: PinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PinError';
  }
}

export function isPinError(value: unknown): value is PinError {
  return value instanceof PinError || (value instanceof Error && value.name === 'PinError');
}

export function emptySnapshot(sessionId: string, at: string): PinSnapshot {
  return { v: PIN_SCHEMA_VERSION, sessionId, pins: [], updatedAt: at };
}
