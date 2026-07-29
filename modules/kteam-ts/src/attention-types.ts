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
// A valid blocked-task reason is at most 2,048 characters. Task-sourced
// Attention must be able to carry that complete reason instead of rejecting
// the very blocker it exists to surface.
export const MAX_ATTENTION_DETAIL_LEN = 2_048;

/** The reader of an attention item has NOT been following the session that
 * raised it. Field guidance derived from that fact — the shape, not reviewer
 * goodwill, is what forces readable output:
 *  - `subject`      THE ASK. One line: what the human must decide or do.
 *  - `context`      background for that stranger-reader. Every codename or
 *                   term of art ("warden", "wedge", "sol") expanded or glossed.
 *  - `why`          why this needs the human NOW (what is blocked/at risk).
 *  - `howToResolve` the concrete action that clears it, as short markdown
 *                   point form. All detail fields render as real markdown. */
export const ATTENTION_FIELD_GUIDANCE = {
  subject: 'the ask — one line stating what the human must decide or do',
  context: 'background a reader who has not followed this session needs; expand all jargon',
  why: 'why this needs the human now',
  howToResolve: 'the concrete action that resolves it, in short point form',
} as const;
export const MAX_ATTENTION_SOURCE_REF_LEN = 512;

/** The old `permission` source was declared with no producer and has been
 * removed; permission asks are now an `ask.kind` on agent-raised items, whose
 * producer is the `kteam attention` CLI. */
export const ATTENTION_SOURCES = ['task', 'question', 'agent-raised'] as const;
export type AttentionSource = (typeof ATTENTION_SOURCES)[number];

/** The four attention kinds, classified by WHAT THE HUMAN DOES:
 *  - `permission`       approve or reject
 *  - `multiple-choice`  pick one of the listed answers
 *  - `answer-review`    say the answer is good, or ask for clarification
 *  - `open-question`    write a full answer
 * Every kind's answer options are structural (see AttentionResponse), so a
 * renderer can never have to guess which control to draw. An item WITHOUT an
 * ask is a plain request that self-clears or is marked done/dismissed; absence
 * is legal because records predate the field and daemon-derived items (task
 * blockers, warden verdicts) are resolved by acting, not by answering here. */
export const ATTENTION_ASK_KINDS = ['permission', 'multiple-choice', 'answer-review', 'open-question'] as const;
export type AttentionAskKind = (typeof ATTENTION_ASK_KINDS)[number];

export const MAX_ATTENTION_ASK_OPTIONS = 12;
export const MAX_ATTENTION_ASK_OPTION_LEN = 120;
export const MAX_ATTENTION_ASK_OPTION_DETAIL_LEN = 240;

export interface AttentionAskOption {
  label: string;
  description?: string;
}

export type AttentionAsk =
  | { kind: 'permission' }
  | { kind: 'multiple-choice'; options: AttentionAskOption[] }
  | { kind: 'answer-review' }
  | { kind: 'open-question' };

/** The human's structured answer, one shape per kind. */
export type AttentionResponse =
  | { kind: 'permission'; decision: 'approve' | 'reject' }
  | { kind: 'multiple-choice'; choice: string }
  | { kind: 'answer-review'; verdict: 'good' }
  | { kind: 'answer-review'; verdict: 'clarify'; clarification: string }
  | { kind: 'open-question'; answer: string };

/** How a resolved item left the board. `done` is an answered/acted-on clear;
 * `dismissed` is an explicit "stop asking" from either side. Absent on rows
 * written before the field existed. */
export type AttentionDisposition = 'done' | 'dismissed';

const boundedLabel = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\r\n]/u.test(value) ? value : null;

/** Strict structural parse: null means "not a valid ask". Callers decide
 * whether that is a parse error (store) or a 400 (service/API). */
