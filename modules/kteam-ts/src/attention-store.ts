// Per-session attention storage. One `<sessionDir>/attention.json` file is
// daemon-owned and written by atomic temp+rename under a per-session
// SerialQueue. Read-modify-write stays inside the lock, so simultaneous raises
// and resolutions cannot lose each other or tear the file.

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { atomicJson, now } from './io';
import { sessionDir, type KTeamPaths } from './paths';
import { SerialQueue } from './tasks-store';
import {
  MAX_AGENT_ATTENTION_PER_SESSION,
  MAX_ATTENTION_DETAIL_LEN,
  MAX_ATTENTION_PER_SESSION,
  MAX_ATTENTION_RESOLUTIONS,
  MAX_ATTENTION_SOURCE_REF_LEN,
  MAX_ATTENTION_SUBJECT_LEN,
  ATTENTION_SCHEMA_VERSION,
  ATTENTION_SOURCES,
  AttentionError,
  emptyAttentionSnapshot,
  parseAttentionId,
  taskIdFromReopenedAttentionSourceRef,
  type AttentionBy,
  type AttentionItem,
  type AttentionSnapshot,
  type AttentionSource,
  type ResolvedAttentionItem,
} from './attention-types';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const isSafeAttentionSessionId = (value: unknown): value is string =>
  typeof value === 'string' && SESSION_ID.test(value);

export function attentionFile(paths: KTeamPaths, sessionId: string): string {
  return `${sessionDir(paths, sessionId)}/attention.json`;
}

export interface AttentionFile {
  v: number;
  sessionId: string;
  /** Next monotonic per-session id. Keeping this outside the bounded audit
   * prevents an old id from ever being reused after history truncation. */
  nextId: number;
  items: AttentionItem[];
  resolved: ResolvedAttentionItem[];
  /** @deprecated Legacy-read only until startup migrates it onto task records. */
  reopenResolvedAt?: Record<string, string>;
  count: number;
  updatedAt: string;
}

export interface ParsedAttentionFile {
  file: AttentionFile;
  parseErrors: number;
  parseErrorIds: string[];
  fatal: boolean;
}

export interface AttentionRead extends ParsedAttentionFile {
  exists: boolean;
}

export interface AttentionState {
  nextId: number;
  items: AttentionItem[];
  resolved: ResolvedAttentionItem[];
  reopenResolvedAt?: Record<string, string>;
}

export interface AttentionMutation {
  snapshot: AttentionSnapshot;
  /** False for an idempotent dedupe/resolve retry. A no-op neither rewrites
   * the durable file nor emits a misleading live update. */
  changed: boolean;
}

function emptyFile(sessionId: string, at = now()): AttentionFile {
  return {
    v: ATTENTION_SCHEMA_VERSION,
    sessionId,
    nextId: 1,
    items: [],
    resolved: [],
    count: 0,
    updatedAt: at,
  };
}

const isSource = (value: unknown): value is AttentionSource =>
  typeof value === 'string' && (ATTENTION_SOURCES as readonly string[]).includes(value);

const isBy = (value: unknown): value is AttentionBy => value === 'human' || value === 'agent' || value === 'daemon';

const requiredText = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : null;

const optionalText = (value: unknown, max: number): string | null | undefined => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return undefined;
  return value;
};

const iso = (value: unknown): string | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

function parseReopenResolvedAt(value: unknown): { value: Record<string, string> | undefined; errors: string[] } {
  if (value === undefined) return { value: undefined, errors: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { value: undefined, errors: ['<reopenResolvedAt>'] };
  }
  const valid: Array<[string, string]> = [];
  const errors: string[] = [];
  for (const [id, rawAt] of Object.entries(value as Record<string, unknown>)) {
    const taskId = taskIdFromReopenedAttentionSourceRef(`task-reopened:${id}`);
    const at = iso(rawAt);
    if (taskId !== id || at === null) {
      errors.push(`<reopenResolvedAt:${id}>`);
      continue;
    }
    valid.push([id, at]);
  }
  return { value: Object.fromEntries(valid), errors };
}

