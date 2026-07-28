import { open, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { ClaudeQuestion } from './claude-transcript';
import {
  nativeTranscriptWatchBackend,
  type TranscriptCursor,
  type TranscriptWatchBackend,
  type TranscriptWatchEvent,
  type TranscriptWatchHandle,
} from './claude-transcript';
import { CODEX_INPUT_SHAPE_VERSION, type ObservedHumanInput } from './observed-human-input';

type MaybePromise<T> = T | Promise<T>;

interface CodexEventMetadata {
  source: 'codex';
  timestamp?: string;
  sessionId?: string;
  recordType?: string;
  itemType?: string;
  itemId?: string;
  phase?: string;
  blockIndex?: number;
}

export type CodexNormalizedEvent =
  | (CodexEventMetadata & { type: 'chat.user'; data: { text: string } })
  | (CodexEventMetadata & { type: 'chat.assistant.text'; data: { text: string } })
  | (CodexEventMetadata & { type: 'chat.assistant.reasoning'; data: { reasoning: string } })
  | (CodexEventMetadata & { type: 'tool.use'; data: { toolUseId: string; name: string; input: unknown } })
  | (CodexEventMetadata & {
      type: 'tool.result';
      data: { toolUseId: string; content: unknown; text?: string; isError: boolean };
    })
  | (CodexEventMetadata & {
      type: 'interaction.question';
      data: { toolUseId: string; questions: ClaudeQuestion[] };
    })
  | (CodexEventMetadata & {
      type: 'codex.diagnostic';
      data: { recordType: string; itemType?: string; status?: string };
    })
  | (CodexEventMetadata & {
      type: 'turn.started' | 'turn.completed' | 'turn.aborted';
      data: { turnId?: string };
    })
  | (CodexEventMetadata & {
      /** From token_count events: last request's prompt+output size and the
       *  model's actual context window (codex reports it directly). */
      type: 'context.usage';
      data: { contextTokens: number; contextWindow?: number };
    })
  | (CodexEventMetadata & {
      /** Exact live settings emitted by Codex after its native model/reasoning
       * picker (and again at turn setup). */
      type: 'runtime.settings';
      data: { model?: string; reasoningEffort?: string };
    });

export interface CodexNormalizationOptions {
  /** Attach the known Codex thread/session ID to records that omit it. */
  sessionId?: string;
  /** Emit metadata-only events for records that are not chat, reasoning, or tools. */
  includeDiagnostics?: boolean;
}

export interface CodexTranscriptWatcherOptions extends CodexNormalizationOptions {
  /** Exact rollout JSONL pathname. The watcher never selects a sibling rollout. */
  transcriptFile: string;
  onEvents(events: readonly CodexNormalizedEvent[], cursor: TranscriptCursor): MaybePromise<void>;
  /** Delivery-proof candidates, on a channel SEPARATE from `onEvents` so the
   *  chat/history stream is unchanged. Each raw record is fed to a stateful
   *  {@link CodexObservedInputAdapter}; consumers reconcile these against their
   *  durable send records without ever treating arbitrary `chat.user` as proof. */
  onObservedInput?(inputs: readonly ObservedHumanInput[], cursor: TranscriptCursor): MaybePromise<void>;
  onCheckpoint?(cursor: TranscriptCursor): MaybePromise<void>;
  onDiscovered?(file: string): MaybePromise<void>;
  onError?(error: Error): void;
  /** Safety net for dropped/coalesced native notifications. Defaults to 2 seconds. */
  reconcileIntervalMs?: number;
  /** A previously persisted complete-line byte cursor. */
  initialOffset?: number;
  watchBackend?: TranscriptWatchBackend;
}

export interface CodexTranscriptWatcherSnapshot {
  running: boolean;
  file: string;
  inode?: string;
  present: boolean;
  readOffset: number;
  checkpointOffset: number;
  partialBytes: number;
  queuedRecords: number;
}

interface PendingRecord {
  bytes: Buffer<ArrayBufferLike>;
  cursor: TranscriptCursor;
  /** Observed-input candidates memoized the first time this record reached the
   *  queue head. Codex's adapter is stateless, but observing still resolves a
   *  fallback `observedAt` from the read wall clock for a timestamp-less record;
   *  memoizing keeps a delivery-callback retry from re-resolving that fallback to
   *  a later time, and holds parity with the Claude watcher's remove-ring fix.
   *  Undefined until first observed. */
  observed?: readonly ObservedHumanInput[];
}

interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

const READ_CHUNK_BYTES = 64 * 1024;
const ANCHOR_BYTES = 512;
const UUID_AT_END = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\.jsonl)?$/i;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function textFromValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) {
    const item = object(value);
    return string(item?.text) ?? string(item?.output_text);
  }
  const texts = value.flatMap(item => {
    if (typeof item === 'string') return [item];
    const block = object(item);
    const text = string(block?.text) ?? string(block?.output_text);
    return text === undefined ? [] : [text];
  });
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function sessionIdFromFilename(file: string): string | undefined {
  return path.basename(file).match(UUID_AT_END)?.[1];
}

