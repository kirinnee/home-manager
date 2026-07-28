// Daemon-side attention manager. It is the sole writable owner and the
// authority for provenance, session scoping, identical-add dedupe, capacity,
// explicit resolution, and whole-snapshot live events.

import { now } from './io';
import type { KTeamPaths } from './paths';
import type { KTeamEvent } from './types';
import {
  AttentionStore,
  isSafeAttentionSessionId,
  type AttentionMutation,
  type AttentionState,
  type AttentionStoreOptions,
} from './attention-store';
import {
  MAX_ATTENTION_DETAIL_LEN,
  MAX_ATTENTION_SOURCE_REF_LEN,
  MAX_ATTENTION_SUBJECT_LEN,
  ATTENTION_SOURCES,
  AttentionError,
  parseAttentionId,
  type AttentionId,
  type AttentionActor,
  type AttentionBy,
  type AttentionItem,
  type AttentionSnapshot,
  type AttentionSource,
  type ResolvedAttentionItem,
} from './attention-types';

export interface AttentionDeps {
  /** Resolve ids and human-friendly aliases to the canonical session whose
   * directory owns the board. Returning a boolean here is unsafe: an alias can
   * pass existence checks and then become a phantom directory name. */
  resolve(sessionRef: string): Promise<{ id: string; name: string | null } | null>;
}

export interface AddAttentionInput {
  /** Non-daemon callers may only create explicit agent-raised items. */
  source?: AttentionSource;
  sourceRef?: string | null;
  subject?: string;
  why?: string;
  howToResolve?: string;
  /** Honoured only for the daemon's source adapters. Client adds are stamped
   * at receipt so an agent cannot backdate itself to the top of the list. */
  waitingSince?: string;
}

interface Provenance {
  by: AttentionBy;
  session: string | null;
  name: string | null;
}

interface SessionIdentity {
  id: string;
  name: string | null;
}

interface AuthorizedMutation {
  session: SessionIdentity;
  provenance: Provenance;
}

const DAEMON_PROVENANCE: Provenance = { by: 'daemon', session: null, name: null };

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AttentionError('invalid', `${label} is required and may not be blank`);
  }
  if (value.length > max) {
    throw new AttentionError('too-long', `${label} is ${value.length} characters; the maximum is ${max}`);
  }
  return value;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new AttentionError('invalid', `${label} must be a string`);
  if (value.length > max) {
    throw new AttentionError('too-long', `${label} is ${value.length} characters; the maximum is ${max}`);
  }
  return value;
}

function validIso(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new AttentionError('invalid', `${label} must be an ISO timestamp`);
  }
  return value;
}

const sameText = (a: string, b: string): boolean => a.trim() === b.trim();

export class AttentionService {
  private readonly store: AttentionStore;
  private readonly listeners = new Set<(event: KTeamEvent) => void>();

  constructor(
    paths: KTeamPaths,
    private readonly deps: AttentionDeps,
    options: AttentionStoreOptions = {},
  ) {
    this.store = new AttentionStore(paths, { role: options.role ?? 'daemon' });
  }

  get attention(): AttentionStore {
    return this.store;
  }

