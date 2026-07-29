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
  taskIdFromReopenedAttentionSourceRef,
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
  /** Task-owned acknowledgement hook. Optional for narrow readers/tests; the
   * daemon wires TaskService so resolution can persist the displayed reopen
   * generation before the Attention item is moved to audit history. */
  ackReopen?(sessionId: string, taskId: string, seq: number, actor: AttentionActor, note?: string): Promise<void>;
}

export interface AddAttentionInput {
  /** Non-daemon callers may only create explicit agent-raised items. */
  source?: AttentionSource;
  sourceRef?: string | null;
  /** Honoured only for trusted daemon source adapters. */
  sourceSeq?: number;
  /** The ask — one line: what the human must decide or do. */
  subject?: string;
  /** Why this needs the human now. Markdown. */
  why?: string;
  /** Background for a reader who has NOT followed this session; expand every
   * codename and term of art. Markdown. */
  context?: string | null;
  /** The concrete action that resolves it, short point form. Markdown. */
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

function validSourceSeq(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AttentionError('invalid', 'sourceSeq must be a safe integer of at least 1');
  }
  return value as number;
}

const sameText = (a: string, b: string): boolean => a.trim() === b.trim();

const sameOptionalText = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '').trim() === (b ?? '').trim();

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
    // The subject is the ask and leads every rendering of the item. A subject
    // that is a paragraph buries the ask, so the shape refuses it up front.
    if (/[\r\n]/u.test(subject)) {
      throw new AttentionError(
        'invalid',
        'subject must be one line stating the ask; put background in context and detail in why/howToResolve',
      );
    }
    const why = requiredText(input.why, 'why', MAX_ATTENTION_DETAIL_LEN);
    const context = optionalText(input.context, 'context', MAX_ATTENTION_DETAIL_LEN);
    const howToResolve = requiredText(input.howToResolve, 'howToResolve', MAX_ATTENTION_DETAIL_LEN);
    const sourceRef = optionalText(input.sourceRef, 'sourceRef', MAX_ATTENTION_SOURCE_REF_LEN);
    const reopenedTaskId = taskIdFromReopenedAttentionSourceRef(sourceRef);
    if (reopenedTaskId !== null && provenance.by !== 'daemon') {
      throw new AttentionError('forbidden', 'task-reopened source references are reserved for the daemon');
    }
    const sourceSeq =
      provenance.by === 'daemon' && reopenedTaskId !== null && input.sourceSeq !== undefined
        ? validSourceSeq(input.sourceSeq)
        : undefined;
    const waitingSince =
      provenance.by === 'daemon' && input.waitingSince !== undefined
        ? validIso(input.waitingSince, 'waitingSince')
        : now();
    const itemWithoutId: Omit<AttentionItem, 'id'> = {
      source,
      sourceRef,
      ...(sourceSeq === undefined ? {} : { sourceSeq }),
      subject,
      why,
      ...(context === null ? {} : { context }),
      waitingSince,
      howToResolve,
      raisedBy: provenance.by,
      raisedBySession: provenance.session,
      raisedByName: provenance.name,
    };

    const mutation = await this.store.mutateWithResult(sessionId, current => {
      if (sourceRef !== null) {
        const existing = current.items.find(item => item.source === source && item.sourceRef === sourceRef);
        if (existing) {
          // A late delivery may describe an older generation than the item the
          // resolver can currently see. Never regress either its token or text.
          if (
            reopenedTaskId !== null &&
            existing.sourceSeq !== undefined &&
            (sourceSeq === undefined || sourceSeq < existing.sourceSeq)
          ) {
            return current;
          }
          if (
            sameText(existing.subject, subject) &&
            sameText(existing.why, why) &&
            sameOptionalText(existing.context, context) &&
            sameText(existing.howToResolve, howToResolve) &&
            (reopenedTaskId === null || existing.sourceSeq === sourceSeq)
          ) {
            return current;
          }
          // A stable source is one request whose explanation may evolve. Keep
          // its id, original wait clock, and provenance while refreshing the
          // human-facing decision context in place.
          return {
            ...current,
            items: current.items.map(item => {
              if (item.id !== existing.id) return item;
              const { context: _dropped, ...withoutContext } = item;
              return {
                ...withoutContext,
                subject,
                why,
                ...(context === null ? {} : { context }),
                howToResolve,
                ...(sourceSeq === undefined ? {} : { sourceSeq }),
              };
            }),
          };
        }
        // Startup queues live events while durable baselines are seeded. If a
        // resolver clears generation R before that queue drains, its duplicate
        // delivery must not recreate the item. The fresh audit row binds this
        // guard to R; a genuinely newer generation still raises normally.
        if (
          reopenedTaskId !== null &&
          sourceSeq !== undefined &&
          current.resolved.some(
            item =>
              item.source === source &&
              item.sourceRef === sourceRef &&
              item.sourceSeq !== undefined &&
              item.sourceSeq >= sourceSeq,
          )
        ) {
          return current;
        }
      }
      const duplicate = current.items.some(
        existing =>
          sourceRef === null &&
          existing.source === source &&
          existing.sourceRef === null &&
          existing.raisedBy === provenance.by &&
          existing.raisedBySession === provenance.session &&
          sameText(existing.subject, subject) &&
          sameText(existing.why, why) &&
          sameOptionalText(existing.context, context) &&
          sameText(existing.howToResolve, howToResolve),
      );
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

  /** Explicitly resolve by id. The human may dismiss anything. An agent may
   * only RETRACT a request it raised itself (honest self-cleanup); it may not
   * dismiss an item raised by the daemon or by another agent — those exist so
   * the human sees them, and clearing one unseen would defeat the ledger.
   * Evidence-driven clears (question answered, task unblocked) stay on the
   * trusted resolveFromSource path, which this guard does not touch. */
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
    const mutation = await this.store.mutateWithResult(authorized.session.id, async current => {
      const target = current.items.find(item => item.id === canonical);
      // A retried resolve is idempotent and may not overwrite the original
      // resolver with whoever happened to retry it.
      if (target === undefined) {
        if (current.resolved.some(item => item.id === canonical)) return current;
        throw new AttentionError('not-found', `no unresolved attention item ${canonical} in this session`);
      }
      const { by, session } = authorized.provenance;
      if (by === 'agent' && !(target.raisedBy === 'agent' && target.raisedBySession === session)) {
        throw new AttentionError(
          'forbidden',
          `an agent may only retract an attention item it raised itself; ${canonical} was raised by ${
            target.raisedBy === 'daemon'
              ? 'the daemon'
              : target.raisedBy === 'human'
                ? 'the human'
                : `agent ${target.raisedByName ?? target.raisedBySession}`
          }. Resolve the underlying cause so its source clears it, or leave it for the human.`,
        );
      }
      await this.acknowledgeReopen(authorized.session.id, target, authorized.provenance, resolutionNote);
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
    const mutation = await this.store.mutateWithResult(session.id, async current => {
      const target = current.items.find(item => item.source === source && item.sourceRef === ref);
      if (target === undefined) return current;
      await this.acknowledgeReopen(session.id, target, provenance, resolutionNote);
      return resolveState(current, target, provenance, resolutionNote);
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

  private async acknowledgeReopen(
    sessionId: string,
    target: AttentionItem,
    provenance: Provenance,
    resolutionNote: string | null,
  ): Promise<void> {
    if (target.raisedBy !== 'daemon' || target.source !== 'agent-raised' || target.sourceSeq === undefined) return;
    const taskId = taskIdFromReopenedAttentionSourceRef(target.sourceRef);
    if (taskId === null || this.deps.ackReopen === undefined) return;
    const actor: AttentionActor =
      provenance.by === 'human'
        ? { actor: 'user' }
        : provenance.by === 'daemon'
          ? { actor: 'daemon' }
          : { actor: provenance.session, actorName: provenance.name };
    await this.deps.ackReopen(sessionId, taskId, target.sourceSeq, actor, resolutionNote ?? undefined);
  }

  /** Drop the transition-only timestamp map after task migration succeeds. */
  async compactLegacyReopenWatermarks(sessionId: string): Promise<AttentionSnapshot> {
    const session = await this.resolveSession(sessionId);
    return this.finishMutation(await this.store.compactLegacyReopenWatermarks(session.id), DAEMON_PROVENANCE);
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
  const resolvedAt = now();
  const resolved: ResolvedAttentionItem = {
    ...target,
    resolvedAt,
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
