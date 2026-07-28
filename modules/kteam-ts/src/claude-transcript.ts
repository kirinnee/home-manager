import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_INPUT_SHAPE_VERSION, type ObservedHumanInput } from './observed-human-input';

type MaybePromise<T> = T | Promise<T>;

export interface ClaudeQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface ClaudeQuestion {
  question: string;
  header?: string;
  options: ClaudeQuestionOption[];
  multiSelect: boolean;
}

interface ClaudeEventMetadata {
  source: 'claude';
  timestamp?: string;
  sessionId?: string;
  recordUuid?: string;
  parentUuid?: string | null;
  messageId?: string;
  blockIndex?: number;
  stopReason?: string | null;
}

export type ClaudeNormalizedEvent =
  | (ClaudeEventMetadata & { type: 'chat.user'; data: { text: string; nativeQueuedHuman?: true } })
  | (ClaudeEventMetadata & { type: 'chat.assistant.text'; data: { text: string } })
  | (ClaudeEventMetadata & { type: 'chat.assistant.thinking'; data: { thinking: string } })
  | (ClaudeEventMetadata & { type: 'tool.use'; data: { toolUseId: string; name: string; input: unknown } })
  | (ClaudeEventMetadata & {
      type: 'tool.result';
      data: { toolUseId: string; content: unknown; text?: string; isError: boolean };
    })
  | (ClaudeEventMetadata & { type: 'interaction.question'; data: { toolUseId: string; questions: ClaudeQuestion[] } })
  | (ClaudeEventMetadata & { type: 'turn.completed'; data: Record<string, never> })
  | (ClaudeEventMetadata & {
      /** Remote Control came up for this session. The harness writes a
       *  `system`/`bridge_status` record carrying the RC surface URL — the
       *  AUTHORITATIVE source for it. The pane prints the same sentence, but
       *  that text scrolls away and (worse) shows any RC url the session merely
       *  READ, so pane scraping attributes other teammates' links to this
       *  session. */
      type: 'session.remote_control';
      data: { url: string };
    })
  | (ClaudeEventMetadata & {
      /** Context accounting from the harness's OWN usage record — the ground
       *  truth the status line only approximates (turn-020: pane scraping
       *  broke on the 1M-suffix statusline). contextTokens = input +
       *  cache_read + cache_creation of the latest assistant message. */
      type: 'context.usage';
      data: { contextTokens: number; model?: string };
    });

export interface TranscriptCursor {
  file: string;
  /** Byte offset immediately before this complete JSONL record. */
  startOffset: number;
  /** Byte offset immediately after this complete JSONL record, including its newline. */
  endOffset: number;
}

export interface TranscriptWatchEvent {
  eventType: 'change' | 'rename';
  filename?: string;
}

export interface TranscriptWatchHandle {
  close(): void;
}

/**
 * Small abstraction over Node/Bun's native watcher. Node maps this to inotify on
 * Linux and FSEvents/kqueue on macOS. Notifications only wake reconciliation;
 * byte offsets, not notification counts, determine what gets delivered.
 */
export interface TranscriptWatchBackend {
  watch(
    target: string,
    onChange: (event: TranscriptWatchEvent) => void,
    onError: (error: Error) => void,
  ): TranscriptWatchHandle;
}

export const nativeTranscriptWatchBackend: TranscriptWatchBackend = {
  watch(target, onChange, onError): TranscriptWatchHandle {
    const watcher: FSWatcher = fsWatch(target, { persistent: false }, (eventType, filename) => {
      onChange({ eventType, filename: filename?.toString() });
    });
    watcher.on('error', onError);
    return { close: () => watcher.close() };
  },
};

export class ClaudeTranscriptParseError extends Error {
  constructor(
    public readonly cursor: TranscriptCursor,
    options?: ErrorOptions,
  ) {
    super(`invalid Claude transcript JSONL record at byte ${cursor.startOffset}`, options);
    this.name = 'ClaudeTranscriptParseError';
  }
}