function metadata(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  options: CodexNormalizationOptions,
  blockIndex?: number,
): CodexEventMetadata {
  const recordType = string(record.type);
  const itemType = string(payload.type);
  return {
    source: 'codex',
    timestamp: string(record.timestamp),
    sessionId:
      string(payload.session_id) ??
      (recordType === 'session_meta' ? string(payload.id) : undefined) ??
      options.sessionId,
    recordType,
    itemType,
    itemId: string(payload.id),
    phase: string(payload.phase),
    blockIndex,
  };
}

function toolInput(payload: Record<string, unknown>): unknown {
  if ('arguments' in payload) return parseArguments(payload.arguments);
  if ('input' in payload) return payload.input;
  if ('action' in payload) return payload.action;
  if ('execution' in payload) return { execution: payload.execution };
  return {};
}

function toolName(itemType: string, payload: Record<string, unknown>): string {
  return string(payload.name) ?? itemType.replace(/_call$/, '');
}

function toolId(payload: Record<string, unknown>): string | undefined {
  return string(payload.call_id) ?? string(payload.id);
}

function isToolCall(itemType: string): boolean {
  return itemType.endsWith('_call') && !itemType.endsWith('_call_output');
}

function isToolOutput(itemType: string): boolean {
  return itemType.endsWith('_call_output') || itemType.endsWith('_output');
}

function toolFailed(payload: Record<string, unknown>): boolean {
  const status = string(payload.status)?.toLowerCase();
  return (
    payload.is_error === true ||
    payload.isError === true ||
    payload.success === false ||
    status === 'failed' ||
    status === 'error' ||
    status === 'cancelled'
  );
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
          return option && typeof option.label === 'string'
            ? [{ label: option.label, description: string(option.description) }]
            : [];
        })
      : [];
    return [
      {
        question: question.question,
        header: string(question.header),
        options,
        multiSelect: question.multiSelect === true || question.multi_select === true,
      },
    ];
  });
}

function diagnostic(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  options: CodexNormalizationOptions,
): CodexNormalizedEvent[] {
  if (!options.includeDiagnostics) return [];
  const recordType = string(record.type) ?? 'unknown';
  const itemType = string(payload.type);
  const status = string(payload.status);
  return [
    {
      ...metadata(record, payload, options),
      type: 'codex.diagnostic',
      data: {
        recordType,
        ...(itemType === undefined ? {} : { itemType }),
        ...(status === undefined ? {} : { status }),
      },
    },
  ];
}

/**
 * Normalize one parsed Codex rollout record.
 *
 * `response_item` is the canonical source for chat and tools. Codex also writes
 * mirrored `event_msg.user_message` and `event_msg.agent_message` records; they
 * are deliberately ignored so a streamed conversation does not contain every
 * message twice. `event_msg.agent_reasoning` remains useful because older
 * rollouts only expose readable reasoning there.
 */
