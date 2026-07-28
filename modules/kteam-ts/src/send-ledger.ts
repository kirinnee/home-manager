import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SendEvidence, SendRecord, SendUnaccountedReason } from './types';
import type { ObservedHumanInput } from './observed-human-input';

export type { SendEvidence, SendFate, SendPath, SendRecord, SendUnaccountedReason } from './types';
export type { ObservedHumanInput } from './observed-human-input';

export const SEND_EVIDENCE_CLOCK_SLACK_MS = 30_000;
export const SEND_EVIDENCE_WINDOW_MS = 60 * 60_000;
export const SEND_UNACCOUNTED_TIMEOUT_MS = 60 * 60_000;
export const SEND_HARD_CAP_MS = 4 * 60 * 60_000;
export const SEND_EVIDENCE_KEY_LIMIT = 200;

export interface SendMatch {
  sendId: string;
  input: ObservedHumanInput;
  tier: SendEvidence['tier'];
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function cloneRecord(record: SendRecord): SendRecord {
  return {
    ...record,
    attachmentIds: [...record.attachmentIds],
    ...(record.evidence ? { evidence: { ...record.evidence } } : {}),
  };
}

function isSendRecord(value: unknown): value is SendRecord {
  const candidate = object(value);
  return (
    candidate?.v === 1 &&
    typeof candidate.sendId === 'string' &&
    typeof candidate.acceptedAt === 'string' &&
    typeof candidate.acceptedTurn === 'number' &&
    typeof candidate.path === 'string' &&
    typeof candidate.message === 'string' &&
    Array.isArray(candidate.attachmentIds) &&
    ['accepted', 'delivered', 'unaccounted'].includes(String(candidate.fate))
  );
}

async function appendSnapshot(file: string, record: SendRecord, separateCorruptTail: boolean): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, 'a', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${separateCorruptTail ? '\n' : ''}${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Append-only, last-snapshot-wins per-session send store. */
export class SendLedger {
  private readonly records = new Map<string, SendRecord>();
  private readonly evidenceKeys = new Set<string>();
  /** A crash can leave a partial final line. The first later append must start
   * on a fresh line or its valid snapshot would be fused into that tail. */
  private separateCorruptTail = false;

  private constructor(readonly file: string) {}

  static async open(file: string): Promise<SendLedger> {
    const ledger = new SendLedger(file);
    await ledger.reload();
    return ledger;
  }

  private async reload(): Promise<void> {
    this.records.clear();
    this.evidenceKeys.clear();
    const text = await readFile(this.file, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    this.separateCorruptTail = text.length > 0 && !text.endsWith('\n');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (!isSendRecord(value)) continue;
        const record = cloneRecord(value);
        this.records.set(record.sendId, record);
      } catch {
        // A crash may leave one partial tail. Earlier valid snapshots remain
        // authoritative; malformed lines never erase them.
      }
    }
    for (const record of this.records.values()) {
      if (record.fate === 'delivered' && record.evidence?.key) this.evidenceKeys.add(record.evidence.key);
    }
  }

  get(sendId: string): SendRecord | undefined {
    const record = this.records.get(sendId);
    return record ? cloneRecord(record) : undefined;
  }

  all(options: { includeWithdrawn?: boolean } = {}): SendRecord[] {
    return [...this.records.values()]
      .filter(record => options.includeWithdrawn === true || record.withdrawn !== true)
      .map(cloneRecord)
      .sort((left, right) => Date.parse(right.acceptedAt) - Date.parse(left.acceptedAt));
  }

  usedEvidenceKeys(): Set<string> {
    return new Set(this.evidenceKeys);
  }

  async persist(record: SendRecord): Promise<SendRecord> {
    const snapshot = cloneRecord(record);
    try {
      await appendSnapshot(this.file, snapshot, this.separateCorruptTail);
    } catch (error) {
      // Even an error reported by write/sync may have left bytes behind. A
      // blank separator is harmless when it did not and protects the next
      // durable snapshot when it did.
      this.separateCorruptTail = true;
      throw error;
    }
    this.separateCorruptTail = false;
    this.records.set(snapshot.sendId, snapshot);
    if (snapshot.fate === 'delivered' && snapshot.evidence?.key) this.evidenceKeys.add(snapshot.evidence.key);
    return cloneRecord(snapshot);
  }

  async accept(record: SendRecord): Promise<{ record: SendRecord; created: boolean }> {
    const current = this.records.get(record.sendId);
    if (current && !current.withdrawn) return { record: cloneRecord(current), created: false };
    // The caller was told about a synchronous failure, so a retry using the
    // same logical request id is allowed to make a fresh attempt. Resurrect by
    // appending a brand-new ACCEPTED snapshot (new acceptance clock/path), not
    // by mutating the withdrawn row in place or silently treating it as done.
    if (current?.withdrawn) {
      return {
        record: await this.persist({ ...record, withdrawn: undefined }),
        created: true,
      };
    }
    return { record: await this.persist(record), created: true };
  }

  async withdraw(sendId: string, at: string): Promise<SendRecord | undefined> {
    const current = this.records.get(sendId);
    if (!current || current.withdrawn || current.fate === 'delivered') return undefined;
    return await this.persist({ ...current, withdrawn: true, held: false, fateAt: at });
  }

  async deliver(match: SendMatch, matchedTurn: number, at: string): Promise<SendRecord | undefined> {
    if (this.evidenceKeys.has(match.input.proofKey)) return undefined;
    const current = this.records.get(match.sendId);
    if (!current || current.withdrawn || current.held || current.fate === 'delivered') return undefined;
    return await this.persist({
      ...current,
      fate: 'delivered',
      fateAt: at,
      unaccountedReason: undefined,
      evidence: {
        key: match.input.proofKey,
        harness: match.input.harness,
        kind:
          match.input.proof === 'native-queue-drain'
            ? 'queued_command'
            : match.input.harness === 'codex'
              ? 'response_item'
              : 'chat.user',
        proof: match.input.proof,
        observedAt: match.input.observedAt,
        ...(match.input.originatedAt ? { originatedAt: match.input.originatedAt } : {}),
        shapeVersion: match.input.shapeVersion,
        matchedTurn,
        tier: match.tier,
      },
    });
  }

  async unaccount(sendId: string, reason: SendUnaccountedReason, at: string): Promise<SendRecord | undefined> {
    const current = this.records.get(sendId);
    if (!current || current.withdrawn || current.held || current.fate !== 'accepted') return undefined;
    return await this.persist({ ...current, fate: 'unaccounted', fateAt: at, unaccountedReason: reason });
  }
}

export function newAcceptedSend(
  input: Omit<
    SendRecord,
    'v' | 'fate' | 'fateAt' | 'evidence' | 'unaccountedReason' | 'unaccountedDeadline' | 'hardDeadline'
  >,
): SendRecord {
  const acceptedMs = Date.parse(input.acceptedAt);
  return {
    v: 1,
    ...input,
    fate: 'accepted',
    ...(Number.isFinite(acceptedMs)
      ? {
          unaccountedDeadline: new Date(acceptedMs + SEND_UNACCOUNTED_TIMEOUT_MS).toISOString(),
          hardDeadline: new Date(acceptedMs + SEND_HARD_CAP_MS).toISOString(),
        }
      : {}),
  };
}

export function normalizeSendText(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function queueFileId(text: string): string | undefined {
  const match = normalizeSendText(text).match(
    /^Read the queued message file at .+\/queued-([A-Za-z0-9_-]{1,128})\.md completely now, then follow every instruction inside it\.$/,
  );
  return match?.[1];
}

function tierFor(record: SendRecord, text: string): SendEvidence['tier'] {
  const fileId = queueFileId(text);
  if (record.path === 'native-file' && fileId === record.sendId) return 'queue-file-id';
  if (record.path === 'turn-file' || record.path === 'revive') return 'turn-instruction';
  return 'exact-text';
}

/** Conservative, deterministic one-to-one evidence assignment. No generic
 * chat row, substring, prefix, case-fold, or fuzzy fallback is accepted. */
export function matchObservedHumanInputs(
  records: readonly SendRecord[],
  inputs: readonly ObservedHumanInput[],
  usedEvidenceKeys: ReadonlySet<string> = new Set(),
): SendMatch[] {
  const available = records
    .filter(
      record =>
        !record.withdrawn &&
        !record.held &&
        (record.fate === 'accepted' || record.fate === 'unaccounted') &&
        typeof record.matchText === 'string' &&
        normalizeSendText(record.matchText).length > 0,
    )
    .sort((left, right) => {
      const time = Date.parse(left.acceptedAt) - Date.parse(right.acceptedAt);
      return time || left.sendId.localeCompare(right.sendId);
    });
  const candidates = [...inputs].sort((left, right) => {
    const time = Date.parse(left.observedAt) - Date.parse(right.observedAt);
    return time || left.proofKey.localeCompare(right.proofKey);
  });
  const claimedSends = new Set<string>();
  const claimedEvidence = new Set<string>(usedEvidenceKeys);
  const matches: SendMatch[] = [];

  for (const input of candidates) {
    if (!input.proofKey || claimedEvidence.has(input.proofKey)) continue;
    const observedMs = Date.parse(input.observedAt);
    if (!Number.isFinite(observedMs)) continue;
    const normalized = normalizeSendText(input.text);
    if (!normalized) continue;
    const record = available.find(candidate => {
      if (claimedSends.has(candidate.sendId)) return false;
      const acceptedMs = Date.parse(candidate.acceptedAt);
      if (!Number.isFinite(acceptedMs)) return false;
      if (observedMs < acceptedMs - SEND_EVIDENCE_CLOCK_SLACK_MS) return false;
      const evidenceDeadline = Date.parse(
        candidate.unaccountedDeadline ?? new Date(acceptedMs + SEND_EVIDENCE_WINDOW_MS).toISOString(),
      );
      if (!Number.isFinite(evidenceDeadline) || observedMs > evidenceDeadline) return false;
      return normalizeSendText(candidate.matchText!) === normalized;
    });
    if (!record) continue;
    claimedSends.add(record.sendId);
    claimedEvidence.add(input.proofKey);
    matches.push({ sendId: record.sendId, input, tier: tierFor(record, input.text) });
  }
  return matches;
}

export interface SendTimeoutContext {
  now: string;
  opportunity: boolean;
  frozen: boolean;
}

/** Persist the elapsed non-consuming interval into the ordinary timeout clock
 * without evaluating fate. The acceptedAt-based hard cap stays absolute.
 * Observed-input reconciliation uses this before matching so the first
 * post-resume proof sees the shifted evidence upper bound before a later sweep
 * applies that hard cap. */
export function shiftFrozenSendTimeout(record: SendRecord, resumedAt: string): SendRecord {
  if (!record.timeoutFrozenAt) return record;
  const resumedMs = Date.parse(resumedAt);
  const acceptedMs = Date.parse(record.acceptedAt);
  if (!Number.isFinite(resumedMs) || !Number.isFinite(acceptedMs)) return record;
  const frozenMs = Date.parse(record.timeoutFrozenAt);
  const duration = Number.isFinite(frozenMs) ? Math.max(0, resumedMs - frozenMs) : 0;
  const shift = (value: string | undefined, fallback: number): string => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return new Date((Number.isFinite(parsed) ? parsed : fallback) + duration).toISOString();
  };
  const absoluteHardMs = acceptedMs + SEND_HARD_CAP_MS;
  const persistedHardMs = record.hardDeadline ? Date.parse(record.hardDeadline) : Number.NaN;
  return {
    ...record,
    timeoutFrozenAt: undefined,
    unaccountedDeadline: shift(record.unaccountedDeadline, acceptedMs + SEND_UNACCOUNTED_TIMEOUT_MS),
    // A consumption freeze extends the ordinary timeout/evidence window, but
    // the hard cap remains an absolute acceptedAt-based fate backstop. This
    // does not clamp evidence matching: a valid first post-resume proof still
    // matches through the shifted unaccountedDeadline before the next sweep.
    hardDeadline: new Date(
      Number.isFinite(persistedHardMs) ? Math.min(persistedHardMs, absoluteHardMs) : absoluteHardMs,
    ).toISOString(),
  };
}

/** Return the next persisted timeout snapshot, or the original record when no
 * durable field changes. Terminal/composer classification is deliberately
 * handled by explicit SessionManager triggers, not this timer-free sweep. */
export function advanceSendTimeout(record: SendRecord, context: SendTimeoutContext): SendRecord {
  if (record.withdrawn || record.held || record.fate === 'delivered') return record;
  const nowMs = Date.parse(context.now);
  const acceptedMs = Date.parse(record.acceptedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(acceptedMs)) return record;

  if (context.frozen) {
    return record.fate !== 'accepted' || record.timeoutFrozenAt ? record : { ...record, timeoutFrozenAt: context.now };
  }

  let next = shiftFrozenSendTimeout(record, context.now);

  // A terminal/composer classification can make a frozen row UNACCOUNTED.
  // Its evidence window still needs the persisted freeze shift for a later
  // authoritative proof, but timeout fate itself is already settled.
  if (next.fate !== 'accepted') return next;
  if (context.opportunity && !next.opportunityAt) next = { ...next, opportunityAt: context.now };
  const timeoutMs = Date.parse(
    next.unaccountedDeadline ?? new Date(acceptedMs + SEND_UNACCOUNTED_TIMEOUT_MS).toISOString(),
  );
  const hardMs = Date.parse(next.hardDeadline ?? new Date(acceptedMs + SEND_HARD_CAP_MS).toISOString());
  const timedOut = Boolean(next.opportunityAt) && Number.isFinite(timeoutMs) && nowMs >= timeoutMs;
  const hardCapped = Number.isFinite(hardMs) && nowMs >= hardMs;
  if (!timedOut && !hardCapped) return next;
  return { ...next, fate: 'unaccounted', fateAt: context.now, unaccountedReason: 'timeout' };
}

export function appendEvidenceKey(
  current: readonly string[] | undefined,
  key: string,
  limit = SEND_EVIDENCE_KEY_LIMIT,
): string[] {
  return [...new Set([...(current ?? []).filter(candidate => candidate !== key), key])].slice(-limit);
}
