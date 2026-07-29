// Client cache for daemon-owned per-session attention snapshots. All mutation
// policy lives server-side; this module fetches a cheap count for fleet badges,
// hydrates the full board on demand, applies whole-snapshot live events, and
// sends explicit resolve actions.

import { TOKEN } from './api';

/** `permission` stays in the reader's union for records written by older
 * daemons, even though the daemon no longer produces that source. */
export type AttentionSource = 'task' | 'question' | 'permission' | 'agent-raised';
export type AttentionBy = 'human' | 'agent' | 'daemon';
export type AttentionId = `A${number}`;

/** The four attention kinds, by what the human DOES (&F138). */
export interface AttentionAskOption {
  label: string;
  description?: string;
}

export type AttentionAsk =
  | { kind: 'permission' }
  | { kind: 'multiple-choice'; options: AttentionAskOption[] }
  | { kind: 'answer-review' }
  | { kind: 'open-question' };

export type AttentionResponse =
  | { kind: 'permission'; decision: 'approve' | 'reject' }
  | { kind: 'multiple-choice'; choice: string }
  | { kind: 'answer-review'; verdict: 'good' }
  | { kind: 'answer-review'; verdict: 'clarify'; clarification: string }
  | { kind: 'open-question'; answer: string };

export type AttentionDisposition = 'done' | 'dismissed';

/** One human-readable line for audit rendering. */
export function describeAttentionResponse(response: AttentionResponse): string {
  switch (response.kind) {
    case 'permission':
      return response.decision === 'approve' ? 'Approved' : 'Rejected';
    case 'multiple-choice':
      return `Chose "${response.choice}"`;
    case 'answer-review':
      return response.verdict === 'good' ? 'Answer accepted' : `Clarification requested: ${response.clarification}`;
    case 'open-question':
      return `Answered: ${response.answer}`;
  }
}

export function parseAttentionAsk(value: unknown): AttentionAsk | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = raw['kind'];
  if (kind === 'permission' || kind === 'answer-review' || kind === 'open-question') return { kind };
  if (kind !== 'multiple-choice' || !Array.isArray(raw['options']) || raw['options'].length < 2) return null;
  const options: AttentionAskOption[] = [];
  for (const entry of raw['options']) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const rawOption = entry as Record<string, unknown>;
    if (typeof rawOption['label'] !== 'string' || !rawOption['label'].trim()) return null;
    const description = rawOption['description'];
    if (description !== undefined && (typeof description !== 'string' || !description.trim())) return null;
    options.push({ label: rawOption['label'], ...(description === undefined ? {} : { description }) });
  }
  return { kind: 'multiple-choice', options };
}

export function parseAttentionResponse(value: unknown): AttentionResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  switch (raw['kind']) {
    case 'permission':
      return raw['decision'] === 'approve' || raw['decision'] === 'reject'
        ? { kind: 'permission', decision: raw['decision'] }
        : null;
    case 'multiple-choice':
      return typeof raw['choice'] === 'string' && raw['choice'].trim()
        ? { kind: 'multiple-choice', choice: raw['choice'] }
        : null;
    case 'answer-review':
      if (raw['verdict'] === 'good') return { kind: 'answer-review', verdict: 'good' };
      return raw['verdict'] === 'clarify' && typeof raw['clarification'] === 'string' && raw['clarification'].trim()
        ? { kind: 'answer-review', verdict: 'clarify', clarification: raw['clarification'] }
        : null;
    case 'open-question':
      return typeof raw['answer'] === 'string' && raw['answer'].trim()
        ? { kind: 'open-question', answer: raw['answer'] }
        : null;
    default:
      return null;
  }
}

const ATTENTION_ID = /^A[1-9][0-9]*$/u;

export function attentionReference(id: AttentionId): `!${AttentionId}` {
  return `!${id}`;
}