export function normalizeCodexTranscriptRecord(
  value: unknown,
  options: CodexNormalizationOptions = {},
): CodexNormalizedEvent[] {
  const record = object(value);
  if (!record) return [];
  const payload = object(record.payload) ?? {};
  const recordType = string(record.type);
  const itemType = string(payload.type);

  // OBSERVED in Codex 0.145.0: the native picker writes an event_msg with a
  // nested thread_settings object carrying both exact values. turn_context is
  // a second authoritative source at the next turn boundary and makes state
  // recoverable when the local picker event predates watcher attachment.
  if ((recordType === 'event_msg' && itemType === 'thread_settings_applied') || recordType === 'turn_context') {
    const settings =
      recordType === 'turn_context' ? payload : (object(payload.thread_settings) ?? object(record.thread_settings));
    const model = string(settings?.model);
    const reasoningEffort = string(settings?.reasoning_effort) ?? string(settings?.effort);
    if (model !== undefined || reasoningEffort !== undefined) {
      return [
        {
          ...metadata(record, payload, options),
          type: 'runtime.settings',
          data: {
            ...(model !== undefined ? { model } : {}),
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          },
        },
      ];
    }
    return diagnostic(record, payload, options);
  }

  if (recordType === 'event_msg' && itemType && ['task_started', 'task_complete', 'turn_aborted'].includes(itemType)) {
    const type =
      itemType === 'task_started' ? 'turn.started' : itemType === 'task_complete' ? 'turn.completed' : 'turn.aborted';
    const turnId = string(payload.turn_id);
    return [
      {
        ...metadata(record, payload, options),
        type,
        data: { ...(turnId === undefined ? {} : { turnId }) },
      },
    ];
  }

  if (recordType === 'event_msg' && itemType === 'agent_reasoning') {
    const reasoning = string(payload.text);
    return reasoning === undefined
      ? diagnostic(record, payload, options)
      : [{ ...metadata(record, payload, options), type: 'chat.assistant.reasoning', data: { reasoning } }];
  }

  // Context accounting from the rollout's own token_count events: the last
  // request's prompt size plus the model's actual context window — the ground
  // truth the pane statusline only approximates (turn-020).
  if (recordType === 'event_msg' && itemType === 'token_count') {
    const info = object(payload.info);
    const last = object(info?.last_token_usage);
    const contextTokens =
      (typeof last?.input_tokens === 'number' ? last.input_tokens : 0) +
      (typeof last?.output_tokens === 'number' ? last.output_tokens : 0);
    const contextWindow = typeof info?.model_context_window === 'number' ? info.model_context_window : undefined;
    if (contextTokens > 0) {
      return [
        {
          ...metadata(record, payload, options),
          type: 'context.usage',
          data: { contextTokens, ...(contextWindow !== undefined ? { contextWindow } : {}) },
        },
      ];
    }
    return diagnostic(record, payload, options);
  }

  if (recordType !== 'response_item' || !itemType) return diagnostic(record, payload, options);

  if (itemType === 'message') {
    const role = string(payload.role);
    if (role !== 'user' && role !== 'assistant') return diagnostic(record, payload, options);
    const content = Array.isArray(payload.content) ? payload.content : [payload.content];
    const events: CodexNormalizedEvent[] = [];
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const blockValue = content[blockIndex];
      const block = object(blockValue);
      const blockType = string(block?.type);
      const text = typeof blockValue === 'string' ? blockValue : (string(block?.text) ?? string(block?.output_text));
      if (text === undefined) continue;
      const eventMetadata = metadata(record, payload, options, blockIndex);
      if (role === 'user' && (blockType === undefined || blockType === 'input_text')) {
        events.push({ ...eventMetadata, type: 'chat.user', data: { text } });
      }
      if (role === 'assistant' && (blockType === undefined || blockType === 'output_text')) {
        events.push({ ...eventMetadata, type: 'chat.assistant.text', data: { text } });
      }
    }
    return events.length > 0 ? events : diagnostic(record, payload, options);
  }

  if (itemType === 'reasoning') {
    const summary = Array.isArray(payload.summary) ? payload.summary : [];
    const content = Array.isArray(payload.content) ? payload.content : [];
    const reasoning = textFromValue([...summary, ...content]);
    return reasoning === undefined
      ? diagnostic(record, payload, options)
      : [{ ...metadata(record, payload, options), type: 'chat.assistant.reasoning', data: { reasoning } }];
  }

  if (isToolCall(itemType)) {
    const toolUseId = toolId(payload);
    if (!toolUseId) return diagnostic(record, payload, options);
    const name = toolName(itemType, payload);
    const input = toolInput(payload);
    const events: CodexNormalizedEvent[] = [
      {
        ...metadata(record, payload, options),
        type: 'tool.use',
        data: { toolUseId, name, input },
      },
    ];
    if (/^(request_user_input|askuserquestion)$/i.test(name)) {
      events.push({
        ...metadata(record, payload, options),
        type: 'interaction.question',
        data: { toolUseId, questions: normalizeQuestions(input) },
      });
    }
    return events;
  }

  if (isToolOutput(itemType)) {
    const toolUseId = toolId(payload);
    if (!toolUseId) return diagnostic(record, payload, options);
    const content = payload.output ?? payload.result ?? payload.tools;
    const text = textFromValue(content);
    return [
      {
        ...metadata(record, payload, options),
        type: 'tool.result',
        data: {
          toolUseId,
          content,
          ...(text === undefined ? {} : { text }),
          isError: toolFailed(payload),
        },
      },
    ];
  }

  return diagnostic(record, payload, options);
}