  subscribe(listener: (event: KTeamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(sessionId: string): Promise<AttentionSnapshot> {
    const session = await this.resolveSession(sessionId);
    return this.store.snapshot(session.id);
  }

  async count(sessionId: string): Promise<number> {
    const session = await this.resolveSession(sessionId);
    return this.store.count(session.id);
  }

  /** Add one unresolved item. Stable sourceRef wins dedupe for daemon-fed
   * sources; otherwise an identical open request from the same provenance is a
   * no-op. Resolved history never suppresses a genuinely re-raised need. */
  async add(sessionId: string, input: AddAttentionInput, actor: AttentionActor): Promise<AttentionSnapshot> {
    const authorized = await this.authorize(sessionId, actor);
    return this.addCanonical(authorized.session.id, input, authorized.provenance);
  }

  /** Trusted in-process source adapter entry. HTTP callers cannot construct
   * daemon provenance: api-server only reaches `add`, whose actor resolver
   * rejects the reserved daemon identity. */
  async addFromSource(sessionId: string, input: AddAttentionInput): Promise<AttentionSnapshot> {
    const session = await this.resolveSession(sessionId);
    return this.addCanonical(session.id, input, DAEMON_PROVENANCE);
  }

  private async addCanonical(
    sessionId: string,
    input: AddAttentionInput,
    provenance: Provenance,
  ): Promise<AttentionSnapshot> {
    const source = input.source ?? 'agent-raised';
    if (!(ATTENTION_SOURCES as readonly string[]).includes(source)) {
      throw new AttentionError('invalid', `source must be one of ${ATTENTION_SOURCES.join(', ')}`);
    }
    if (source !== 'agent-raised' && provenance.by !== 'daemon') {
      throw new AttentionError('forbidden', `only the daemon may raise a ${source} attention item`);
    }
    const subject = requiredText(input.subject, 'subject', MAX_ATTENTION_SUBJECT_LEN);
    const why = requiredText(input.why, 'why', MAX_ATTENTION_DETAIL_LEN);
    const howToResolve = requiredText(input.howToResolve, 'howToResolve', MAX_ATTENTION_DETAIL_LEN);
    const sourceRef = optionalText(input.sourceRef, 'sourceRef', MAX_ATTENTION_SOURCE_REF_LEN);
    const waitingSince =
      provenance.by === 'daemon' && input.waitingSince !== undefined
        ? validIso(input.waitingSince, 'waitingSince')
        : now();
    const itemWithoutId: Omit<AttentionItem, 'id'> = {
      source,
      sourceRef,
      subject,
      why,
      waitingSince,
      howToResolve,
      raisedBy: provenance.by,
      raisedBySession: provenance.session,
      raisedByName: provenance.name,
    };

    const mutation = await this.store.mutateWithResult(sessionId, current => {
      const duplicate = current.items.some(existing => {
        if (sourceRef !== null) return existing.source === source && existing.sourceRef === sourceRef;
        return (
          existing.source === source &&
          existing.sourceRef === null &&
          existing.raisedBy === provenance.by &&
          existing.raisedBySession === provenance.session &&
          sameText(existing.subject, subject) &&
          sameText(existing.why, why) &&
          sameText(existing.howToResolve, howToResolve)
        );
      });
      if (duplicate) return current;
      if (current.nextId >= Number.MAX_SAFE_INTEGER) {
        throw new AttentionError('full', 'this session has exhausted its attention id sequence');
      }
      const id = `A${current.nextId}` as AttentionId;
      return {
        ...current,
        nextId: current.nextId + 1,
        items: [...current.items, { id, ...itemWithoutId }],
      };
    });
    return this.finishMutation(mutation, provenance);
  }

  /** Explicitly resolve by id. Both humans and agents may resolve; agents stay
   * scoped to their own session, and every clear is retained in the audit. */
  async resolve(
    sessionId: string,
    id: string,
    note: string | null | undefined,
    actor: AttentionActor,
  ): Promise<AttentionSnapshot> {
    const authorized = await this.authorize(sessionId, actor);
    const canonical = parseAttentionId(id);
    if (canonical === null) throw new AttentionError('invalid', 'attention id must look like A3 or ?A3');
    const resolutionNote = optionalText(note, 'resolution note', MAX_ATTENTION_DETAIL_LEN);
    const mutation = await this.store.mutateWithResult(authorized.session.id, current => {
      const target = current.items.find(item => item.id === canonical);
      // A retried resolve is idempotent and may not overwrite the original
      // resolver with whoever happened to retry it.
      if (target === undefined) {
        if (current.resolved.some(item => item.id === canonical)) return current;
        throw new AttentionError('not-found', `no unresolved attention item ${canonical} in this session`);
      }
      return resolveState(current, target, authorized.provenance, resolutionNote);
    });
    return this.finishMutation(mutation, authorized.provenance);
  }

  /** Trusted in-process resolution by stable source identity (task id,
   * question tool-use id, permission request id). The event actor remains the
   * recorded resolver, but the source adapter—not that actor—owns the mutation;
   * this lets a lead answer a teammate's question without granting agents a
   * general cross-session write path. Missing is an idempotent no-op. */
  async resolveFromSource(
    sessionId: string,
    source: AttentionSource,
    sourceRef: string,
    note: string | null | undefined,
    actor: AttentionActor,
  ): Promise<AttentionSnapshot> {
    const session = await this.resolveSession(sessionId);
    const provenance = await this.sourceProvenance(actor);
    const ref = requiredText(sourceRef, 'sourceRef', MAX_ATTENTION_SOURCE_REF_LEN);
    const resolutionNote = optionalText(note, 'resolution note', MAX_ATTENTION_DETAIL_LEN);
    const mutation = await this.store.mutateWithResult(session.id, current => {
      const target = current.items.find(item => item.source === source && item.sourceRef === ref);
      return target === undefined ? current : resolveState(current, target, provenance, resolutionNote);
    });
    return this.finishMutation(mutation, provenance);
  }

  private async authorize(sessionRef: string, actor: AttentionActor): Promise<AuthorizedMutation> {
    const session = await this.resolveSession(sessionRef);
    const provenance = await this.actorProvenance(actor, false);
    if (provenance.session !== null && provenance.session !== session.id) {
      throw new AttentionError('forbidden', 'an agent may only change attention items in its own session');
    }
    return { session, provenance };
  }

  private async sourceProvenance(actor: AttentionActor): Promise<Provenance> {
    const raw = typeof actor.actor === 'string' ? actor.actor.trim() : '';
    if (raw === 'daemon') return DAEMON_PROVENANCE;
    return this.actorProvenance(actor, true);
  }

  private async actorProvenance(actor: AttentionActor, sourceEvent: boolean): Promise<Provenance> {
    const raw = typeof actor.actor === 'string' ? actor.actor.trim() : '';
    if (raw === '' || raw === 'user') return { by: 'human', session: null, name: null };
    if (raw === 'daemon') {
      throw new AttentionError('forbidden', 'daemon is a reserved in-process attention actor');
    }
    const resolved = await this.resolveSession(raw).catch(error => {
      // An already-journalled source event can outlive the session that caused
      // it. Keep the raw actor trace rather than relabelling it daemon/human.
      if (sourceEvent && error instanceof AttentionError && error.code === 'not-found') return null;
      throw error;
    });
    if (resolved === null) {
      const suppliedName =
        typeof actor.actorName === 'string' && actor.actorName.trim().length > 0 ? actor.actorName.trim() : null;
      return { by: 'agent', session: raw, name: suppliedName };
    }
    return { by: 'agent', session: resolved.id, name: resolved.name };
  }

  private async resolveSession(sessionRef: string): Promise<SessionIdentity> {
    if (!isSafeAttentionSessionId(sessionRef)) {
      throw new AttentionError('invalid', `not a valid session id: ${String(sessionRef)}`);
    }
    const resolved = await this.deps.resolve(sessionRef).catch(() => null);
    if (resolved === null) throw new AttentionError('not-found', `no such session ${sessionRef}`);
    if (!isSafeAttentionSessionId(resolved.id)) {
      throw new AttentionError('invalid', `session resolver returned an invalid id for ${sessionRef}`);
    }
    const name = typeof resolved.name === 'string' && resolved.name.trim() ? resolved.name.trim() : null;
    return { id: resolved.id, name };
  }

  private finishMutation(mutation: AttentionMutation, provenance: Provenance): AttentionSnapshot {
    return mutation.changed ? this.emit(mutation.snapshot, provenance) : mutation.snapshot;
  }

  private emit(snapshot: AttentionSnapshot, provenance: Provenance): AttentionSnapshot {
    const event: KTeamEvent<AttentionSnapshot> = {
      sequence: 0,
      time: now(),
      sessionId: snapshot.sessionId,
      turn: 0,
      type: 'attention.updated',
      source:
        provenance.by === 'agent' ? `peer:${provenance.session}` : provenance.by === 'human' ? 'client' : 'daemon',
      data: snapshot,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A live reader is convergence only; it never rolls storage back.
      }
    }
    return snapshot;
  }
}

function resolveState(
  current: AttentionState,
  target: AttentionItem,
  provenance: Provenance,
  resolutionNote: string | null,
): AttentionState {
  const resolved: ResolvedAttentionItem = {
    ...target,
    resolvedAt: now(),
    resolvedBy: provenance.by,
    resolvedBySession: provenance.session,
    resolvedByName: provenance.name,
    resolutionNote,
  };
  return {
    ...current,
    items: current.items.filter(item => item.id !== target.id),
    resolved: [resolved, ...current.resolved],
  };
}
