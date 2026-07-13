import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

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
  | (ClaudeEventMetadata & { type: 'chat.user'; data: { text: string } })
  | (ClaudeEventMetadata & { type: 'chat.assistant.text'; data: { text: string } })
  | (ClaudeEventMetadata & { type: 'chat.assistant.thinking'; data: { thinking: string } })
  | (ClaudeEventMetadata & { type: 'tool.use'; data: { toolUseId: string; name: string; input: unknown } })
  | (ClaudeEventMetadata & {
      type: 'tool.result';
      data: { toolUseId: string; content: unknown; text?: string; isError: boolean };
    })
  | (ClaudeEventMetadata & { type: 'interaction.question'; data: { toolUseId: string; questions: ClaudeQuestion[] } })
  | (ClaudeEventMetadata & { type: 'turn.completed'; data: Record<string, never> });

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
  onCheckpoint?(cursor: TranscriptCursor): MaybePromise<void>;
  onDiscovered?(file: string): MaybePromise<void>;
  onError?(error: Error): void;
  /** Safety net for dropped/coalesced native notifications. Defaults to 2 seconds. */
  reconcileIntervalMs?: number;
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

  return events;
}

/** Parse and normalize one complete JSONL line. */
export function parseClaudeTranscriptLine(line: string): ClaudeNormalizedEvent[] {
  return normalizeClaudeTranscriptRecord(JSON.parse(line) as unknown);
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

  constructor(options: ClaudeTranscriptWatcherOptions) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.sessionId)) {
      throw new Error('Claude transcript sessionId must be a UUID');
    }
    this.options = options;
    this.backend = options.watchBackend ?? nativeTranscriptWatchBackend;
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
    for (const watcher of this.directoryWatches.values()) watcher.close();
    this.directoryWatches.clear();
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

  private async refreshDirectoryWatches(): Promise<void> {
    const rootDirectories = await directoriesBelow(this.options.transcriptRoot);
    const directories =
      rootDirectories.length > 0
        ? rootDirectories
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
    const refreshDirectories = this.directoryRefreshRequested;
    this.directoryRefreshRequested = false;
    if (refreshDirectories) await this.refreshDirectoryWatches();

    let file = this.transcriptFile;
    if (
      !file ||
      refreshDirectories ||
      !(await stat(file)
        .then(info => info.isFile())
        .catch(() => false))
    ) {
      file = await findClaudeTranscript(this.options.transcriptRoot, this.options.sessionId);
    }
    if (!file) {
      this.detachFile();
      return;
    }

    await this.selectFile(file);
    if (!(await this.deliverPending())) return;
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

  private async deliverPending(): Promise<boolean> {
    while (this.running && this.pending.length > 0) {
      const pending = this.pending[0]!;
      let events: ClaudeNormalizedEvent[];
      try {
        events = parseClaudeTranscriptLine(pending.bytes.toString('utf8'));
      } catch (cause) {
        this.report(new ClaudeTranscriptParseError(pending.cursor, { cause }));
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

export async function startClaudeTranscriptWatcher(
  options: ClaudeTranscriptWatcherOptions,
): Promise<ClaudeTranscriptWatcher> {
  return await new ClaudeTranscriptWatcher(options).start();
}