export interface ClaudeTranscriptWatcherOptions {
  /** Claude projects directory, or another parent beneath which the UUID file appears. */
  transcriptRoot: string;
  /** Exact Claude session UUID. Only `<sessionId>.jsonl` is accepted. */
  sessionId: string;
  onEvents(events: readonly ClaudeNormalizedEvent[], cursor: TranscriptCursor): MaybePromise<void>;
  /** Delivery-proof candidates, on a channel SEPARATE from `onEvents` so the
   *  chat/history stream is unchanged. Each raw record is fed to a stateful
   *  {@link ClaudeObservedInputAdapter}; consumers reconcile these against their
   *  durable send records without ever treating arbitrary `chat.user` as proof. */
  onObservedInput?(inputs: readonly ObservedHumanInput[], cursor: TranscriptCursor): MaybePromise<void>;
  onCheckpoint?(cursor: TranscriptCursor): MaybePromise<void>;
  onDiscovered?(file: string): MaybePromise<void>;
  onError?(error: Error): void;
  /** Safety net for dropped/coalesced native notifications. Defaults to 2 seconds. */
  reconcileIntervalMs?: number;
  /** Floor between two FULL-TREE rediscovery walks once a transcript is
   *  already selected. Defaults to 60 seconds; a missing file always
   *  rediscovers immediately regardless of this. */
  rediscoverIntervalMs?: number;
  /** A previously persisted complete-line byte cursor. */
  initialOffset?: number;
  watchBackend?: TranscriptWatchBackend;
}

export interface ClaudeTranscriptWatcherSnapshot {
  running: boolean;
  file?: string;
  inode?: string;
  readOffset: number;
  checkpointOffset: number;
  partialBytes: number;
  queuedRecords: number;
}

interface PendingRecord {
  bytes: Buffer<ArrayBufferLike>;
  cursor: TranscriptCursor;
  /** Observed-input candidates memoized the first time this record reached the
   *  queue head. The adapter is STATEFUL — producing a busy-drain candidate
   *  SPLICES the paired queue-operation/remove timestamp out of a bounded ring —
   *  so re-observing on a delivery-callback retry would find the ring drained and
   *  fall back to a later wall-clock observedAt, back-dating an in-window proof.
   *  Undefined until first observed. */
  observed?: readonly ObservedHumanInput[];
}

interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

const READ_CHUNK_BYTES = 64 * 1024;
const ANCHOR_BYTES = 512;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function eventMetadata(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
  blockIndex?: number,
): ClaudeEventMetadata {
  return {
    source: 'claude',
    timestamp: string(record.timestamp),
    sessionId: string(record.sessionId),
    recordUuid: string(record.uuid),
    parentUuid: nullableString(record.parentUuid),
    messageId: string(message.id),
    blockIndex,
    stopReason: nullableString(message.stop_reason),
  };
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const texts = value.flatMap(item => {
    const block = object(item);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  });
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/**
 * Text from a user record's content that is REAL human text — plain strings and
 * `type:'text'` blocks — excluding `tool_result` blocks (Claude writes tool
 * results as `role:'user'` records, and those are never human input). Returns
 * the joined text, or undefined when the record carries no human text at all.
 */
function realUserText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    const block = object(content);
    return block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
  }
  const texts = content.flatMap(item => {
    if (typeof item === 'string') return [item];
    const block = object(item);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  });
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function normalizeQuestions(input: unknown): ClaudeQuestion[] {
  const questions = object(input)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap(value => {
    const question = object(value);
    if (!question || typeof question.question !== 'string') return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap(value => {
          const option = object(value);
          if (!option || typeof option.label !== 'string') return [];
          return [
            {
              label: option.label,
              description: string(option.description),
              preview: string(option.preview),
            },
          ];
        })
      : [];
    return [
      {
        question: question.question,
        header: string(question.header),
        options,
        multiSelect: question.multiSelect === true,
      },
    ];
  });
}