export function parseAttentionAsk(value: unknown): AttentionAsk | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = raw['kind'];
  if (kind === 'permission' || kind === 'answer-review' || kind === 'open-question') {
    if (raw['options'] !== undefined) return null;
    return { kind };
  }
  if (kind !== 'multiple-choice') return null;
  const rawOptions = raw['options'];
  if (!Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > MAX_ATTENTION_ASK_OPTIONS) {
    return null;
  }
  const options: AttentionAskOption[] = [];
  const seen = new Set<string>();
  for (const entry of rawOptions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const rawOption = entry as Record<string, unknown>;
    const label = boundedLabel(rawOption['label'], MAX_ATTENTION_ASK_OPTION_LEN);
    if (label === null || seen.has(label.trim())) return null;
    seen.add(label.trim());
    const description = rawOption['description'];
    if (description === undefined || description === null || description === '') {
      options.push({ label });
      continue;
    }
    const parsedDescription = boundedLabel(description, MAX_ATTENTION_ASK_OPTION_DETAIL_LEN);
    if (parsedDescription === null) return null;
    options.push({ label, description: parsedDescription });
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
    case 'multiple-choice': {
      const choice = boundedLabel(raw['choice'], MAX_ATTENTION_ASK_OPTION_LEN);
      return choice === null ? null : { kind: 'multiple-choice', choice };
    }
    case 'answer-review': {
      if (raw['verdict'] === 'good')
        return raw['clarification'] === undefined ? { kind: 'answer-review', verdict: 'good' } : null;
      if (raw['verdict'] !== 'clarify') return null;
      const clarification = raw['clarification'];
      if (
        typeof clarification !== 'string' ||
        clarification.trim().length === 0 ||
        clarification.length > MAX_ATTENTION_DETAIL_LEN
      ) {
        return null;
      }
      return { kind: 'answer-review', verdict: 'clarify', clarification };
    }
    case 'open-question': {
      const answer = raw['answer'];
      if (typeof answer !== 'string' || answer.trim().length === 0 || answer.length > MAX_ATTENTION_DETAIL_LEN) {
        return null;
      }
      return { kind: 'open-question', answer };
    }
    default:
      return null;
  }
}

/** A response is only meaningful against the item's own ask: kinds must match
 * and a multiple-choice answer must be one of the listed options. */
export function attentionResponseMatchesAsk(ask: AttentionAsk | undefined, response: AttentionResponse): boolean {
  if (ask === undefined || ask.kind !== response.kind) return false;
  if (response.kind !== 'multiple-choice' || ask.kind !== 'multiple-choice') return true;
  return ask.options.some(option => option.label.trim() === response.choice.trim());
}

/** One human-readable line for CLI/audit rendering. */
export function describeAttentionResponse(response: AttentionResponse): string {
  switch (response.kind) {
    case 'permission':
      return response.decision === 'approve' ? 'approved' : 'rejected';
    case 'multiple-choice':
      return `chose "${response.choice}"`;
    case 'answer-review':
      return response.verdict === 'good' ? 'answer accepted' : `clarification requested: ${response.clarification}`;
    case 'open-question':
      return `answered: ${response.answer}`;
  }
}

/** Stable identity shared by the shipped-reopen producer and its durable
 * Attention item. */
export const TASK_REOPENED_ATTENTION_SOURCE_REF_PREFIX = 'task-reopened:';
const TASK_REOPENED_TASK_ID = /^[BFIC][0-9]{1,9}$/u;

export function taskIdFromReopenedAttentionSourceRef(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(TASK_REOPENED_ATTENTION_SOURCE_REF_PREFIX)) return null;
  const id = value.slice(TASK_REOPENED_ATTENTION_SOURCE_REF_PREFIX.length);
  return TASK_REOPENED_TASK_ID.test(id) ? id : null;
}

/** Canonical ids stay sigil-free in storage and on the wire. Human-facing
 * references add `!`, so item A3 is written as `!A3` in messages. */
export type AttentionId = `A${number}`;
const ATTENTION_ID = /^A([1-9][0-9]*)$/u;

export function parseAttentionId(value: unknown): AttentionId | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/^[?!]/u, '');
  const match = raw.match(ATTENTION_ID);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
  return raw as AttentionId;
}

export function attentionReference(id: AttentionId): `!${AttentionId}` {
  return `!${id}`;
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
  /** Daemon-only activity generation for a shipped-reopen item. The resolver
   * acknowledges exactly this seq, never whichever reopen happens to be latest
   * when the click arrives. */
  sourceSeq?: number;
  /** The ask, one line: what the human must decide or do. */
  subject: string;
  /** Why this needs the human now. Markdown. */
  why: string;
  /** Background for a reader who has NOT been following this session, with
   * jargon expanded. Markdown. Optional: records predate the field, and some
   * asks genuinely need none. */
  context?: string | null;
  /** ISO timestamp. Display order is ascending: oldest unanswered first. */
  waitingSince: string;
  /** The concrete action that resolves it. Markdown. */
  howToResolve: string;
  /** What the human is being asked to DO, with its answer options structural.
   * Optional: records predate the field, and daemon-derived items (blocked
   * tasks, warden verdicts) are cleared by acting, not by answering here. */
  ask?: AttentionAsk;
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
  /** The structured answer the resolver gave, when the item carried an ask. */
  response?: AttentionResponse;
  /** `done` vs `dismissed`; absent on rows written before the field existed. */
  disposition?: AttentionDisposition;
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
  /** @deprecated Legacy timestamp watermarks, read only for one-time migration
   * to each task's monotonic reopenAckSeq and then compacted away. */
  reopenResolvedAt?: Readonly<Record<string, string>>;
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