export interface AttentionItem {
  id: AttentionId;
  source: AttentionSource;
  sourceRef: string | null;
  /** The ask — one line: what the human must decide or do. */
  subject: string;
  /** Why this needs the human now. Markdown. */
  why: string;
  /** Background for a reader who has not followed this session. Markdown.
   * Optional: records predate the field. */
  context?: string;
  waitingSince: string;
  /** The concrete action that resolves it. Markdown. */
  howToResolve: string;
  /** What the human is asked to do, with its answer options structural.
   * Absent on legacy records and on self-clearing daemon items. */
  ask?: AttentionAsk;
  raisedBy: AttentionBy;
  raisedBySession: string | null;
  raisedByName: string | null;
}

export interface ResolvedAttentionItem extends AttentionItem {
  resolvedAt: string;
  resolvedBy: AttentionBy;
  resolvedBySession: string | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
  /** The structured answer given at resolution, when the item carried an ask. */
  response?: AttentionResponse;
  /** `done` vs `dismissed`; absent on rows written before the field existed. */
  disposition?: AttentionDisposition;
}

export interface AttentionSnapshot {
  v: number;
  sessionId: string;
  items: AttentionItem[];
  resolved: ResolvedAttentionItem[];
  count: number;
  parseErrors: number;
  updatedAt: string;
}

export interface AttentionCache {
  v: 1;
  sessions: Record<string, AttentionSnapshot>;
  counts: Record<string, number>;
}

export type AttentionSessionStatus = 'idle' | 'loading' | 'ready' | 'error';

export const emptyAttentionCache = (): AttentionCache => ({ v: 1, sessions: {}, counts: {} });

const SOURCES = new Set<AttentionSource>(['task', 'question', 'permission', 'agent-raised']);
const BY = new Set<AttentionBy>(['human', 'agent', 'daemon']);

const nullableText = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' && value ? value : undefined;

export function parseAttentionItem(value: unknown): AttentionItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const sourceRef = nullableText(raw['sourceRef']);
  const context = raw['context'] === undefined ? null : nullableText(raw['context']);
  const ask = raw['ask'] === undefined ? undefined : parseAttentionAsk(raw['ask']);
  const raisedBySession = nullableText(raw['raisedBySession']);
  const raisedByName = nullableText(raw['raisedByName']);
  if (
    ask === null ||
    typeof raw['id'] !== 'string' ||
    !ATTENTION_ID.test(raw['id']) ||
    !Number.isSafeInteger(Number(raw['id'].slice(1))) ||
    typeof raw['source'] !== 'string' ||
    !SOURCES.has(raw['source'] as AttentionSource) ||
    sourceRef === undefined ||
    typeof raw['subject'] !== 'string' ||
    !raw['subject'].trim() ||
    typeof raw['why'] !== 'string' ||
    !raw['why'].trim() ||
    context === undefined ||
    typeof raw['waitingSince'] !== 'string' ||
    !Number.isFinite(Date.parse(raw['waitingSince'])) ||
    typeof raw['howToResolve'] !== 'string' ||
    !raw['howToResolve'].trim() ||
    typeof raw['raisedBy'] !== 'string' ||
    !BY.has(raw['raisedBy'] as AttentionBy) ||
    raisedBySession === undefined ||
    raisedByName === undefined
  ) {
    return null;
  }
  if ((raw['raisedBy'] === 'agent') !== (raisedBySession !== null)) return null;
  return {
    id: raw['id'] as AttentionId,
    source: raw['source'] as AttentionSource,
    sourceRef,
    subject: raw['subject'],
    why: raw['why'],
    ...(context === null ? {} : { context }),
    waitingSince: raw['waitingSince'],
    howToResolve: raw['howToResolve'],
    ...(ask === undefined ? {} : { ask }),
    raisedBy: raw['raisedBy'] as AttentionBy,
    raisedBySession,
    raisedByName,
  };
}