/** Parse one active item. Every required field is checked independently. */
export function parseAttentionItem(value: unknown): AttentionItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = parseAttentionId(raw['id']);
  const source = raw['source'];
  const sourceRef = optionalText(raw['sourceRef'], MAX_ATTENTION_SOURCE_REF_LEN);
  const rawSourceSeq = raw['sourceSeq'];
  const sourceSeq =
    rawSourceSeq === undefined
      ? undefined
      : Number.isSafeInteger(rawSourceSeq) && (rawSourceSeq as number) >= 1
        ? (rawSourceSeq as number)
        : null;
  const subject = requiredText(raw['subject'], MAX_ATTENTION_SUBJECT_LEN);
  const why = requiredText(raw['why'], MAX_ATTENTION_DETAIL_LEN);
  const context = optionalText(raw['context'], MAX_ATTENTION_DETAIL_LEN);
  const waitingSince = iso(raw['waitingSince']);
  const howToResolve = requiredText(raw['howToResolve'], MAX_ATTENTION_DETAIL_LEN);
  const raisedBy = raw['raisedBy'];
  const raisedBySession = optionalText(raw['raisedBySession'], 128);
  const raisedByName = optionalText(raw['raisedByName'], 128);
  if (
    id === null ||
    !isSource(source) ||
    sourceRef === undefined ||
    sourceSeq === null ||
    subject === null ||
    why === null ||
    context === undefined ||
    waitingSince === null ||
    howToResolve === null ||
    !isBy(raisedBy) ||
    raisedBySession === undefined ||
    raisedByName === undefined
  ) {
    return null;
  }
  if (raisedBy === 'agent' && raisedBySession === null) return null;
  if (raisedBy !== 'agent' && raisedBySession !== null) return null;
  return {
    id,
    source,
    sourceRef,
    ...(sourceSeq === undefined ? {} : { sourceSeq }),
    subject,
    why,
    ...(context === null ? {} : { context }),
    waitingSince,
    howToResolve,
    raisedBy,
    raisedBySession,
    raisedByName,
  };
}

export function parseResolvedAttentionItem(value: unknown): ResolvedAttentionItem | null {
  const item = parseAttentionItem(value);
  if (item === null || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const resolvedAt = iso(raw['resolvedAt']);
  const resolvedBy = raw['resolvedBy'];
  const resolvedBySession = optionalText(raw['resolvedBySession'], 128);
  const resolvedByName = optionalText(raw['resolvedByName'], 128);
  const resolutionNote = optionalText(raw['resolutionNote'], MAX_ATTENTION_DETAIL_LEN);
  if (
    resolvedAt === null ||
    !isBy(resolvedBy) ||
    resolvedBySession === undefined ||
    resolvedByName === undefined ||
    resolutionNote === undefined
  ) {
    return null;
  }
  if (resolvedBy === 'agent' && resolvedBySession === null) return null;
  if (resolvedBy !== 'agent' && resolvedBySession !== null) return null;
  return { ...item, resolvedAt, resolvedBy, resolvedBySession, resolvedByName, resolutionNote };
}

const idNumber = (item: AttentionItem): number => Number(item.id.slice(1));

const compareOpen = (a: AttentionItem, b: AttentionItem): number =>
  Date.parse(a.waitingSince) - Date.parse(b.waitingSince) || idNumber(a) - idNumber(b);

const compareResolved = (a: ResolvedAttentionItem, b: ResolvedAttentionItem): number =>
  Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt) || idNumber(a) - idNumber(b);

/** Parse a whole file. A malformed entry is surfaced in parseErrors, and a
 * writer will refuse to rewrite that file until it is repaired. */