/** Normalize one parsed Claude Code transcript record without retaining raw data. */
export function normalizeClaudeTranscriptRecord(value: unknown): ClaudeNormalizedEvent[] {
  const record = object(value);
  if (!record) return [];
  const message = object(record.message) ?? {};
  const role = string(message.role) ?? string(record.type);
  const content = message.content ?? record.content;
  const blocks = Array.isArray(content) ? content : [content];
  const events: ClaudeNormalizedEvent[] = [];

  // A prompt accepted from Claude's busy-input queue is not written as a
  // normal `user` message. At the dequeue boundary Claude appends an
  // `attachment`/`queued_command` record instead. Treat that consumed human
  // prompt as the user turn it represents so kteam can correlate its durable
  // pendingNativeSends entry, advance the tracked turn, and persist a chat row.
  // `task-notification` queued commands are harness-generated and deliberately
  // excluded: rendering those as human input would create fake user messages.
  if (record.type === 'attachment') {
    const attachment = object(record.attachment);
    const origin = object(attachment?.origin);
    const prompt = string(attachment?.prompt);
    if (
      attachment?.type === 'queued_command' &&
      attachment.commandMode === 'prompt' &&
      origin?.kind === 'human' &&
      prompt?.trim()
    ) {
      return [
        {
          ...eventMetadata(record, message),
          type: 'chat.user',
          data: { text: prompt, nativeQueuedHuman: true },
        },
      ];
    }
    return [];
  }

  // Remote Control announcement. Structured (`url`), so no sentence parsing —
  // and it is per-session by construction, unlike the pane line.
  if (record.type === 'system' && record.subtype === 'bridge_status') {
    const url = string(record.url);
    if (url && /^https:\/\/claude\.ai\/code\//.test(url)) {
      return [{ ...eventMetadata(record, message), type: 'session.remote_control', data: { url } }];
    }
    return [];
  }

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const value = blocks[blockIndex];
    const metadata = eventMetadata(record, message, blockIndex);

    if (typeof value === 'string') {
      if (role === 'user') events.push({ ...metadata, type: 'chat.user', data: { text: value } });
      if (role === 'assistant') events.push({ ...metadata, type: 'chat.assistant.text', data: { text: value } });
      continue;
    }

    const block = object(value);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (role === 'user') events.push({ ...metadata, type: 'chat.user', data: { text: block.text } });
      if (role === 'assistant') events.push({ ...metadata, type: 'chat.assistant.text', data: { text: block.text } });
      continue;
    }
    if (role === 'assistant' && block.type === 'thinking' && typeof block.thinking === 'string') {
      events.push({ ...metadata, type: 'chat.assistant.thinking', data: { thinking: block.thinking } });
      continue;
    }
    if (role === 'assistant' && block.type === 'tool_use') {
      const toolUseId = string(block.id);
      const name = string(block.name);
      if (!toolUseId || !name) continue;
      events.push({ ...metadata, type: 'tool.use', data: { toolUseId, name, input: block.input } });
      if (name === 'AskUserQuestion') {
        events.push({
          ...metadata,
          type: 'interaction.question',
          data: { toolUseId, questions: normalizeQuestions(block.input) },
        });
      }
      continue;
    }
    if (block.type === 'tool_result') {
      const toolUseId = string(block.tool_use_id);
      if (!toolUseId) continue;
      const resultText = textFromContent(block.content);
      events.push({
        ...metadata,
        type: 'tool.result',
        data: {
          toolUseId,
          content: block.content,
          ...(resultText === undefined ? {} : { text: resultText }),
          isError: block.is_error === true || block.isError === true,
        },
      });
    }
  }

  if (role === 'assistant' && message.stop_reason === 'end_turn') {
    events.push({ ...eventMetadata(record, message), type: 'turn.completed', data: {} });
  }

  // Context accounting: every assistant record carries a usage block whose
  // input + cache_read + cache_creation is the prompt-side context size.
  if (role === 'assistant') {
    const usage = object(message.usage);
    if (usage) {
      const total =
        (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) +
        (typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0) +
        (typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0);
      if (total > 0) {
        events.push({
          ...eventMetadata(record, message),
          type: 'context.usage',
          data: { contextTokens: total, ...(string(message.model) ? { model: string(message.model) } : {}) },
        });
      }
    }
  }

  return events;
}

/** Parse and normalize one complete JSONL line. */
export function parseClaudeTranscriptLine(line: string): ClaudeNormalizedEvent[] {
  return normalizeClaudeTranscriptRecord(JSON.parse(line) as unknown);
}

/** How many recent `queue-operation/remove` ops the drain matcher keeps. A busy
 *  drain writes its `attachment` immediately after the matching `remove`, so a
 *  small ring is ample; it only ever holds removes not yet paired to a drain. */
const REMOVE_RING_LIMIT = 64;

interface RemoveOp {
  content: string;
  timestamp?: string;
}

/**
 * Stateful, adapter-LOCAL producer of {@link ObservedHumanInput} candidates from
 * raw Claude transcript records. It is the only place that knows Claude's two
 * human-input shapes, so a format change breaks this one adapter loudly instead
 * of mis-reporting delivery downstream.
 *
 * The single piece of cross-record state is a bounded ring of recent
 * `queue-operation/remove` ops. Those ops are the ONLY records carrying the
 * CONSUMPTION time of a busy-drained prompt; the drain's own
 * `attachment.timestamp` is the enqueue time and must never be used as
 * `observedAt`. The stateless public normalizer ({@link normalizeClaudeTranscriptRecord})
 * keeps emitting the provenance-marked `chat.user` row for rendering; this
 * adapter runs alongside it and emits the separate proof candidate.
 *
 * Feed EVERY raw record (in transcript order) through {@link observe}: the ring
 * is built from the `remove` ops that precede each drain.
 */
export class ClaudeObservedInputAdapter {
  private readonly removeRing: RemoveOp[] = [];

  /** Drop all buffered `remove` ops. Call when the transcript cursor is reset
   *  (truncation / inode replacement) so a stale op cannot mis-time a replayed
   *  drain; the ops are re-fed from the replayed bytes. */
  reset(): void {
    this.removeRing.length = 0;
  }

