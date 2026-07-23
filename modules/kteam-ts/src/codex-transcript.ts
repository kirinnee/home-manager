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
    await this.requestReconcile(true);
    return this;
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
          try {
            await this.reconcile();
          } catch (error) {
            this.report(error);
          }
        }
      })().finally(() => {
        this.reconcilePromise = undefined;
        if (this.running && this.reconcileRequested) void this.requestReconcile();
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
    if (!(await this.deliverPending())) return;
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

  private async deliverPending(): Promise<boolean> {
    while (this.running && this.pending.length > 0) {
      const pending = this.pending[0]!;
      let events: CodexNormalizedEvent[];
      try {
        events = parseCodexTranscriptLine(pending.bytes.toString('utf8'), {
          sessionId: this.options.sessionId ?? sessionIdFromFilename(this.transcriptFile),
          includeDiagnostics: this.options.includeDiagnostics,
        });
      } catch (cause) {
        this.report(new CodexTranscriptParseError(pending.cursor, { cause }));
        this.pending.shift();
        this.checkpointOffset = pending.cursor.endOffset;
        await this.options.onCheckpoint?.(pending.cursor);
        continue;
      }

      try {
        if (events.length > 0) await this.options.onEvents(events, pending.cursor);
        this.pending.shift();
        this.checkpointOffset = pending.cursor.endOffset;
        await this.options.onCheckpoint?.(pending.cursor);
      } catch (error) {
        this.report(error);
        return false;
      }
    }
    return true;
  }
}

export async function startCodexTranscriptWatcher(
  options: CodexTranscriptWatcherOptions,
): Promise<CodexTranscriptWatcher> {
  return await new CodexTranscriptWatcher(options).start();
}