export function parseAttentionFile(rawText: string | null, expectedSessionId: string): ParsedAttentionFile {
  const empty = emptyFile(expectedSessionId);
  if (rawText === null) return { file: empty, parseErrors: 0, parseErrorIds: [], fatal: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { file: empty, parseErrors: 1, parseErrorIds: ['<file>'], fatal: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { file: empty, parseErrors: 1, parseErrorIds: ['<file>'], fatal: true };
  }
  const raw = parsed as Record<string, unknown>;
  if (
    raw['v'] !== ATTENTION_SCHEMA_VERSION ||
    raw['sessionId'] !== expectedSessionId ||
    !Array.isArray(raw['items']) ||
    !Array.isArray(raw['resolved'])
  ) {
    return { file: empty, parseErrors: 1, parseErrorIds: ['<file>'], fatal: true };
  }

  const items: AttentionItem[] = [];
  const resolved: ResolvedAttentionItem[] = [];
  const seen = new Set<string>();
  const parseErrorIds: string[] = [];
  const parseList = <T extends AttentionItem>(
    list: unknown[],
    parse: (value: unknown) => T | null,
    target: T[],
  ): void => {
    for (const entry of list) {
      const item = parse(entry);
      const hinted =
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)['id']
          : undefined;
      if (item === null || seen.has(item.id)) {
        parseErrorIds.push(typeof hinted === 'string' && hinted ? hinted : '<unknown>');
        continue;
      }
      seen.add(item.id);
      target.push(item);
    }
  };
  parseList(raw['items'], parseAttentionItem, items);
  parseList(raw['resolved'], parseResolvedAttentionItem, resolved);
  items.sort(compareOpen);
  resolved.sort(compareResolved);

  const maxId = [...items, ...resolved].reduce((max, item) => Math.max(max, Number(item.id.slice(1))), 0);
  const nextId = raw['nextId'];
  if (!Number.isSafeInteger(nextId) || (nextId as number) < 1 || (nextId as number) <= maxId) {
    parseErrorIds.push('<nextId>');
  }

  const count = raw['count'];
  if (!Number.isSafeInteger(count) || count !== items.length) parseErrorIds.push('<count>');
  if (items.length > MAX_ATTENTION_PER_SESSION) parseErrorIds.push('<active-cap>');
  if (items.filter(item => item.raisedBy === 'agent').length > MAX_AGENT_ATTENTION_PER_SESSION) {
    parseErrorIds.push('<agent-cap>');
  }
  if (resolved.length > MAX_ATTENTION_RESOLUTIONS) parseErrorIds.push('<resolution-cap>');

  const reopenResolvedAt = parseReopenResolvedAt(raw['reopenResolvedAt']);
  parseErrorIds.push(...reopenResolvedAt.errors);

  const updatedAt = iso(raw['updatedAt']);
  if (updatedAt === null) parseErrorIds.push('<updatedAt>');
  return {
    file: {
      v: ATTENTION_SCHEMA_VERSION,
      sessionId: expectedSessionId,
      nextId: Number.isSafeInteger(nextId) ? (nextId as number) : 1,
      items,
      resolved,
      ...(reopenResolvedAt.value === undefined ? {} : { reopenResolvedAt: reopenResolvedAt.value }),
      count: items.length,
      updatedAt: updatedAt ?? now(),
    },
    parseErrors: parseErrorIds.length,
    parseErrorIds,
    fatal: false,
  };
}

export function serializeAttentionItem(item: AttentionItem): AttentionItem {
  return {
    id: item.id,
    source: item.source,
    sourceRef: item.sourceRef,
    ...(item.sourceSeq === undefined ? {} : { sourceSeq: item.sourceSeq }),
    subject: item.subject,
    why: item.why,
    ...(item.context === null || item.context === undefined ? {} : { context: item.context }),
    waitingSince: item.waitingSince,
    howToResolve: item.howToResolve,
    raisedBy: item.raisedBy,
    raisedBySession: item.raisedBySession,
    raisedByName: item.raisedByName,
  };
}

export function serializeResolvedAttentionItem(item: ResolvedAttentionItem): ResolvedAttentionItem {
  return {
    ...serializeAttentionItem(item),
    resolvedAt: item.resolvedAt,
    resolvedBy: item.resolvedBy,
    resolvedBySession: item.resolvedBySession,
    resolvedByName: item.resolvedByName,
    resolutionNote: item.resolutionNote,
  };
}

export function serializeAttentionFile(file: AttentionFile): AttentionFile {
  return {
    v: ATTENTION_SCHEMA_VERSION,
    sessionId: file.sessionId,
    nextId: file.nextId,
    items: file.items.map(serializeAttentionItem),
    resolved: file.resolved.map(serializeResolvedAttentionItem),
    ...(file.reopenResolvedAt === undefined ? {} : { reopenResolvedAt: { ...file.reopenResolvedAt } }),
    count: file.items.length,
    updatedAt: file.updatedAt,
  };
}