/** Parse and normalize one complete Codex rollout JSONL line. */
export function parseCodexTranscriptLine(
  line: string,
  options: CodexNormalizationOptions = {},
): CodexNormalizedEvent[] {
  return normalizeCodexTranscriptRecord(JSON.parse(line) as unknown, options);
}

/**
 * The initial session/environment preamble Codex writes as the first user
 * record of a rollout (AGENTS.md + environment block). It is structurally
 * identifiable by its wrapping tags, so it is excluded from observed-input
 * candidates. Downstream exact-content matching is still the real safety
 * boundary; this only stops a future accidental substring rule from reaching it.
 */
function isCodexPreamble(text: string): boolean {
  const head = text.trimStart();
  return (
    head.startsWith('<environment_context>') ||
    head.startsWith('<user_instructions>') ||
    head.startsWith('<user_environment>')
  );
}

/**
 * Stateless producer of {@link ObservedHumanInput} candidates from raw Codex
 * rollout records. Codex has no busy-queue shape, so — unlike Claude — no
 * cross-record state is needed.
 *
 * Only the canonical `response_item/message/role:user` record (with
 * `input_text`, or a bare string block) is delivery proof. The mirrored
 * `event_msg/user_message` record is deliberately never a candidate: it would
 * double-count the same delivery. Feed every raw record through {@link observe}.
 */
export class CodexObservedInputAdapter {
  /** Codex needs no buffered state; provided for interface parity with Claude. */
  reset(): void {}

  /**
   * Inspect one raw Codex record and return zero or one observed-human-input
   * candidate.
   *
   * @param value              the parsed raw record
   * @param cursor             the record's byte cursor (for the fallback proof key)
   * @param observedAtFallback the watcher's read wall-clock, used as `observedAt`
   *                           only when the record carries no timestamp
   */
  observe(value: unknown, cursor: TranscriptCursor, observedAtFallback: string): ObservedHumanInput[] {
    const record = object(value);
    if (!record) return [];
    const recordType = string(record.type);
    const payload = object(record.payload) ?? {};
    const itemType = string(payload.type);

    // The event_msg/user_message mirror is never proof: the canonical
    // response_item below is the single source. Emitting here would count one
    // delivery twice.
    if (recordType === 'event_msg' && itemType === 'user_message') return [];

    if (recordType !== 'response_item' || itemType !== 'message') return [];
    if (string(payload.role) !== 'user') return [];

    const content = Array.isArray(payload.content) ? payload.content : [payload.content];
    const texts: string[] = [];
    for (const blockValue of content) {
      if (typeof blockValue === 'string') {
        texts.push(blockValue);
        continue;
      }
      const block = object(blockValue);
      const blockType = string(block?.type);
      const text = string(block?.text) ?? string(block?.output_text);
      if (text !== undefined && (blockType === undefined || blockType === 'input_text')) texts.push(text);
    }
    const text = texts.join('\n');
    if (!text.trim() || isCodexPreamble(text)) return [];

    return [
      {
        harness: 'codex',
        text,
        proof: 'normal-user-record',
        observedAt: string(record.timestamp) ?? observedAtFallback,
        proofKey: string(payload.id) ?? `${cursor.file}#${cursor.startOffset}#${cursor.endOffset}`,
        shapeVersion: CODEX_INPUT_SHAPE_VERSION,
      },
    ];
  }
}

