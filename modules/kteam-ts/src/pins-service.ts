// PinService — the daemon-side pin manager and the import point for the wiring
// patch. It owns the ONLY writable pin store in the process and enforces the
// rules a shared, agent-writable board needs:
//
//   1. THE DAEMON IS THE AUTHORITY ON PROVENANCE. `by` (+ the agent's session id
//      and callsign) is derived from the RESOLVED actor, never from the request
//      body, so a client cannot sign a human's name to an agent's pin or vice
//      versa. This is the "a pin an agent made must be visibly distinguishable"
//      requirement, enforced at the one place it can be trusted.
//   2. SCOPE TO SELF. An agent may only pin to ITS OWN session; a cross-session
//      write from an agent is refused. The human (no session id) may pin to any
//      session. This is the first anti-spam layer.
//   3. AN AGENT MAY ONLY EDIT/REMOVE ITS OWN PINS. It can tidy up after itself
//      (unpin a merged PR) but can never touch the human's pins.
//   4. CAPS. The 20-pin total cap and the separate agent sub-cap are applied by
//      the store on every write (pins-store.applyCaps), so an agent physically
//      cannot crowd the human off their own board.
//
// After every successful mutation it emits a live `pins.updated` event carrying
// the whole new snapshot, so a reader looking at the sheet on another device sees
// an agent's pin appear at once (pinning-design.md §2: server storage is what
// finally makes pins follow the user between phone and desktop).

import type { KTeamEvent } from './types';
import { now } from './io';
import { PinStore, dedupePins, isSafeSessionId, toPreview, validateNoteText, type PinStoreOptions } from './pins-store';
import {
  MAX_PINS_PER_SESSION,
  PIN_BLOCK_KINDS,
  PinError,
  type Pin,
  type PinActor,
  type PinBlockKind,
  type PinSnapshot,
} from './pins-types';
import type { KTeamPaths } from './paths';

/** The narrow slice of the session world the service needs: does this session
 *  exist? `SessionManager` does not expose `has` directly, so the wiring passes
 *  an adapter (`{ has: id => manager.get(id).then(() => true, () => false) }`).
 *  Kept this narrow so a test stub is one line. */
export interface PinDeps {
  has(sessionId: string): Promise<boolean>;
}

export interface AddPinInput {
  kind: 'note' | 'message';
  /** note */
  text?: string;
  source?: { blockId: string } | null;
  /** message */
  blockId?: string;
  blockKind?: PinBlockKind;
  preview?: string;
  ts?: string;
}

const isBlockKind = (value: unknown): value is PinBlockKind =>
  typeof value === 'string' && (PIN_BLOCK_KINDS as readonly string[]).includes(value);

/** Resolve provenance from the actor. `'user'` / null / blank → the human; any
 *  resolved session id → an agent, with its session id and callsign carried for
 *  attribution. */
function provenance(actor: PinActor): {
  by: 'human' | 'agent';
  createdBy: string | null;
  createdByName: string | null;
  session: string | null;
} {
  const raw = typeof actor.actor === 'string' ? actor.actor.trim() : '';
  if (raw === '' || raw === 'user') return { by: 'human', createdBy: null, createdByName: null, session: null };
  const name = typeof actor.actorName === 'string' && actor.actorName.trim().length > 0 ? actor.actorName.trim() : null;
  return { by: 'agent', createdBy: raw, createdByName: name, session: raw };
}

function uuid(): string {
  return crypto.randomUUID();
}

export class PinService {
  private readonly store: PinStore;
  private readonly listeners = new Set<(event: KTeamEvent) => void>();

  constructor(
    private readonly paths: KTeamPaths,
    private readonly deps: PinDeps,
    options: PinStoreOptions = {},
  ) {
    // The daemon — and ONLY the daemon — gets a writable store.
    this.store = new PinStore(paths, { role: options.role ?? 'daemon' });
  }

  /** Exposed for tests. */
  get pins(): PinStore {
    return this.store;
  }