export function parseResolvedAttentionItem(value: unknown): ResolvedAttentionItem | null {
  const item = parseAttentionItem(value);
  if (!item || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const resolvedBySession = nullableText(raw['resolvedBySession']);
  const resolvedByName = nullableText(raw['resolvedByName']);
  const resolutionNote = nullableText(raw['resolutionNote']);
  const response = raw['response'] === undefined ? undefined : parseAttentionResponse(raw['response']);
  const disposition = raw['disposition'];
  if (
    typeof raw['resolvedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(raw['resolvedAt'])) ||
    typeof raw['resolvedBy'] !== 'string' ||
    !BY.has(raw['resolvedBy'] as AttentionBy) ||
    resolvedBySession === undefined ||
    resolvedByName === undefined ||
    resolutionNote === undefined ||
    response === null ||
    (disposition !== undefined && disposition !== 'done' && disposition !== 'dismissed')
  ) {
    return null;
  }
  if ((raw['resolvedBy'] === 'agent') !== (resolvedBySession !== null)) return null;
  return {
    ...item,
    resolvedAt: raw['resolvedAt'],
    resolvedBy: raw['resolvedBy'] as AttentionBy,
    resolvedBySession,
    resolvedByName,
    resolutionNote,
    ...(response === undefined ? {} : { response }),
    ...(disposition === undefined ? {} : { disposition: disposition as AttentionDisposition }),
  };
}

export function parseAttentionSnapshot(value: unknown, expectedSessionId?: string): AttentionSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw['v'] !== 1 ||
    typeof raw['sessionId'] !== 'string' ||
    !raw['sessionId'] ||
    (expectedSessionId !== undefined && raw['sessionId'] !== expectedSessionId) ||
    !Array.isArray(raw['items']) ||
    !Array.isArray(raw['resolved']) ||
    !Number.isSafeInteger(raw['count']) ||
    (raw['count'] as number) < 0 ||
    !Number.isSafeInteger(raw['parseErrors']) ||
    (raw['parseErrors'] as number) < 0 ||
    typeof raw['updatedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(raw['updatedAt']))
  ) {
    return null;
  }
  const items = raw['items'].map(parseAttentionItem).filter((item): item is AttentionItem => item !== null);
  const resolved = raw['resolved']
    .map(parseResolvedAttentionItem)
    .filter((item): item is ResolvedAttentionItem => item !== null);
  // The daemon promises a whole snapshot. A partial client parse is an error,
  // not an apparently trustworthy shorter list.
  if (items.length !== raw['items'].length || resolved.length !== raw['resolved'].length) return null;
  if (raw['count'] !== items.length) return null;
  return {
    v: 1,
    sessionId: raw['sessionId'],
    items,
    resolved,
    count: raw['count'] as number,
    parseErrors: raw['parseErrors'] as number,
    updatedAt: raw['updatedAt'],
  };
}

function pathFor(sessionId: string, countOnly = false): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/attention${countOnly ? '?count=1' : ''}`;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (init?.body) headers.set('content-type', 'application/json');
  if (method !== 'GET') headers.set('x-kteam-request-id', crypto.randomUUID());
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const message = await response
      .json()
      .then(body =>
        body && typeof body === 'object' && 'error' in body ? String(body.error) : `HTTP ${response.status}`,
      )
      .catch(() => `HTTP ${response.status}`);
    throw new Error(message);
  }
  return response.json();
}

type Listener = () => void;

class AttentionClientStore {
  private snapshot: AttentionCache = emptyAttentionCache();
  private readonly listeners = new Set<Listener>();
  private readonly statuses = new Map<string, AttentionSessionStatus>();
  private readonly fullInflight = new Map<string, Promise<void>>();
  private readonly countInflight = new Map<string, Promise<void>>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AttentionCache => this.snapshot;

  status(sessionId: string): AttentionSessionStatus {
    return this.statuses.get(sessionId) ?? 'idle';
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private setStatus(sessionId: string, status: AttentionSessionStatus): void {
    if (this.statuses.get(sessionId) === status) return;
    this.statuses.set(sessionId, status);
    this.emit();
  }

  applyServerSnapshot(sessionId: string, value: unknown): boolean {
    const parsed = parseAttentionSnapshot(value, sessionId);
    if (!parsed) {
      this.setStatus(sessionId, 'error');
      return false;
    }
    this.snapshot = {
      v: 1,
      sessions: { ...this.snapshot.sessions, [sessionId]: parsed },
      counts: { ...this.snapshot.counts, [sessionId]: parsed.count },
    };
    this.setStatus(sessionId, 'ready');
    this.emit();
    return true;
  }

  hydrateCount(sessionId: string): Promise<void> {
    if (!sessionId || this.snapshot.counts[sessionId] !== undefined) return Promise.resolve();
    const existing = this.countInflight.get(sessionId);
    if (existing) return existing;
    const run = (async () => {
      try {
        const raw = (await request(pathFor(sessionId, true))) as Record<string, unknown>;
        if (raw['sessionId'] !== sessionId || !Number.isSafeInteger(raw['count']) || (raw['count'] as number) < 0) {
          throw new Error('invalid attention count');
        }
        this.snapshot = {
          ...this.snapshot,
          counts: { ...this.snapshot.counts, [sessionId]: raw['count'] as number },
        };
        this.emit();
      } catch {
        // A missing badge is safer than rendering zero as a false assertion.
      } finally {
        this.countInflight.delete(sessionId);
      }
    })();
    this.countInflight.set(sessionId, run);
    return run;
  }

  hydrate(sessionId: string): Promise<void> {
    if (!sessionId) return Promise.resolve();
    const existing = this.fullInflight.get(sessionId);
    if (existing) return existing;
    if (this.statuses.get(sessionId) === 'ready') return Promise.resolve();
    this.setStatus(sessionId, 'loading');
    const run = (async () => {
      try {
        const body = await request(pathFor(sessionId));
        if (!this.applyServerSnapshot(sessionId, body)) throw new Error('invalid attention snapshot');
      } catch {
        this.setStatus(sessionId, 'error');
      } finally {
        this.fullInflight.delete(sessionId);
      }
    })();
    this.fullInflight.set(sessionId, run);
    return run;
  }

  async resolve(sessionId: string, id: string, note = 'Resolved from the browser.'): Promise<void> {
    const body = await request(pathFor(sessionId), {
      method: 'POST',
      body: JSON.stringify({ action: 'resolve', id, note }),
    });
    if (!this.applyServerSnapshot(sessionId, body))
      throw new Error('the daemon returned an invalid attention snapshot');
  }

  /** Answer an item's structured ask (&F138). The daemon validates the answer
   * against the item's own ask shape and records it on the audit row. */
  async respond(sessionId: string, id: string, response: AttentionResponse): Promise<void> {
    const body = await request(pathFor(sessionId), {
      method: 'POST',
      body: JSON.stringify({ action: 'resolve', id, response }),
    });
    if (!this.applyServerSnapshot(sessionId, body))
      throw new Error('the daemon returned an invalid attention snapshot');
  }

  /** Explicit dismissal (&F139) — recorded with disposition 'dismissed' and
   * the server-resolved actor, never as an answer. */
  async dismiss(sessionId: string, id: string, note = 'Dismissed from the browser.'): Promise<void> {
    const body = await request(pathFor(sessionId), {
      method: 'POST',
      body: JSON.stringify({ action: 'dismiss', id, note }),
    });
    if (!this.applyServerSnapshot(sessionId, body))
      throw new Error('the daemon returned an invalid attention snapshot');
  }

  resetForTest(): void {
    this.snapshot = emptyAttentionCache();
    this.statuses.clear();
    this.fullInflight.clear();
    this.countInflight.clear();
    this.emit();
  }
}

export const attentionStore = new AttentionClientStore();

export function sessionAttention(cache: AttentionCache, sessionId: string): AttentionItem[] {
  return cache.sessions[sessionId]?.items ?? [];
}

export function sessionAttentionCount(cache: AttentionCache, sessionId: string): number {
  return cache.counts[sessionId] ?? cache.sessions[sessionId]?.count ?? 0;
}