export class CodexTranscriptParseError extends Error {
  constructor(
    public readonly cursor: TranscriptCursor,
    options?: ErrorOptions,
  ) {
    super(`invalid Codex transcript JSONL record at byte ${cursor.startOffset}`, options);
    this.name = 'CodexTranscriptParseError';
  }
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

export class CodexTranscriptWatcher {
  private readonly options: CodexTranscriptWatcherOptions;
  private readonly backend: TranscriptWatchBackend;
  private readonly transcriptFile: string;
  private readonly observedInput = new CodexObservedInputAdapter();
  private directoryWatch?: TranscriptWatchHandle;
  private watchedDirectory?: string;
  private fileWatch?: TranscriptWatchHandle;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private present = false;
  private discovered = false;
  private fileIdentity?: FileIdentity;
  private readOffset = 0;
  private checkpointOffset = 0;
  private partial: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private partialStartOffset = 0;
  private anchor: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private pending: PendingRecord[] = [];
  private pendingReplacement?: { identity: FileIdentity; firstSeenAt: number };
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

  constructor(options: CodexTranscriptWatcherOptions) {
    if (!options.transcriptFile.trim()) throw new Error('Codex transcriptFile is required');
    this.options = options;
    this.backend = options.watchBackend ?? nativeTranscriptWatchBackend;
    this.transcriptFile = path.resolve(options.transcriptFile);
  }

  async start(): Promise<this> {
    if (this.running) return this;
    this.running = true;
    const interval = Math.max(10, this.options.reconcileIntervalMs ?? 2_000);
    this.timer = setInterval(() => void this.requestReconcile(true), interval);
    this.timer.unref?.();
    // ONE pass, not the drain loop — see the same note in claude-transcript.ts.
    // The start barrier is nonthrowing: a transient first-pass error must not
    // fail watcher construction — the periodic loop recovers and onError still fires.
    const first = this.nextPass(false);
    void this.requestReconcile(true);
    await first;
    return this;
  }