  /**
   * Inspect one raw Claude record and return zero or more observed-human-input
   * candidates.
   *
   * @param value              the parsed raw record
   * @param cursor             the record's byte cursor (for the fallback proof key)
   * @param observedAtFallback the watcher's read wall-clock, used as `observedAt`
   *                           only when the harness gives no better time
   */
  observe(value: unknown, cursor: TranscriptCursor, observedAtFallback: string): ObservedHumanInput[] {
    const record = object(value);
    if (!record) return [];

    // Track queue-operation/remove ops: content + consumption time. `remove`
    // alone is NOT proof (125 corpus cases are cancellations / pane deaths); it
    // only supplies the observedAt for a matching drain that follows.
    if (record.type === 'queue-operation') {
      if (string(record.operation) === 'remove') {
        const content = string(record.content);
        if (content !== undefined) {
          this.removeRing.push({ content, timestamp: string(record.timestamp) });
          if (this.removeRing.length > REMOVE_RING_LIMIT) this.removeRing.shift();
        }
      }
      return [];
    }

    // Shape Q — busy drain. Same discriminator as the normalizer's chat.user
    // path: queued_command / commandMode:'prompt' / origin.kind:'human' /
    // non-blank prompt. task-notifications and non-human origins are excluded.
    if (record.type === 'attachment') {
      const attachment = object(record.attachment);
      const origin = object(attachment?.origin);
      const prompt = string(attachment?.prompt);
      if (
        attachment?.type === 'queued_command' &&
        attachment.commandMode === 'prompt' &&
        origin?.kind === 'human' &&
        prompt?.trim()
      ) {
        const originatedAt = string(attachment.timestamp) ?? string(record.timestamp);
        // observedAt: the matching remove op's time (real consumption), then the
        // watcher read time. NEVER the attachment/enqueue timestamp.
        const observedAt = this.takeRemoveTimestamp(prompt) ?? observedAtFallback;
        return [
          {
            harness: 'claude',
            text: prompt,
            proof: 'native-queue-drain',
            observedAt,
            ...(originatedAt === undefined ? {} : { originatedAt }),
            proofKey: claudeProofKey(record, cursor),
            shapeVersion: CLAUDE_INPUT_SHAPE_VERSION,
          },
        ];
      }
      return [];
    }

    // Shape N — normal idle-submit user record: type:user, message.role:user,
    // real text (not a tool_result). Emits exactly one candidate for the record.
    const message = object(record.message) ?? {};
    if (record.type === 'user' && string(message.role) === 'user') {
      const text = realUserText(message.content ?? record.content);
      if (text !== undefined && text.trim()) {
        return [
          {
            harness: 'claude',
            text,
            proof: 'normal-user-record',
            observedAt: string(record.timestamp) ?? observedAtFallback,
            proofKey: claudeProofKey(record, cursor),
            shapeVersion: CLAUDE_INPUT_SHAPE_VERSION,
          },
        ];
      }
    }

    return [];
  }

  /** Pull the most recent buffered `remove` whose content exactly equals the
   *  drained prompt, removing it so a later identical drain cannot reuse it
   *  (one-to-one). Returns its timestamp, or undefined when none matches. */
  private takeRemoveTimestamp(prompt: string): string | undefined {
    for (let index = this.removeRing.length - 1; index >= 0; index -= 1) {
      if (this.removeRing[index]!.content === prompt) {
        const [removed] = this.removeRing.splice(index, 1);
        return removed!.timestamp;
      }
    }
    return undefined;
  }
}

/** Stable-across-replay proof key: the record UUID where the harness supplies
 *  one, otherwise a cursor-derived key stable across replays of the file. */
function claudeProofKey(record: Record<string, unknown>, cursor: TranscriptCursor): string {
  return string(record.uuid) ?? `${cursor.file}#${cursor.startOffset}#${cursor.endOffset}`;
}

async function directoriesBelow(root: string): Promise<string[]> {
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) return [];
  const directories = [root];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) directories.push(path.join(directory, entry.name));
    }
  }
  return directories;
}

async function nearestExistingDirectory(target: string): Promise<string | undefined> {
  let candidate = path.resolve(target);
  while (true) {
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isDirectory()) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

/** Find only the transcript whose basename exactly matches the requested UUID. */
export async function findClaudeTranscript(root: string, sessionId: string): Promise<string | undefined> {
  const filename = `${sessionId}.jsonl`;
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const directory of await directoriesBelow(root)) {
    const file = path.join(directory, filename);
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile()) candidates.push({ file, mtimeMs: info.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file));
  return candidates[0]?.file;
}