function validateState(state: AttentionState): AttentionState {
  const items = state.items.map(item => {
    const parsed = parseAttentionItem(serializeAttentionItem(item));
    if (parsed === null) throw new AttentionError('invalid', `refusing to write invalid attention item ${item.id}`);
    return parsed;
  });
  const resolved = state.resolved.map(item => {
    const parsed = parseResolvedAttentionItem(serializeResolvedAttentionItem(item));
    if (parsed === null) throw new AttentionError('invalid', `refusing to write invalid resolution ${item.id}`);
    return parsed;
  });
  const reopenResolvedAt = parseReopenResolvedAt(state.reopenResolvedAt);
  if (reopenResolvedAt.errors.length > 0) {
    throw new AttentionError('invalid', 'refusing to write invalid reopen resolution watermark');
  }
  const ids = new Set<string>();
  let maxId = 0;
  for (const item of [...items, ...resolved]) {
    if (ids.has(item.id)) throw new AttentionError('invalid', `duplicate attention id ${item.id}`);
    ids.add(item.id);
    maxId = Math.max(maxId, Number(item.id.slice(1)));
  }
  if (!Number.isSafeInteger(state.nextId) || state.nextId < 1 || state.nextId <= maxId) {
    throw new AttentionError('invalid', 'attention nextId must be a safe integer greater than every allocated id');
  }
  if (items.length > MAX_ATTENTION_PER_SESSION) {
    throw new AttentionError('full', `this session already has ${MAX_ATTENTION_PER_SESSION} unresolved items`);
  }
  if (items.filter(item => item.raisedBy === 'agent').length > MAX_AGENT_ATTENTION_PER_SESSION) {
    throw new AttentionError(
      'full',
      `this session already has ${MAX_AGENT_ATTENTION_PER_SESSION} unresolved agent requests`,
    );
  }
  items.sort(compareOpen);
  resolved.sort(compareResolved);
  return {
    nextId: state.nextId,
    items,
    resolved: resolved.slice(0, MAX_ATTENTION_RESOLUTIONS),
    ...(reopenResolvedAt.value === undefined ? {} : { reopenResolvedAt: reopenResolvedAt.value }),
  };
}

export type AttentionStoreRole = 'daemon' | 'reader';

export interface AttentionStoreOptions {
  role?: AttentionStoreRole;
}

export class AttentionStore {
  private readonly role: AttentionStoreRole;
  private readonly queue = new SerialQueue();

  constructor(
    private readonly paths: KTeamPaths,
    options: AttentionStoreOptions = {},
  ) {
    this.role = options.role ?? 'reader';
  }

  get writable(): boolean {
    return this.role === 'daemon';
  }

  file(sessionId: string): string {
    return attentionFile(this.paths, sessionId);
  }

  private assertSessionId(sessionId: string): void {
    if (!isSafeAttentionSessionId(sessionId)) {
      throw new AttentionError('invalid', `not a valid session id: ${String(sessionId)}`);
    }
  }

  private assertWritable(): void {
    if (!this.writable) {
      throw new AttentionError(
        'read-only',
        'attention files are daemon-owned: send this write through /v1/sessions/:id/attention',
      );
    }
  }

  async read(sessionId: string): Promise<AttentionRead> {
    this.assertSessionId(sessionId);
    const filename = this.file(sessionId);
    if (!existsSync(filename)) return { ...parseAttentionFile(null, sessionId), exists: false };
    const body = await readFile(filename, 'utf8').catch(() => null);
    if (body === null) {
      return {
        file: emptyFile(sessionId),
        parseErrors: 1,
        parseErrorIds: ['<file>'],
        fatal: true,
        exists: true,
      };
    }
    return { ...parseAttentionFile(body, sessionId), exists: true };
  }

  async snapshot(sessionId: string): Promise<AttentionSnapshot> {
    const read = await this.read(sessionId);
    return {
      v: ATTENTION_SCHEMA_VERSION,
      sessionId,
      items: read.file.items,
      resolved: read.file.resolved,
      ...(read.file.reopenResolvedAt === undefined ? {} : { reopenResolvedAt: { ...read.file.reopenResolvedAt } }),
      count: read.file.count,
      parseErrors: read.parseErrors,
      updatedAt: read.file.updatedAt,
    };
  }