  /**
   * Run one bounded reconcile pass to EOF and resolve once it has completed.
   *
   * Guarantees every rollout byte written before the call is parsed and
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
    this.directoryWatch?.close();
    this.directoryWatch = undefined;
    this.releasePassWaiters();
    await this.reconcilePromise;
  }

  snapshot(): CodexTranscriptWatcherSnapshot {
    return {
      running: this.running,
      file: this.transcriptFile,
      inode: identityString(this.fileIdentity),
      present: this.present,
      readOffset: this.readOffset,
      checkpointOffset: this.checkpointOffset,
      partialBytes: this.partial.length,
      queuedRecords: this.pending.length,
    };
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  private requestReconcile(refreshDirectory = false): Promise<void> {
    if (!this.running) return Promise.resolve();
    this.reconcileRequested = true;
    this.directoryRefreshRequested ||= refreshDirectory;
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

  private async refreshDirectoryWatch(): Promise<void> {
    const desired = await nearestExistingDirectory(path.dirname(this.transcriptFile));
    if (desired === this.watchedDirectory && this.directoryWatch) return;
    this.directoryWatch?.close();
    this.directoryWatch = undefined;
    this.watchedDirectory = desired;
    if (desired) this.directoryWatch = this.makeWatch(desired);
  }

  private async reconcile(): Promise<void> {
    if (this.directoryRefreshRequested) {
      this.directoryRefreshRequested = false;
      await this.refreshDirectoryWatch();
    }

    const info = await stat(this.transcriptFile, { bigint: false }).catch((): undefined => undefined);
    if (!info?.isFile()) {
      this.present = false;
      this.fileWatch?.close();
      this.fileWatch = undefined;
      return;
    }

    this.present = true;
    if (!(await this.selectFile(info))) return;
    // Drain what is already queued before reading more; a delivery-callback
    // failure throws out of the whole pass (fails the flush barrier) rather than
    // silently reading on past an undelivered record.
    await this.deliverPending();
    await this.readAvailable();
    await this.deliverPending();
  }

  private async selectFile(info: Stats): Promise<boolean> {
    const nextIdentity = identityOf(info);
    const firstDiscovery = !this.discovered;
    const changed = !sameIdentity(this.fileIdentity, nextIdentity);

    if (firstDiscovery) {
      const requested = Math.max(0, this.options.initialOffset ?? 0);
      this.readOffset = requested <= info.size ? requested : 0;
      this.checkpointOffset = this.readOffset;
      this.partialStartOffset = this.readOffset;
      this.anchor = await this.readAnchor(this.readOffset);
    } else {
      const cursorMatches = await this.cursorStillMatches(info.size);
      if (!cursorMatches && changed && info.size < this.readOffset) {
        const pending = this.pendingReplacement;
        if (!pending || !sameIdentity(pending.identity, nextIdentity)) {
          this.pendingReplacement = { identity: nextIdentity, firstSeenAt: Date.now() };
          return false;
        }
        const interval = Math.max(10, this.options.reconcileIntervalMs ?? 2_000);
        const graceMs = Math.max(50, Math.min(500, interval * 2));
        if (Date.now() - pending.firstSeenAt < graceMs) return false;
      }
      this.pendingReplacement = undefined;
      if (!cursorMatches) this.resetCursor();
    }

    if (changed || !this.fileWatch) {
      this.fileWatch?.close();
      this.fileWatch = this.makeWatch(this.transcriptFile);
      this.fileIdentity = nextIdentity;
    }
    if (firstDiscovery) {
      this.discovered = true;
      await this.options.onDiscovered?.(this.transcriptFile);
    }
    return true;
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

  private async cursorStillMatches(size: number): Promise<boolean> {
    if (this.readOffset === 0) return true;
    if (size < this.readOffset || this.anchor.length === 0) return false;
    return (await this.readAnchor(this.readOffset)).equals(this.anchor);
  }

  private async readAnchor(offset: number): Promise<Buffer<ArrayBufferLike>> {
    const length = Math.min(ANCHOR_BYTES, offset);
    if (length === 0) return Buffer.alloc(0);
    const handle = await open(this.transcriptFile, 'r');
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
    const handle = await open(this.transcriptFile, 'r');
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
        file: this.transcriptFile,
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
        this.report(new CodexTranscriptParseError(pending.cursor, { cause }));
        this.pending.shift();
        this.checkpointOffset = pending.cursor.endOffset;
        await this.options.onCheckpoint?.(pending.cursor);
        continue;
      }

      // Parse once, drive both the stateless normalizer (chat/history stream)
      // and the observed-input adapter (delivery-proof stream).
      const events = normalizeCodexTranscriptRecord(record, {
        sessionId: this.options.sessionId ?? sessionIdFromFilename(this.transcriptFile),
        includeDiagnostics: this.options.includeDiagnostics,
      });
      // Observe exactly once per record and memoize: a delivery-callback retry
      // must not re-resolve a timestamp-less record's fallback observedAt to a
      // later wall clock (parity with the Claude watcher's remove-ring fix).
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

export async function startCodexTranscriptWatcher(
  options: CodexTranscriptWatcherOptions,
): Promise<CodexTranscriptWatcher> {
  return await new CodexTranscriptWatcher(options).start();
}