function identityOf(info: { dev: number | bigint; ino: number | bigint }): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

function identityString(identity?: FileIdentity): string | undefined {
  return identity ? `${identity.dev.toString()}:${identity.ino.toString()}` : undefined;
}

function sameIdentity(left?: FileIdentity, right?: FileIdentity): boolean {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

export class ClaudeTranscriptWatcher {
  private readonly options: ClaudeTranscriptWatcherOptions;
  private readonly backend: TranscriptWatchBackend;
  private readonly directoryWatches = new Map<string, TranscriptWatchHandle>();
  private readonly observedInput = new ClaudeObservedInputAdapter();
  private fileWatch?: TranscriptWatchHandle;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private transcriptFile?: string;
  private fileIdentity?: FileIdentity;
  private readOffset = 0;
  private checkpointOffset = 0;
  private partial: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private partialStartOffset = 0;
  private anchor: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private pending: PendingRecord[] = [];
  private reconcileRequested = false;
  private directoryRefreshRequested = false;
  private reconcilePromise?: Promise<void>;
  /** Monotonic id stamped on each reconcile pass the instant it BEGINS reading.
   *  A flush barrier resolves only once a pass whose id is strictly greater than
   *  the id captured at request time has fully completed — i.e. a pass that
   *  began after the flush request and therefore read to the then-current EOF. */
  private passStartSeq = 0;
  /** Barriers waiting for a reconcile pass that STARTS after `afterSeq`. Each is
   *  released the moment such a pass completes, never waiting for later unrelated
   *  re-requests (the coalescing loop can re-arm indefinitely under a live
   *  writer, so awaiting the loop itself can hang `finalizeTerminalSends`).
   *  `rejectOnError` waiters (from `flush()`) REJECT if their target pass threw,
   *  so a consumer never records a false-successful drain; `flush` waiters do,
   *  the nonthrowing `start` barrier does not. */
  private passWaiters: Array<{
    afterSeq: number;
    rejectOnError: boolean;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  /** When the last full-tree discovery walk ran (throttles the expensive path). */
  private lastDiscoveryAt = 0;
  /** Consecutive walks that found nothing — the input to the search backoff. */
  private discoveryAttempts = 0;
  private readonly rediscoverIntervalMs: number;

  constructor(options: ClaudeTranscriptWatcherOptions) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.sessionId)) {
      throw new Error('Claude transcript sessionId must be a UUID');
    }
    this.options = options;
    this.backend = options.watchBackend ?? nativeTranscriptWatchBackend;
    this.rediscoverIntervalMs = Math.max(0, options.rediscoverIntervalMs ?? 60_000);
  }

  async start(): Promise<this> {
    if (this.running) return this;
    this.running = true;
    const interval = Math.max(10, this.options.reconcileIntervalMs ?? 2_000);
    // The periodic tick is the CHEAP path (stat the known file, read the
    // delta). It must never force a full-tree rediscovery: that ran every
    // 2 s per session over the SHARED harness home and pinned the daemon's
    // event loop (2026-07-23 listener-flap incident).
    this.timer = setInterval(() => void this.requestReconcile(), interval);
    this.timer.unref?.();
    // Await ONE pass, not the drain loop. `requestReconcile` returns a loop
    // that keeps going while `reconcileRequested` is set, and the periodic
    // timer re-sets it — so on a transcript that is actively being written
    // (i.e. every freshly launched session) that promise settles late or not
    // at all, and `start()` used to inherit the delay. Callers want "the
    // watcher is armed and has looked once", which is what a pass is. The start
    // barrier is nonthrowing: a transient first-pass error must not fail watcher
    // construction — the periodic loop recovers, and errors still reach onError.
    const first = this.nextPass(false);
    void this.requestReconcile(true);
    await first;
    return this;
  }

  /**
   * Run one bounded reconcile pass to EOF and resolve once it has completed.
   *
   * Guarantees every transcript byte written before the call is parsed and
   * delivered through `onEvents` / `onObservedInput`. Bounded by the current
   * file size and exits within one reconcile interval, so it never deadlocks —
   * a consumer can `await watcher.flush()` to drain final transcript evidence
   * immediately before a terminal classification, then `stop()`. A no-op once
   * the watcher has stopped.
   */
  async flush(): Promise<void> {
    if (!this.running) return;
    // Register the barrier BEFORE kicking the reconcile so `afterSeq` captures
    // the pass id current at request time. We then wait for a pass that STARTS
    // after this point to finish — not for the coalescing loop to fully drain,
    // which a concurrent re-request (the periodic tick, a watch event) can defer
    // forever. One bounded EOF pass is the contract, so flush stays finite even
    // while later work remains schedulable.
    // A flush barrier REJECTS if its target pass fails, so a caller
    // (finalizeTerminalSends) never treats a failed EOF drain as a successful
    // one and classifies without proof.
    const barrier = this.nextPass(true);
    void this.requestReconcile(true);
    await barrier;
  }

  /** Resolves after the next reconcile pass that BEGINS after this call fully
   *  completes (or immediately once the watcher stops). When `rejectOnError`,
   *  the barrier rejects instead if that target pass threw. */
  private nextPass(rejectOnError: boolean): Promise<void> {
    if (!this.running) return Promise.resolve();
    const afterSeq = this.passStartSeq;
    return new Promise<void>((resolve, reject) => this.passWaiters.push({ afterSeq, rejectOnError, resolve, reject }));
  }

  /** Settle every barrier a pass with start id `completedSeq` satisfies:
   *  reject `rejectOnError` waiters if that pass threw (`error`), else resolve. */
  private settlePassWaiters(completedSeq: number, error?: Error): void {
    if (this.passWaiters.length === 0) return;
    const remaining: typeof this.passWaiters = [];
    for (const waiter of this.passWaiters) {
      if (completedSeq > waiter.afterSeq) {
        if (error && waiter.rejectOnError) waiter.reject(error);
        else waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    this.passWaiters = remaining;
  }

  /** Unconditionally release all barriers — used only when the watcher stops or
   *  the reconcile loop exits, so no caller hangs past the watcher's life. */
  private releasePassWaiters(): void {
    const waiters = this.passWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.fileWatch?.close();
    this.fileWatch = undefined;
    for (const watcher of this.directoryWatches.values()) watcher.close();
    this.directoryWatches.clear();
    this.releasePassWaiters();
    await this.reconcilePromise;
  }

  snapshot(): ClaudeTranscriptWatcherSnapshot {
    return {
      running: this.running,
      file: this.transcriptFile,
      inode: identityString(this.fileIdentity),
      readOffset: this.readOffset,
      checkpointOffset: this.checkpointOffset,
      partialBytes: this.partial.length,
      queuedRecords: this.pending.length,
    };
  }

  private report(error: unknown): void {
    const reported = error instanceof Error ? error : new Error(String(error));
    this.options.onError?.(reported);
  }

  private requestReconcile(refreshDirectories = false): Promise<void> {
    if (!this.running) return Promise.resolve();
    this.reconcileRequested = true;
    this.directoryRefreshRequested ||= refreshDirectories;
    if (!this.reconcilePromise) {
      this.reconcilePromise = (async () => {
        while (this.running && this.reconcileRequested) {
          this.reconcileRequested = false;
          const startSeq = (this.passStartSeq += 1);
          let passError: Error | undefined;
          try {
            await this.reconcile();
          } catch (error) {
            passError = error instanceof Error ? error : new Error(String(error));
            this.report(passError);
          }
          // A failed pass rejects only its flush barriers; ordinary reporting and
          // the coalescing loop are unchanged, so the watcher keeps recovering.
          this.settlePassWaiters(startSeq, passError);
        }
      })().finally(() => {
        this.reconcilePromise = undefined;
        // Only STOP may release barriers a pass never satisfied. While running, a
        // barrier still pending at settlement means its target pass has NOT run
        // yet — e.g. a flush that armed reconcileRequested landed in the microtask
        // gap between the loop's exit and this settlement callback. Re-request so
        // the next generation pass resolves it by id; never release it blindly
        // here, which would resolve flush before its EOF pass actually completed.
        if (!this.running) {
          this.releasePassWaiters();
        } else if (this.reconcileRequested || this.passWaiters.length > 0) {
          void this.requestReconcile();
        }
      });
    }
    return this.reconcilePromise;
  }

  private watchChanged(event: TranscriptWatchEvent): void {
    void this.requestReconcile(event.eventType === 'rename');
  }

  private makeWatch(target: string): TranscriptWatchHandle | undefined {
    try {
      return this.backend.watch(
        target,
        event => this.watchChanged(event),
        error => {
          this.report(error);
          void this.requestReconcile(true);
        },
      );
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  /** Watch the SMALLEST directory set that can wake reconciliation:
   *  - transcript known → its own directory (one inotify watch);
   *  - not yet discovered → the nearest existing ancestor of the root, so a
   *    freshly created project directory is noticed.
   *  The old behaviour armed one watch per directory BELOW the root: with a
   *  shared harness home (~300 project directories) every live session held
   *  ~300 watches over the same tree, so every transcript write by any
   *  teammate woke every session's watcher into a full re-walk. The 2 s
   *  reconcile poll — not the watch set — is the correctness guarantee. */
  private async refreshDirectoryWatches(file: string | undefined): Promise<void> {
    const directories = file
      ? [path.dirname(file)]
      : await nearestExistingDirectory(this.options.transcriptRoot).then(value => (value ? [value] : []));
    const desired = new Set(directories);
    for (const [directory, watcher] of this.directoryWatches) {
      if (desired.has(directory)) continue;
      watcher.close();
      this.directoryWatches.delete(directory);
    }
    for (const directory of desired) {
      if (this.directoryWatches.has(directory)) continue;
      const watcher = this.makeWatch(directory);
      if (watcher) this.directoryWatches.set(directory, watcher);
    }
  }

  private async reconcile(): Promise<void> {
    const refreshRequested = this.directoryRefreshRequested;
    this.directoryRefreshRequested = false;

    let file = this.transcriptFile;
    const usable =
      file !== undefined &&
      (await stat(file)
        .then(info => info.isFile())
        .catch(() => false));
    // Full-tree discovery is the EXPENSIVE path (a readdir per project
    // directory plus a stat per candidate). Run it when there is no usable
    // file — and otherwise at most once per REDISCOVER_INTERVAL_MS, so a
    // rename storm in the shared harness home cannot re-walk it on every
    // notification.
    // Before discovery the walk is the only way to FIND the file, so it runs
    // often — but not forever at full rate: a session whose transcript never
    // appears (login-walled, dead harness) would otherwise re-walk the shared
    // home every 2 s for the ~360 s until the turn-never-started reflex fires,
    // and a launch storm multiplies that by the number of sessions.
    const searchFloor = Math.min(this.rediscoverIntervalMs, this.discoveryAttempts < 5 ? 0 : 15_000);
    const sinceDiscovery = Date.now() - this.lastDiscoveryAt;
    // Even settled, re-walk once per interval rather than only on a rename:
    // the only armed watches are the transcript and its own directory, so a
    // NEWER file for the same session appearing under a different project
    // directory would otherwise never be noticed and the watcher would tail a
    // frozen file until the turn-never-started reflex failed the session.
    const rediscover = usable
      ? sinceDiscovery >= this.rediscoverIntervalMs
      : refreshRequested || sinceDiscovery >= searchFloor;
    if (rediscover) {
      this.lastDiscoveryAt = Date.now();
      file = await findClaudeTranscript(this.options.transcriptRoot, this.options.sessionId);
      this.discoveryAttempts = file ? 0 : this.discoveryAttempts + 1;
      await this.refreshDirectoryWatches(file);
    } else if (!usable) {
      // The known path is gone and this tick is inside the search backoff:
      // treat it as absent rather than reading on into stat() and throwing
      // ENOENT — an error per tick, forever, once a transcript is deleted.
      file = undefined;
    }
    if (!file) {
      this.detachFile();
      return;
    }

    await this.selectFile(file);
    // Drain what is already queued before reading more; a delivery-callback
    // failure throws out of the whole pass (fails the flush barrier) rather than
    // silently reading on past an undelivered record.
    await this.deliverPending();
    await this.readAvailable();
    await this.deliverPending();
  }

  private detachFile(): void {
    this.fileWatch?.close();
    this.fileWatch = undefined;
    // Retain the last path, identity, and cursor. Atomic replacement can briefly
    // remove the pathname; the next reconciliation verifies the anchor before
    // either continuing at the cursor or replaying the replacement from byte 0.
  }

  private async selectFile(file: string): Promise<void> {
    const info = await stat(file);
    const nextIdentity = identityOf(info);
    const firstDiscovery = this.transcriptFile === undefined;
    const changed = this.transcriptFile !== file || !sameIdentity(this.fileIdentity, nextIdentity);

    if (firstDiscovery) {
      const requested = Math.max(0, this.options.initialOffset ?? 0);
      this.readOffset = requested <= info.size ? requested : 0;
      this.checkpointOffset = this.readOffset;
      this.partialStartOffset = this.readOffset;
      this.anchor = await this.readAnchor(file, this.readOffset);
    } else if (!(await this.cursorStillMatches(file, info.size))) {
      this.resetCursor();
    }

    if (changed || !this.fileWatch) {
      this.fileWatch?.close();
      this.fileWatch = this.makeWatch(file);
      this.transcriptFile = file;
      this.fileIdentity = nextIdentity;
      if (changed) await this.options.onDiscovered?.(file);
    }
  }

  private resetCursor(): void {
    this.readOffset = 0;
    this.checkpointOffset = 0;
    this.partial = Buffer.alloc(0);
    this.partialStartOffset = 0;
    this.anchor = Buffer.alloc(0);
    this.pending = [];
    this.observedInput.reset();
  }

  private async cursorStillMatches(file: string, size: number): Promise<boolean> {
    if (this.readOffset === 0) return true;
    if (size < this.readOffset || this.anchor.length === 0) return false;
    const nextAnchor = await this.readAnchor(file, this.readOffset);
    return nextAnchor.equals(this.anchor);
  }

  private async readAnchor(file: string, offset: number): Promise<Buffer<ArrayBufferLike>> {
    const length = Math.min(ANCHOR_BYTES, offset);
    if (length === 0) return Buffer.alloc(0);
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private rememberBytes(bytes: Buffer<ArrayBufferLike>): void {
    const combined = Buffer.concat([this.anchor, bytes]);
    this.anchor = combined.subarray(Math.max(0, combined.length - ANCHOR_BYTES));
  }

  private async readAvailable(): Promise<void> {
    const file = this.transcriptFile;
    if (!file) return;
    const handle = await open(file, 'r');
    try {
      while (this.running) {
        const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.readOffset);
        if (bytesRead === 0) break;
        const bytes = buffer.subarray(0, bytesRead);
        const startOffset = this.readOffset;
        this.readOffset += bytesRead;
        this.rememberBytes(bytes);
        this.consumeBytes(bytes, startOffset);
      }
    } finally {
      await handle.close();
    }
  }

  private consumeBytes(bytes: Buffer<ArrayBufferLike>, bytesStartOffset: number): void {
    const combinedStart = this.partial.length > 0 ? this.partialStartOffset : bytesStartOffset;
    const combined = this.partial.length > 0 ? Buffer.concat([this.partial, bytes]) : bytes;
    let lineStart = 0;
    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== 0x0a) continue;
      let line = combined.subarray(lineStart, index);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      const cursor = {
        file: this.transcriptFile!,
        startOffset: combinedStart + lineStart,
        endOffset: combinedStart + index + 1,
      };
      if (line.length > 0) this.pending.push({ bytes: Buffer.from(line), cursor });
      else this.checkpointOffset = cursor.endOffset;
      lineStart = index + 1;
    }
    this.partial = Buffer.from(combined.subarray(lineStart));
    this.partialStartOffset = combinedStart + lineStart;
  }

  private async deliverPending(): Promise<void> {
    while (this.running && this.pending.length > 0) {
      const pending = this.pending[0]!;
      let record: unknown;
      try {
        record = JSON.parse(pending.bytes.toString('utf8'));
      } catch (cause) {
        this.report(new ClaudeTranscriptParseError(pending.cursor, { cause }));
        this.pending.shift();
        this.checkpointOffset = pending.cursor.endOffset;
        await this.options.onCheckpoint?.(pending.cursor);
        continue;
      }

      // Parse once, drive both the stateless normalizer (chat/history stream)
      // and the stateful observed-input adapter (delivery-proof stream). The
      // adapter must see EVERY record so its remove-op ring stays current.
      const events = normalizeClaudeTranscriptRecord(record);
      // Run the STATEFUL adapter exactly once per record and memoize the result.
      // Observing a busy drain SPLICES the paired queue-operation/remove
      // timestamp out of a bounded ring; if a delivery-callback failure below
      // leaves this record pending and a later pass re-observed it, the ring
      // would already be drained and observedAt would fall back to the (much
      // later) wall clock — silently back-dating an in-window proof so a send
      // that WAS delivered gets classified UNACCOUNTED. Memoizing pins the real
      // consumption time across every retry; the stateless normalizer above is
      // safe to recompute.
      if (pending.observed === undefined) {
        pending.observed = this.observedInput.observe(record, pending.cursor, new Date().toISOString());
      }
      const observed = pending.observed;

      try {
        if (events.length > 0) await this.options.onEvents(events, pending.cursor);
        if (observed.length > 0) await this.options.onObservedInput?.(observed, pending.cursor);
        this.pending.shift();
        this.checkpointOffset = pending.cursor.endOffset;
        await this.options.onCheckpoint?.(pending.cursor);
      } catch (error) {
        // Propagate a delivery-callback failure so the whole reconcile pass fails:
        // the loop reports it once and any flush barrier for this pass REJECTS
        // instead of fulfilling before this record is delivered. A pre-shift
        // failure (onEvents/onObservedInput) leaves the record pending so the
        // next pass retries it exactly once. Parse errors above are a SKIP, not a
        // failure, and still advance the cursor.
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }
}

export async function startClaudeTranscriptWatcher(
  options: ClaudeTranscriptWatcherOptions,
): Promise<ClaudeTranscriptWatcher> {
  return await new ClaudeTranscriptWatcher(options).start();
}