  /** Cheap badge read: reads the one capped per-session file and returns its
   * persisted top-level scalar without validating every item. JSON.parse still
   * scans the document; the hard 20-item cap keeps that work bounded. A present
   * corrupt file throws rather than lying with a zero badge. */
  async count(sessionId: string): Promise<number> {
    this.assertSessionId(sessionId);
    const filename = this.file(sessionId);
    if (!existsSync(filename)) return 0;
    const body = await readFile(filename, 'utf8').catch(() => null);
    if (body === null) throw new AttentionError('corrupt', `cannot read ${filename}`);
    try {
      const raw = JSON.parse(body) as Record<string, unknown>;
      const count = raw['count'];
      const nextId = raw['nextId'];
      if (
        raw['v'] !== ATTENTION_SCHEMA_VERSION ||
        raw['sessionId'] !== sessionId ||
        !Number.isSafeInteger(nextId) ||
        (nextId as number) < 1 ||
        !Number.isSafeInteger(count) ||
        (count as number) < 0 ||
        (count as number) > MAX_ATTENTION_PER_SESSION
      ) {
        throw new Error('bad count');
      }
      return count as number;
    } catch {
      throw new AttentionError('corrupt', `cannot trust the attention count in ${filename}`);
    }
  }

  async mutate(
    sessionId: string,
    transform: (current: AttentionState) => AttentionState | Promise<AttentionState>,
  ): Promise<AttentionSnapshot> {
    return (await this.mutateWithResult(sessionId, transform)).snapshot;
  }

  async mutateWithResult(
    sessionId: string,
    transform: (current: AttentionState) => AttentionState | Promise<AttentionState>,
  ): Promise<AttentionMutation> {
    this.assertWritable();
    this.assertSessionId(sessionId);
    return this.queue.run(sessionId, async () => {
      const read = await this.read(sessionId);
      if (read.fatal || read.parseErrors > 0) {
        throw new AttentionError('corrupt', `refusing to overwrite unreadable ${this.file(sessionId)}`);
      }
      const current: AttentionState = {
        nextId: read.file.nextId,
        items: read.file.items,
        resolved: read.file.resolved,
        ...(read.file.reopenResolvedAt === undefined ? {} : { reopenResolvedAt: { ...read.file.reopenResolvedAt } }),
      };
      const transformed = await transform(current);
      if (transformed === current) {
        return {
          snapshot: {
            v: ATTENTION_SCHEMA_VERSION,
            sessionId,
            items: read.file.items,
            resolved: read.file.resolved,
            ...(read.file.reopenResolvedAt === undefined
              ? {}
              : { reopenResolvedAt: { ...read.file.reopenResolvedAt } }),
            count: read.file.count,
            parseErrors: 0,
            updatedAt: read.file.updatedAt,
          },
          changed: false,
        };
      }
      const state = validateState(transformed);
      const updatedAt = now();
      const file: AttentionFile = {
        v: ATTENTION_SCHEMA_VERSION,
        sessionId,
        nextId: state.nextId,
        items: state.items,
        resolved: state.resolved,
        reopenResolvedAt: state.reopenResolvedAt,
        count: state.items.length,
        updatedAt,
      };
      await atomicJson(this.file(sessionId), serializeAttentionFile(file));
      return {
        snapshot: {
          v: file.v,
          sessionId: file.sessionId,
          items: file.items,
          resolved: file.resolved,
          ...(file.reopenResolvedAt === undefined ? {} : { reopenResolvedAt: { ...file.reopenResolvedAt } }),
          count: file.count,
          parseErrors: 0,
          updatedAt: file.updatedAt,
        },
        changed: true,
      };
    });
  }

  /** Remove the transition-only timestamp map after a clean startup pass.
   * Absence is preserved so resolved audit rows can never materialise it again. */
  async compactLegacyReopenWatermarks(sessionId: string): Promise<AttentionMutation> {
    return this.mutateWithResult(sessionId, current => {
      if (current.reopenResolvedAt === undefined) return current;
      return {
        nextId: current.nextId,
        items: current.items,
        resolved: current.resolved,
      };
    });
  }
}

export { emptyAttentionSnapshot };