  /** Subscribe to live `pins.updated` events. The api-server wires its socket
   *  broadcast here so a mutation reaches every connected device. */
  subscribe(listener: (event: KTeamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- reads --------------------------------------------------------------

  async list(sessionId: string): Promise<PinSnapshot> {
    if (!isSafeSessionId(sessionId)) throw new PinError('invalid', `not a valid session id: ${String(sessionId)}`);
    return this.store.snapshot(sessionId);
  }

  // ---- writes -------------------------------------------------------------

  /** Add one pin. `by` and attribution are stamped from the actor. Adds are
   *  idempotent: pinning an already-pinned block, or a note whose text already
   *  exists, is a no-op that returns the current snapshot (so a stuck agent loop
   *  cannot grow the board). Caps are enforced by the store. */
  async add(sessionId: string, input: AddPinInput, actor: PinActor): Promise<PinSnapshot> {
    const prov = await this.authorize(sessionId, actor);
    const at = Date.now();
    let pin: Pin;
    if (input.kind === 'message') {
      if (typeof input.blockId !== 'string' || input.blockId.trim().length === 0) {
        throw new PinError('invalid', 'a message pin needs a blockId');
      }
      if (!isBlockKind(input.blockKind)) {
        throw new PinError('invalid', `blockKind must be one of ${PIN_BLOCK_KINDS.join(', ')}`);
      }
      pin = {
        id: uuid(),
        kind: 'message',
        blockId: input.blockId,
        blockKind: input.blockKind,
        preview: toPreview(typeof input.preview === 'string' ? input.preview : ''),
        at,
        by: prov.by,
        createdBy: prov.createdBy,
        createdByName: prov.createdByName,
        ...(typeof input.ts === 'string' && input.ts ? { ts: input.ts } : {}),
      };
    } else if (input.kind === 'note') {
      const text = validateNoteText(input.text);
      const source =
        input.source &&
        typeof input.source === 'object' &&
        typeof input.source.blockId === 'string' &&
        input.source.blockId
          ? { blockId: input.source.blockId }
          : undefined;
      pin = {
        id: uuid(),
        kind: 'note',
        text,
        at,
        by: prov.by,
        createdBy: prov.createdBy,
        createdByName: prov.createdByName,
        ...(source ? { source } : {}),
      };
    } else {
      throw new PinError('invalid', `unknown pin kind ${String((input as { kind?: unknown }).kind)}`);
    }

    return this.emit(
      await this.store.mutate(sessionId, current => {
        // Idempotent add: an already-pinned block or an identical note is a no-op.
        if (pin.kind === 'message' && current.some(p => p.kind === 'message' && p.blockId === pin.blockId))
          return current;
        if (pin.kind === 'note') {
          const text = pin.text.trim();
          if (current.some(p => p.kind === 'note' && p.text.trim() === text)) return current;
        }
        return [pin, ...current];
      }),
      actor,
    );
  }

  /** Edit a note's text in place, keeping its position and provenance. An agent
   *  may edit only a note it authored. */
  async edit(sessionId: string, id: string, text: string, actor: PinActor): Promise<PinSnapshot> {
    const prov = await this.authorize(sessionId, actor);
    const next = validateNoteText(text);
    return this.emit(
      await this.store.mutate(sessionId, current => {
        const target = current.find(p => p.id === id);
        if (!target) throw new PinError('not-found', `no pin ${id} in this session`);
        if (target.kind !== 'note') throw new PinError('invalid', 'only a note can be edited');
        this.assertMayMutate(target, prov);
        if (target.text === next) return current;
        return current.map(p => (p.id === id && p.kind === 'note' ? { ...p, text: next, at: Date.now() } : p));
      }),
      actor,
    );
  }

  /** Remove one pin. An agent may remove only a pin it authored. Removing a pin
   *  that is not there is a no-op (idempotent), so a retried remove is safe. */
  async remove(sessionId: string, id: string, actor: PinActor): Promise<PinSnapshot> {
    const prov = await this.authorize(sessionId, actor);
    return this.emit(
      await this.store.mutate(sessionId, current => {
        const target = current.find(p => p.id === id);
        if (!target) return current;
        this.assertMayMutate(target, prov);
        return current.filter(p => p.id !== id);
      }),
      actor,
    );
  }

  /** One-time IMPORT of the reader's phase-1 localStorage pins. Only the human
   *  may import (an agent has no localStorage), and imported pins are stamped
   *  `by:'human'` regardless of what the payload claims — the browser is trusted
   *  to carry the reader's own pins, not to assign provenance. Pins whose id or
   *  message block already exists are skipped, so a double-import is safe. */
  async importPins(sessionId: string, incoming: readonly Pin[], actor: PinActor): Promise<PinSnapshot> {
    const prov = await this.authorize(sessionId, actor);
    if (prov.by !== 'human') throw new PinError('forbidden', 'only the human may import browser pins');
    if (incoming.length > MAX_PINS_PER_SESSION * 2) {
      throw new PinError(
        'invalid',
        `import holds ${incoming.length} pins; the maximum accepted is ${MAX_PINS_PER_SESSION * 2}`,
      );
    }
    return this.emit(
      await this.store.mutate(sessionId, current => {
        const haveIds = new Set(current.map(p => p.id));
        const haveBlocks = new Set(
          current.filter((p): p is Extract<Pin, { kind: 'message' }> => p.kind === 'message').map(p => p.blockId),
        );
        const additions: Pin[] = [];
        for (const raw of incoming) {
          if (haveIds.has(raw.id)) continue;
          if (raw.kind === 'message' && haveBlocks.has(raw.blockId)) continue;
          additions.push({ ...raw, by: 'human', createdBy: null, createdByName: null });
          haveIds.add(raw.id);
          if (raw.kind === 'message') haveBlocks.add(raw.blockId);
        }
        // Existing pins first, imports after: the reader's live board keeps its
        // top, and a batch import never reorders what is already there.
        return dedupePins([...current, ...additions]);
      }),
      actor,
    );
  }

  // ---- internals ----------------------------------------------------------

  /** The shared write gate: the session must exist, and an agent may write only
   *  to its own session (scope-to-self). Returns the resolved provenance. */
  private async authorize(sessionId: string, actor: PinActor): Promise<ReturnType<typeof provenance>> {
    if (!isSafeSessionId(sessionId)) throw new PinError('invalid', `not a valid session id: ${String(sessionId)}`);
    const prov = provenance(actor);
    if (prov.session !== null && prov.session !== sessionId) {
      throw new PinError('forbidden', 'an agent may only pin to its own session');
    }
    if (!(await this.deps.has(sessionId).catch(() => false))) {
      throw new PinError('not-found', `no such session ${sessionId}`);
    }
    return prov;
  }

  /** An agent may mutate only a pin it authored; the human may mutate anything. */
  private assertMayMutate(pin: Pin, prov: ReturnType<typeof provenance>): void {
    if (prov.by === 'human') return;
    if (pin.by === 'agent' && pin.createdBy === prov.createdBy) return;
    throw new PinError('forbidden', 'an agent may only change pins it created');
  }

  private emit(snapshot: PinSnapshot, actor: PinActor): PinSnapshot {
    const prov = provenance(actor);
    const event: KTeamEvent = {
      // Sequence 0: this is a live-only liveness signal, never journalled (like
      // terminal.frame). The durable copy is pins.json; the event just tells
      // connected devices to converge. Consumers must not apply a monotonic
      // sequence filter to it (store.tsx handleEvent honours this).
      sequence: 0,
      time: now(),
      sessionId: snapshot.sessionId,
      turn: 0,
      type: 'pins.updated',
      source: prov.session ? `peer:${prov.session}` : 'client',
      data: snapshot,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* one bad subscriber never fails a mutation */
      }
    }
    return snapshot;
  }
}
